'use strict';
/**
 * db/database.js — Inicialización de la base de datos SQLite
 * Crea las tablas si no existen y siembra el admin por defecto.
 */

const bcrypt = require('bcryptjs');
const { getDB, getAdminByEmail, insertAdmin, getSettings, setSettings } = require('./sqlite');

function createTables(db) {
  db.exec(`
    -- ── Configuración (documento único JSON) ────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      id   INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT    NOT NULL DEFAULT '{}'
    );

    -- ── Administradores ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS admins (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      email     TEXT    UNIQUE NOT NULL,
      password  TEXT    NOT NULL,
      name      TEXT    DEFAULT 'Admin',
      createdAt TEXT
    );

    -- ── Categorías ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS categories (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      slug           TEXT    UNIQUE NOT NULL,
      description    TEXT    DEFAULT '',
      sort_order     INTEGER DEFAULT 0,
      bg_color       TEXT    DEFAULT '',
      active         INTEGER DEFAULT 1,
      image_url      TEXT    DEFAULT '',
      share_whatsapp INTEGER DEFAULT 0,
      force_show     INTEGER DEFAULT 0,
      createdAt      TEXT,
      updatedAt      TEXT
    );

    -- ── Productos ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS products (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      slug               TEXT    UNIQUE NOT NULL,
      description        TEXT    DEFAULT '',
      price              REAL    DEFAULT 0,
      original_price     REAL,
      category           TEXT    DEFAULT '',
      cat_slug           TEXT    DEFAULT '',
      cat_name           TEXT    DEFAULT '',
      badge              TEXT,
      featured           INTEGER DEFAULT 0,
      active             INTEGER DEFAULT 1,
      stock              INTEGER DEFAULT 0,
      sort_order         INTEGER DEFAULT 0,
      enable_installments INTEGER DEFAULT 1,
      image_url          TEXT    DEFAULT '',
      img_fit            TEXT    DEFAULT 'contain',
      img_pos            TEXT    DEFAULT 'center',
      img_scale          REAL    DEFAULT 1,
      detail_img_scale   REAL    DEFAULT 1,
      color_variants     TEXT    DEFAULT '[]',
      variants           TEXT    DEFAULT '[]',
      logos              TEXT    DEFAULT '[]',
      specs              TEXT    DEFAULT '{}',
      ficha_tecnica      TEXT    DEFAULT '',
      ficha              TEXT    DEFAULT '{}',
      createdAt          TEXT,
      updatedAt          TEXT
    );

    -- ── Banners ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS banners (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    DEFAULT '',
      subtitle   TEXT    DEFAULT '',
      cta_text   TEXT    DEFAULT '',
      cta_url    TEXT    DEFAULT '',
      image_url  TEXT    DEFAULT '',
      bg_color   TEXT    DEFAULT '#1d1d1f',
      text_color TEXT    DEFAULT '#ffffff',
      sort_order INTEGER DEFAULT 0,
      active     INTEGER DEFAULT 1,
      createdAt  TEXT,
      updatedAt  TEXT
    );

    -- ── Anuncios / Promociones ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS announcements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    DEFAULT '',
      link        TEXT    DEFAULT '',
      image_url   TEXT    DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      logo_height INTEGER DEFAULT 64,
      active      INTEGER DEFAULT 1,
      createdAt   TEXT,
      updatedAt   TEXT
    );

    -- ── Métodos de pago ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payment_methods (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      logo_url    TEXT    DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      createdAt   TEXT,
      updatedAt   TEXT
    );

    -- ── Cotizaciones ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS quotations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      q_num          TEXT    DEFAULT '',
      client         TEXT    DEFAULT '',
      company        TEXT    DEFAULT '',
      client_phone   TEXT    DEFAULT '',
      client_email   TEXT    DEFAULT '',
      seller         TEXT    DEFAULT '',
      notes          TEXT    DEFAULT '',
      validity       TEXT    DEFAULT '7',
      iva_mode       TEXT    DEFAULT 'con',
      ivaMode        TEXT    DEFAULT 'con',
      items          TEXT    DEFAULT '[]',
      total          REAL    DEFAULT 0,
      lbl1           TEXT    DEFAULT '',
      lbl2           TEXT    DEFAULT '',
      div1           REAL    DEFAULT 0,
      div2           REAL    DEFAULT 0,
      foot_notes     TEXT    DEFAULT '',
      settings       TEXT    DEFAULT '{}',
      options        TEXT    DEFAULT '{}',
      paymentMethods TEXT    DEFAULT '[]',
      qNum           TEXT    DEFAULT '',
      createdAt      TEXT
    );

    -- ── Ingresos de inventario ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS inventory_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      items          TEXT    DEFAULT '[]',
      status         TEXT    DEFAULT 'normal',
      source         TEXT    DEFAULT '',
      source_file_name TEXT  DEFAULT '',
      createdAt      TEXT,
      updatedAt      TEXT,
      cancelledAt    TEXT
    );

    -- ── Memoria del asistente Ramiro ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS ramiro_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    UNIQUE DEFAULT 'default',
      patterns    TEXT    DEFAULT '[]',
      preferences TEXT    DEFAULT '{}',
      createdAt   TEXT,
      updatedAt   TEXT
    );

    -- ── Historial de conversaciones Ramiro ───────────────────────────
    CREATE TABLE IF NOT EXISTS ramiro_transcripts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   TEXT    DEFAULT 'default',
      role      TEXT    DEFAULT 'user',
      content   TEXT    DEFAULT '',
      createdAt TEXT
    );

    -- ── Diseños de páginas (editor visual) ───────────────────────────
    CREATE TABLE IF NOT EXISTS page_designs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      page_name TEXT    UNIQUE NOT NULL,
      html      TEXT    DEFAULT '',
      css       TEXT    DEFAULT '',
      gjs_data  TEXT    DEFAULT '{}',
      updatedAt TEXT
    );
  `);
}

async function initializeDB() {
  const db      = getDB();
  const isProd  = process.env.NODE_ENV === 'production';

  createTables(db);

  // Admin por defecto
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@macstore.com').trim();
  const adminPass  = (process.env.ADMIN_PASSWORD || 'Admin123!').trim();

  if (isProd && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
    throw new Error('En producción debes definir ADMIN_EMAIL y ADMIN_PASSWORD');
  }

  if (!getAdminByEmail(adminEmail)) {
    const hash = bcrypt.hashSync(adminPass, 12);
    insertAdmin({ email: adminEmail, password: hash, name: 'Administrador MacStore' });
    console.log('✅ Admin creado:', adminEmail);
  }

  // Settings por defecto
  const settings = getSettings();
  if (!settings.store_name) {
    setSettings({
      store_name:       'MacStore',
      store_tagline:    'Distribuidor Autorizado Apple',
      store_phone:      '+503 0000-0000',
      store_email:      'ventas@macstore.com',
      store_address:    'El Salvador',
      store_whatsapp:   '50300000000',
      promo_bar_text:   'Hasta 12 cuotas sin intereses · Envío gratis en compras mayores a $500',
      promo_bar_active: true,
      logo_url:         ''
    });
    console.log('✅ Settings creados');
  }

  // Categorías demo
  if (!isProd && process.env.SEED_DEMO === 'true') {
    const { getAllCategories, insertCategory, getAllProducts, insertProduct } = require('./sqlite');
    if (getAllCategories().length === 0) {
      const cats = [
        { name:'Mac',         slug:'mac',         sort_order:1 },
        { name:'iPhone',      slug:'iphone',      sort_order:2 },
        { name:'iPad',        slug:'ipad',        sort_order:3 },
        { name:'Apple Watch', slug:'apple-watch', sort_order:4 },
        { name:'AirPods',     slug:'airpods',     sort_order:5 },
        { name:'Accesorios',  slug:'accesorios',  sort_order:6 },
      ];
      cats.forEach(c => insertCategory(c));
      console.log('✅ Categorías demo creadas');
    }
    if (getAllProducts().length === 0) {
      insertProduct({
        name:'MacBook Pro 14"', slug:'macbook-pro-14', category:'mac',
        price:1999, original_price:2199, badge:'Nuevo', featured:1, active:1,
        stock:15, description:'Chip M3 Pro. Hasta 22 horas de batería.',
        image_url:'', specs:{ Chip:'Apple M3 Pro', RAM:'18 GB' },
        color_variants:[], sort_order:1
      });
      console.log('✅ Productos demo creados');
    }
  }

  console.log('✅ SQLite listo — MacStore (', db.name, ')');
}

module.exports = { initializeDB };
