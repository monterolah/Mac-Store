'use strict';
const ExcelJS = require('exceljs');
const { slugify } = require('../middleware/helpers');
const {
  getAllCategories, getAllProducts,
  insertCategory, insertProduct, updateProduct,
  insertInventoryEntry,
} = require('../db/sqlite');

function normalizeText(value) { return String(value ?? '').trim(); }
function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1','true','si','sí','yes','activo','visible','on'].includes(v)) return true;
  if (['0','false','no','inactivo','oculto','off'].includes(v)) return false;
  return fallback;
}
function normalizeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const num = Number(String(value).replace(/[,$\s]/g,''));
  return Number.isFinite(num) ? num : fallback;
}
function inferCategoryFromText(text, fallback = 'accesorios') {
  const v = slugify(text || '');
  if (!v) return fallback;
  if (/macbook|imac|mac-mini|mac-studio|studio-display|pro-display|display/.test(v)) return 'mac';
  if (/iphone|magsafe-iphone/.test(v)) return 'iphone';
  if (/ipad|magic-keyboard-for-ipad|apple-pencil/.test(v)) return 'ipad';
  if (/watch|apple-watch/.test(v)) return 'apple-watch';
  if (/airpods|beats/.test(v)) return 'airpods';
  if (/cable|charger|cargador|adaptador|case|funda|keyboard|mouse|trackpad|hub|correa|band|accessor/.test(v)) return 'accesorios';
  return fallback;
}

function loadCategoriesMap() {
  const bySlug = new Map(), byName = new Map();
  getAllCategories().forEach(c => {
    if (c.slug) bySlug.set(c.slug.toLowerCase(), c);
    if (c.name) byName.set(c.name.toLowerCase(), c);
  });
  return { bySlug, byName };
}

function ensureCategory(rawCategory, categoriesMap, fallbackText = '') {
  const preferred     = normalizeText(rawCategory) || inferCategoryFromText(fallbackText, 'accesorios');
  const categoryName  = normalizeText(preferred) || 'Accesorios';
  const categorySlug  = slugify(categoryName);
  const existing      = categoriesMap.bySlug.get(categorySlug) || categoriesMap.byName.get(categoryName.toLowerCase());
  if (existing) return existing.slug || categorySlug;
  insertCategory({ name: categoryName, slug: categorySlug, description: '', sort_order: 0 });
  const created = { id: String(Date.now()), name: categoryName, slug: categorySlug };
  categoriesMap.bySlug.set(categorySlug, created);
  categoriesMap.byName.set(categoryName.toLowerCase(), created);
  return categorySlug;
}

function rowToCatalogProduct(row, categorySlug, existing = null) {
  const name = normalizeText(row['Nombre']);
  if (!name) return null;
  const shortDesc = normalizeText(row['Descripción corta']);
  const longDesc  = normalizeText(row['Descripción larga']);
  const price     = normalizeNumber(row['Precio'], existing?.price || 0);
  const origPrice = normalizeNumber(row['Precio oferta'], 0);
  const visible   = normalizeBool(row['Visible web'], existing?.active !== false);
  const featured  = normalizeBool(row['Destacado'], existing?.featured === true);
  const stock     = Math.max(0, Math.round(normalizeNumber(row['Stock'], existing?.stock || 0)));
  const image1    = normalizeText(row['URL imagen 1']) || existing?.image_url || '';
  const sku       = normalizeText(row['SKU']);
  const marca     = normalizeText(row['Marca']);
  const modelo    = normalizeText(row['Modelo']);
  const color     = normalizeText(row['Color']);
  const capacidad = normalizeText(row['Capacidad']);
  const compat    = normalizeText(row['Compatibilidad']);
  const condicion = normalizeText(row['Condición']);
  const etiquetas = normalizeText(row['Etiquetas']);
  const notas     = normalizeText(row['Notas internas']);
  // subcategoría disponible para uso futuro
  const description = [shortDesc, longDesc].filter(Boolean).join('\n\n') || existing?.description || '';
  return {
    sku, name, slug: existing?.slug || slugify(name), description, price,
    original_price: origPrice > 0 ? origPrice : null, category: categorySlug,
    badge: condicion || existing?.badge || null,
    featured: featured ? 1 : 0, active: visible ? 1 : 0, stock,
    image_url: image1,
    img_fit: existing?.img_fit || 'contain', img_pos: existing?.img_pos || 'center', img_scale: existing?.img_scale || 1,
    specs: existing?.specs || [],
    variants: existing?.variants || [], logos: existing?.logos || [], color_variants: existing?.color_variants || [],
    ficha_tecnica: existing?.ficha_tecnica || '',
    ficha: { ...(existing?.ficha || {}), marca: marca||existing?.ficha?.marca||'', modelo: modelo||existing?.ficha?.modelo||'', capacidad: capacidad||existing?.ficha?.capacidad||'', colores: color||existing?.ficha?.colores||'', notas: [compat,etiquetas,notas].filter(Boolean).join(' • ')||existing?.ficha?.notas||'' },
    brand: marca || existing?.brand || '', model: modelo || existing?.model || '',
    tags: etiquetas ? etiquetas.split(',').map(t=>t.trim()).filter(Boolean) : (existing?.tags || []),
  };
}

async function readWorkbookRows(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('No se encontró hoja para importar');
  const allRows = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, cell => {
      let val = cell.value;
      if (val && typeof val === 'object') {
        if (val.richText) val = val.richText.map(r => r.text||'').join('');
        else if (val.result !== undefined) val = val.result;
        else if (val instanceof Date) val = val;
        else val = String(val);
      }
      cells.push(val ?? '');
    });
    allRows.push(cells);
  });
  return allRows;
}

async function readWorkbookAsObjects(filePath) {
  const allRows = await readWorkbookRows(filePath);
  if (allRows.length < 2) return [];
  const normalized = allRows.map(r => r.map(c => normalizeText(c)));
  let headerIdx = normalized.findIndex(r => r.some(c => ['nombre','descripcion','#item','sku'].includes(c.toLowerCase())));
  if (headerIdx < 0) headerIdx = 0;
  const headers = normalized[headerIdx].map((h,i) => h || `COL_${i+1}`);
  return normalized.slice(headerIdx+1).filter(r => r.some(c => c!=='')).map(r => {
    const obj = {};
    headers.forEach((h,i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
}

// ── Importar catálogo ──────────────────────────────────────────────────────
async function importCatalogFromWorkbook(filePath, options = {}) {
  const rows      = await readWorkbookAsObjects(filePath);
  const validRows = rows.filter(r => normalizeText(r['Nombre']));
  if (!validRows.length) throw new Error('El Excel no trae productos válidos');

  const categoriesMap  = loadCategoriesMap();
  const allProds       = getAllProducts();
  const existingBySku  = new Map();
  const existingByName = new Map();
  allProds.forEach(p => {
    if (p.sku)  existingBySku.set(normalizeText(p.sku), p);
    if (p.name) existingByName.set(normalizeText(p.name).toLowerCase(), p);
  });

  const touchedIds = new Set();
  let created = 0, updated = 0, hidden = 0;

  for (const row of validRows) {
    const sku      = normalizeText(row['SKU']);
    const name     = normalizeText(row['Nombre']);
    const existing = (sku && existingBySku.get(sku)) || existingByName.get(name.toLowerCase()) || null;
    const catSlug  = ensureCategory(row['Categoría'], categoriesMap, name);
    const product  = rowToCatalogProduct(row, catSlug, existing);
    if (!product) continue;

    if (existing) {
      updateProduct(existing.id, { ...existing, ...product });
      touchedIds.add(String(existing.id));
      updated++;
    } else {
      const ref = insertProduct({ ...product, sort_order: 0 });
      touchedIds.add(ref.id);
      created++;
    }
  }

  if (options.hideMissing) {
    allProds.forEach(p => {
      if (!touchedIds.has(String(p.id)) && p.active !== false) {
        updateProduct(p.id, { active: 0 });
        hidden++;
      }
    });
  }

  return { ok: true, totalRows: validRows.length, created, updated, hidden, mode: options.hideMissing ? 'replace' : 'merge', importType: 'catalog' };
}

// ── Importar inventario ────────────────────────────────────────────────────
function rowToInventoryItem(row) {
  const sku  = normalizeText(row['#Item'] || row['SKU'] || row['Sku'] || row['sku']);
  const name = normalizeText(row['Descripcion'] || row['Descripción'] || row['Descripcion producto'] || row['Nombre']);
  const qty  = Math.max(0, Math.round(normalizeNumber(row['Qty'] || row['Cantidad'], 0)));
  const price = normalizeNumber(row['PRECIO'] || row['Precio'], 0);
  const total = normalizeNumber(row['T PV'] || row['Total'], price * qty);
  const partNumber = normalizeText(row['#parte'] || row['Parte'] || row['No. Parte'] || row['Part Number']);
  const categoryRaw = normalizeText(row['Categoría'] || row['Categoria']);
  if (!sku || !name || qty <= 0) return null;
  return { sku, partNumber, name, qty, price, total, categoryRaw, description: name };
}

async function importInventoryWorkbook(filePath, options = {}) {
  const rows  = await readWorkbookAsObjects(filePath);
  const items = rows.map(rowToInventoryItem).filter(Boolean);
  if (!items.length) throw new Error('El archivo no trae ingresos válidos');

  const categoriesMap = loadCategoriesMap();
  const allProds      = getAllProducts();
  const existingBySku = new Map();
  allProds.forEach(p => { if (p.sku && !existingBySku.has(p.sku)) existingBySku.set(normalizeText(p.sku), p); });

  let created = 0, updated = 0;
  const entryItems = [];

  for (const item of items) {
    const catSlug  = ensureCategory(item.categoryRaw || existingBySku.get(item.sku)?.category || '', categoriesMap, item.name);
    const existing = existingBySku.get(item.sku) || null;

    if (existing) {
      const prevStock  = Math.max(0, parseInt(existing.stock) || 0);
      const newStock   = prevStock + item.qty;
      const prevActive = existing.active !== false;
      updateProduct(existing.id, {
        sku: item.sku, category: catSlug, name: existing.name || item.name,
        description: existing.description || item.name,
        stock: newStock, price: item.price > 0 ? item.price : (existing.price || 0),
        part_number: item.partNumber || existing.part_number || '',
        last_entry_at: new Date().toISOString(), active: prevActive ? 1 : 0,
      });
      existingBySku.set(item.sku, { ...existing, stock: newStock });
      updated++;
      entryItems.push({ productId: existing.id, sku: item.sku, name: existing.name || item.name, category: catSlug, qtyAdded: item.qty, unitPrice: item.price, lineTotal: item.total, previousStock: prevStock, newStock, previousActive: prevActive, createdProduct: false });
    } else {
      const ref = insertProduct({
        sku: item.sku, part_number: item.partNumber, name: item.name, slug: slugify(item.name),
        description: item.name, category: catSlug, price: item.price, original_price: null,
        active: 1, stock: item.qty, image_url: '', img_fit: 'contain', img_pos: 'center', img_scale: 1,
        specs: {}, variants: [], logos: [], color_variants: [], sort_order: 0,
      });
      existingBySku.set(item.sku, { id: ref.id, sku: item.sku, stock: item.qty, active: true });
      created++;
      entryItems.push({ productId: ref.id, sku: item.sku, name: item.name, category: catSlug, qtyAdded: item.qty, unitPrice: item.price, lineTotal: item.total, previousStock: 0, newStock: item.qty, previousActive: false, createdProduct: true });
    }
  }

  const now = new Date().toISOString();
  const entry = insertInventoryEntry({
    items: entryItems, status: 'normal',
    source: 'excel', source_file_name: options.sourceFileName || '',
    createdAt: now, updatedAt: now,
  });

  return { ok: true, importType: 'inventory', entryId: entry.id, totalRows: items.length, created, updated, ignored: 0, hidden: 0, mode: 'inventory-merge' };
}

module.exports = { importCatalogFromWorkbook, importInventoryWorkbook };
