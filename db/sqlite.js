'use strict';
/**
 * db/sqlite.js — Capa de base de datos SQLite (reemplaza Firebase Firestore)
 *
 * Usa better-sqlite3 (síncrono).
 * Los campos JSON se almacenan como TEXT y se serializan/deserializan aquí.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { clearCache } = require('../utils/cache');

const DB_PATH = path.join(__dirname, '..', 'macstore.db');

let _db;

function getDB() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/* ── Helpers JSON ──────────────────────────────────────────────────── */
const j  = v => JSON.stringify(v ?? null);
const p  = (v, def) => { try { return v != null ? JSON.parse(v) : def; } catch { return def; } };

/* ── Campos JSON por tabla ─────────────────────────────────────────── */
const JSON_FIELDS = {
  products:          ['color_variants','variants','logos','specs','ficha'],
  quotations:        ['items','settings','options','paymentMethods'],
  inventory_entries: ['items'],
  ramiro_memory:     ['patterns','preferences'],
};

function serializeRow(table, data) {
  const row = { ...data };
  (JSON_FIELDS[table] || []).forEach(f => {
    if (f in row) row[f] = j(row[f]);
  });
  return row;
}

function deserializeRow(table, row) {
  if (!row) return null;
  const out = { ...row };
  (JSON_FIELDS[table] || []).forEach(f => {
    if (f in out) out[f] = p(out[f], Array.isArray(out[f]) ? [] : {});
  });
  // Mapear id integer → string para compatibilidad con el frontend
  if (out.id != null) out.id = String(out.id);
  return out;
}

function deserializeRows(table, rows) {
  return rows.map(r => deserializeRow(table, r));
}

/* ── CRUD genérico ─────────────────────────────────────────────────── */

function dbAll(sql, params = []) {
  return getDB().prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  return getDB().prepare(sql).get(...params);
}

function dbRun(sql, params = []) {
  return getDB().prepare(sql).run(...params);
}

/* ── SETTINGS (documento único JSON) ──────────────────────────────── */

function getSettings() {
  const row = dbGet('SELECT data FROM settings WHERE id = 1');
  return row ? p(row.data, {}) : {};
}

function setSettings(updates) {
  const current = getSettings();
  const merged  = { ...current, ...updates };
  dbRun('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)', [j(merged)]);
  clearCache('settings');
}

/* ── PRODUCTS ──────────────────────────────────────────────────────── */

function getAllProducts(opts = {}) {
  let sql    = 'SELECT * FROM products';
  const conds = [], params = [];
  if (opts.active !== undefined) { conds.push('active = ?'); params.push(opts.active ? 1 : 0); }
  if (opts.category)             { conds.push('category = ?'); params.push(opts.category); }
  if (opts.slug)                 { conds.push('slug = ?'); params.push(opts.slug); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY sort_order ASC, id ASC';
  if (opts.limit) sql += ` LIMIT ${parseInt(opts.limit)}`;
  return deserializeRows('products', dbAll(sql, params));
}

function getProductById(id) {
  const row = dbGet('SELECT * FROM products WHERE id = ?', [id]);
  return deserializeRow('products', row);
}

function getProductBySlug(slug) {
  const row = dbGet('SELECT * FROM products WHERE slug = ?', [slug]);
  return deserializeRow('products', row);
}

function insertProduct(data) {
  const row   = serializeRow('products', data);
  const now   = new Date().toISOString();
  const cols  = Object.keys(row);
  if (!cols.includes('createdAt')) { row.createdAt = now; cols.push('createdAt'); }
  const sql   = `INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`;
  const result = dbRun(sql, cols.map(c => row[c]));
  clearCache();
  return { id: String(result.lastInsertRowid) };
}

function updateProduct(id, data) {
  const row  = serializeRow('products', data);
  row.updatedAt = new Date().toISOString();
  const sets = Object.keys(row).map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE products SET ${sets} WHERE id = ?`, [...Object.values(row), id]);
  clearCache();
}

function deleteProduct(id) {
  dbRun('DELETE FROM products WHERE id = ?', [id]);
  clearCache();
}

/* ── CATEGORIES ────────────────────────────────────────────────────── */

function getAllCategories(opts = {}) {
  let sql = 'SELECT * FROM categories';
  const conds = [], params = [];
  if (opts.active !== undefined) { conds.push('active = ?'); params.push(opts.active ? 1 : 0); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY sort_order ASC, id ASC';
  return dbAll(sql, params).map(r => ({
    ...r,
    id:     String(r.id),
    active: r.active !== 0,
    share_whatsapp: r.share_whatsapp !== 0,
    force_show: r.force_show !== 0,
  }));
}

function getCategoryById(id) {
  const r = dbGet('SELECT * FROM categories WHERE id = ?', [id]);
  if (!r) return null;
  return { ...r, id: String(r.id), active: r.active !== 0, share_whatsapp: r.share_whatsapp !== 0, force_show: r.force_show !== 0 };
}

function insertCategory(data) {
  const { name, slug, description, sort_order, bg_color, image_url } = data;
  const result = dbRun(
    'INSERT INTO categories (name,slug,description,sort_order,bg_color,image_url,active,createdAt) VALUES (?,?,?,?,?,?,1,?)',
    [name, slug, description||'', sort_order||0, bg_color||'', image_url||'', new Date().toISOString()]
  );
  clearCache('categories');
  return { id: String(result.lastInsertRowid) };
}

function updateCategory(id, data) {
  const cols = Object.keys(data).filter(k => k !== 'id');
  const sets = cols.map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE categories SET ${sets} WHERE id = ?`, [...cols.map(k => data[k]), id]);
  clearCache('categories');
}

function deleteCategory(id) {
  dbRun('DELETE FROM categories WHERE id = ?', [id]);
  clearCache('categories');
}

/* ── BANNERS ───────────────────────────────────────────────────────── */

function getAllBanners(opts = {}) {
  let sql = 'SELECT * FROM banners';
  const conds = [], params = [];
  if (opts.active !== undefined) { conds.push('active = ?'); params.push(opts.active ? 1 : 0); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY sort_order ASC, id ASC';
  return dbAll(sql, params).map(r => ({ ...r, id: String(r.id), active: r.active !== 0 }));
}

function insertBanner(data) {
  const result = dbRun(
    'INSERT INTO banners (title,subtitle,cta_text,cta_url,image_url,bg_color,text_color,sort_order,active,createdAt) VALUES (?,?,?,?,?,?,?,?,1,?)',
    [data.title||'', data.subtitle||'', data.cta_text||'', data.cta_url||'', data.image_url||'', data.bg_color||'#1d1d1f', data.text_color||'#ffffff', data.sort_order||0, new Date().toISOString()]
  );
  clearCache('homeBanners');
  return { id: String(result.lastInsertRowid) };
}

function updateBanner(id, data) {
  const cols = Object.keys(data).filter(k => k !== 'id');
  const sets = cols.map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE banners SET ${sets}, updatedAt = ? WHERE id = ?`, [...cols.map(k => data[k]), new Date().toISOString(), id]);
  clearCache('homeBanners');
}

function deleteBanner(id) {
  dbRun('DELETE FROM banners WHERE id = ?', [id]);
  clearCache('homeBanners');
}

/* ── ANNOUNCEMENTS ─────────────────────────────────────────────────── */

function getAllAnnouncements(opts = {}) {
  let sql = 'SELECT * FROM announcements';
  const conds = [], params = [];
  if (opts.active !== undefined) { conds.push('active = ?'); params.push(opts.active ? 1 : 0); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY sort_order ASC, id ASC';
  return dbAll(sql, params).map(r => ({ ...r, id: String(r.id), active: r.active !== 0 }));
}

function insertAnnouncement(data) {
  const result = dbRun(
    'INSERT INTO announcements (title,link,image_url,sort_order,logo_height,active,createdAt) VALUES (?,?,?,?,?,1,?)',
    [data.title||'', data.link||'', data.image_url||'', data.sort_order||0, data.logo_height||64, new Date().toISOString()]
  );
  clearCache('announcements');
  return { id: String(result.lastInsertRowid) };
}

function updateAnnouncement(id, data) {
  const cols = Object.keys(data).filter(k => k !== 'id');
  const sets = cols.map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE announcements SET ${sets}, updatedAt = ? WHERE id = ?`, [...cols.map(k => data[k]), new Date().toISOString(), id]);
  clearCache('announcements');
}

function deleteAnnouncement(id) {
  dbRun('DELETE FROM announcements WHERE id = ?', [id]);
  clearCache('announcements');
}

/* ── PAYMENT METHODS ───────────────────────────────────────────────── */

function getAllPaymentMethods() {
  return dbAll('SELECT * FROM payment_methods ORDER BY sort_order ASC').map(r => ({
    ...r, id: String(r.id), active: r.active !== 0
  }));
}

function insertPaymentMethod(data) {
  const result = dbRun(
    'INSERT INTO payment_methods (name,description,logo_url,sort_order,active,createdAt) VALUES (?,?,?,?,1,?)',
    [data.name, data.description||'', data.logo_url||'', data.sort_order||0, new Date().toISOString()]
  );
  return { id: String(result.lastInsertRowid) };
}

function updatePaymentMethod(id, data) {
  const cols = Object.keys(data).filter(k => k !== 'id');
  const sets = cols.map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE payment_methods SET ${sets} WHERE id = ?`, [...cols.map(k => data[k]), id]);
}

function deletePaymentMethod(id) {
  dbRun('DELETE FROM payment_methods WHERE id = ?', [id]);
}

/* ── QUOTATIONS ────────────────────────────────────────────────────── */

function getAllQuotations(limit = 500) {
  const rows = dbAll(`SELECT * FROM quotations ORDER BY createdAt DESC LIMIT ${limit}`);
  return rows.map(r => ({
    ...deserializeRow('quotations', r),
    // Compat: toDate() → createdAt como Date
    createdAt: r.createdAt ? new Date(r.createdAt) : null,
  }));
}

function getQuotationById(id) {
  const row = dbGet('SELECT * FROM quotations WHERE id = ?', [id]);
  if (!row) return null;
  return { ...deserializeRow('quotations', row), createdAt: row.createdAt ? new Date(row.createdAt) : null };
}

function insertQuotation(data) {
  const row   = serializeRow('quotations', data);
  const now   = new Date().toISOString();
  const cols  = Object.keys(row);
  if (!cols.includes('createdAt')) { row.createdAt = now; cols.push('createdAt'); }
  const sql   = `INSERT INTO quotations (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`;
  const result = dbRun(sql, cols.map(c => row[c]));
  return { id: String(result.lastInsertRowid) };
}

function deleteQuotation(id) {
  dbRun('DELETE FROM quotations WHERE id = ?', [id]);
}

/* ── INVENTORY ENTRIES ─────────────────────────────────────────────── */

function getAllInventoryEntries(limit = 100) {
  const rows = dbAll(`SELECT * FROM inventory_entries ORDER BY createdAt DESC LIMIT ${limit}`);
  return rows.map(r => ({
    ...deserializeRow('inventory_entries', r),
    createdAt: r.createdAt ? new Date(r.createdAt) : null,
  }));
}

function getInventoryEntryById(id) {
  const row = dbGet('SELECT * FROM inventory_entries WHERE id = ?', [id]);
  if (!row) return null;
  return { ...deserializeRow('inventory_entries', row), createdAt: row.createdAt ? new Date(row.createdAt) : null };
}

function insertInventoryEntry(data) {
  const row  = serializeRow('inventory_entries', data);
  const now  = new Date().toISOString();
  row.status    = row.status    || 'normal';
  row.createdAt = row.createdAt || now;
  row.updatedAt = row.updatedAt || now;
  const cols = Object.keys(row);
  const sql  = `INSERT INTO inventory_entries (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`;
  const result = dbRun(sql, cols.map(c => row[c]));
  return { id: String(result.lastInsertRowid) };
}

function updateInventoryEntry(id, data) {
  const row  = serializeRow('inventory_entries', data);
  row.updatedAt = new Date().toISOString();
  const cols = Object.keys(row);
  const sets = cols.map(k => `${k} = ?`).join(', ');
  dbRun(`UPDATE inventory_entries SET ${sets} WHERE id = ?`, [...cols.map(c => row[c]), id]);
}

/* ── ADMINS ────────────────────────────────────────────────────────── */

function getAdminByEmail(email) {
  const row = dbGet('SELECT * FROM admins WHERE email = ?', [email]);
  return row ? { ...row, id: String(row.id) } : null;
}

function insertAdmin(data) {
  const result = dbRun(
    'INSERT INTO admins (email,password,name,createdAt) VALUES (?,?,?,?)',
    [data.email, data.password, data.name||'Administrador MacStore', new Date().toISOString()]
  );
  return { id: String(result.lastInsertRowid) };
}

/* ── RAMIRO MEMORY ─────────────────────────────────────────────────── */

// ── Page designs ──────────────────────────────────────────────────────────────
function getPageDesign(pageName) {
  return dbGet('SELECT * FROM page_designs WHERE page_name = ?', [pageName]);
}
function getAllPageDesigns() {
  try { return getDB().prepare('SELECT page_name, html, css, gjs_data FROM page_designs').all(); } catch { return []; }
}
function clearPageDesignHtml() {
  try { dbRun("UPDATE page_designs SET html = ''"); } catch(e) {}
}
function savePageDesign(pageName, html, css, gjsData) {
  const now = new Date().toISOString();
  const ex  = dbGet('SELECT id FROM page_designs WHERE page_name = ?', [pageName]);
  if (ex) {
    dbRun('UPDATE page_designs SET html=?, css=?, gjs_data=?, updatedAt=? WHERE page_name=?', [html, css, gjsData, now, pageName]);
  } else {
    dbRun('INSERT INTO page_designs (page_name,html,css,gjs_data,updatedAt) VALUES (?,?,?,?,?)', [pageName, html, css, gjsData, now]);
  }
}

function getRamiroMemory(userId = 'default') {
  const row = dbGet('SELECT * FROM ramiro_memory WHERE user_id = ?', [userId]);
  if (!row) return null;
  return deserializeRow('ramiro_memory', row);
}

function setRamiroMemory(userId = 'default', data) {
  const existing = getRamiroMemory(userId);
  const row      = serializeRow('ramiro_memory', data);
  if (existing) {
    const cols = Object.keys(row);
    const sets = cols.map(k => `${k} = ?`).join(', ');
    dbRun(`UPDATE ramiro_memory SET ${sets}, updatedAt = ? WHERE user_id = ?`,
      [...cols.map(c => row[c]), new Date().toISOString(), userId]);
  } else {
    row.user_id   = userId;
    row.createdAt = new Date().toISOString();
    row.updatedAt = new Date().toISOString();
    const cols = Object.keys(row);
    dbRun(`INSERT INTO ramiro_memory (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,
      cols.map(c => row[c]));
  }
}

/* ── RAMIRO TRANSCRIPTS ────────────────────────────────────────────── */

function getTranscripts(userId = 'default', limit = 20) {
  const rows = dbAll(
    'SELECT * FROM ramiro_transcripts WHERE user_id = ? ORDER BY createdAt DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({ ...r, id: String(r.id) }));
}

function insertTranscript(data) {
  const result = dbRun(
    'INSERT INTO ramiro_transcripts (user_id,role,content,createdAt) VALUES (?,?,?,?)',
    [data.userId||data.user_id||'default', data.role||'user', data.content||'', new Date().toISOString()]
  );
  return { id: String(result.lastInsertRowid) };
}

/* ── Exportar todo ─────────────────────────────────────────────────── */
module.exports = {
  getDB,
  // Settings
  getSettings, setSettings,
  // Products
  getAllProducts, getProductById, getProductBySlug, insertProduct, updateProduct, deleteProduct,
  // Categories
  getAllCategories, getCategoryById, insertCategory, updateCategory, deleteCategory,
  // Banners
  getAllBanners, insertBanner, updateBanner, deleteBanner,
  // Announcements
  getAllAnnouncements, insertAnnouncement, updateAnnouncement, deleteAnnouncement,
  // Payment methods
  getAllPaymentMethods, insertPaymentMethod, updatePaymentMethod, deletePaymentMethod,
  // Quotations
  getAllQuotations, getQuotationById, insertQuotation, deleteQuotation,
  // Inventory
  getAllInventoryEntries, getInventoryEntryById, insertInventoryEntry, updateInventoryEntry,
  // Admins
  getAdminByEmail, insertAdmin,
  // Page designs
  getPageDesign, getAllPageDesigns, savePageDesign, clearPageDesignHtml,
  // Ramiro
  getRamiroMemory, setRamiroMemory, getTranscripts, insertTranscript,
  // Raw helpers
  dbAll, dbGet, dbRun,
};
