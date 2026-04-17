'use strict';
/**
 * importFromFirestore.js
 * Jala todos los datos de Firestore (products, categories, banners, announcements, payment_methods, settings)
 * y los inserta en la base de datos SQLite de macstore-app-copy.
 *
 * Uso: node scripts/importFromFirestore.js
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getDB } = require('../db/sqlite');

// ── Init Firebase ────────────────────────────────────────────────────────────
const serviceAccount = require('/Users/macstore/Documents/macstore_pdf_directo-2-4/serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Helpers ──────────────────────────────────────────────────────────────────
function toJson(v) { return v != null ? JSON.stringify(v) : null; }
function slugify(text) {
  return String(text||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

async function run() {
  const sqlite = getDB();
  let counts = { categories: 0, products: 0, banners: 0, announcements: 0, payment_methods: 0 };

  // ── SETTINGS ────────────────────────────────────────────────────────────────
  console.log('⏳ Importando settings...');
  const settingsDoc = await db.collection('settings').doc('main').get();
  if (settingsDoc.exists) {
    const s = settingsDoc.data();
    const existing = sqlite.prepare('SELECT id FROM settings WHERE id = 1').get();
    if (existing) {
      sqlite.prepare(`UPDATE settings SET data = ? WHERE id = 1`).run(JSON.stringify(s));
    } else {
      sqlite.prepare(`INSERT INTO settings (id, data) VALUES (1, ?)`).run(JSON.stringify(s));
    }
    console.log('  ✅ Settings actualizados');
  }

  // ── CATEGORIES ──────────────────────────────────────────────────────────────
  console.log('⏳ Importando categorías...');
  const catsSnap = await db.collection('categories').get();
  const catSlugToId = new Map();
  for (const doc of catsSnap.docs) {
    const c = doc.data();
    const slug = c.slug || slugify(c.name || '');
    if (!slug) continue;
    const existing = sqlite.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    const bgColor = Array.isArray(c.bg_color) ? c.bg_color[0]||'#000000' : (c.bg_color||'');
    if (existing) {
      sqlite.prepare(`UPDATE categories SET name=?, description=?, sort_order=?, active=?, bg_color=?, image_url=?, share_whatsapp=? WHERE id=?`)
        .run(c.name||'', c.description||'', c.sort_order||0, c.active!==false?1:0, bgColor, c.image_url||'', c.share_whatsapp?1:0, existing.id);
      catSlugToId.set(slug, existing.id);
    } else {
      const r = sqlite.prepare(`INSERT INTO categories (name,slug,description,sort_order,active,bg_color,image_url,share_whatsapp,createdAt) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(c.name||'', slug, c.description||'', c.sort_order||0, c.active!==false?1:0, bgColor, c.image_url||'', c.share_whatsapp?1:0, new Date().toISOString());
      catSlugToId.set(slug, r.lastInsertRowid);
      counts.categories++;
    }
  }
  console.log(`  ✅ ${counts.categories} categorías nuevas, ${catsSnap.size - counts.categories} actualizadas`);

  // ── PRODUCTS ────────────────────────────────────────────────────────────────
  console.log('⏳ Importando productos...');
  const prodsSnap = await db.collection('products').get();
  for (const doc of prodsSnap.docs) {
    const p = doc.data();
    const name = String(p.name||'').trim();
    if (!name) continue;
    const slug = p.slug || slugify(name);
    const existing = sqlite.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
    const catSlug = p.cat_slug || p.category || 'accesorios';
    const now = new Date().toISOString();
    const payload = [
      name, slug,
      p.description||'', p.price||0, p.original_price||null,
      catSlug, catSlug, name,
      p.badge||'', p.featured?1:0, p.active!==false?1:0,
      p.stock||0, p.image_url||'',
      p.img_fit||'contain', p.img_pos||'center', Number(p.img_scale)||1,
      toJson(p.specs||{}), toJson(p.variants||[]), toJson(p.logos||[]), toJson(p.color_variants||[]),
      p.ficha_tecnica||'', toJson(p.ficha||{}),
      p.sort_order||0,
    ];
    if (existing) {
      sqlite.prepare(`UPDATE products SET name=?,slug=?,description=?,price=?,original_price=?,category=?,cat_slug=?,cat_name=?,badge=?,featured=?,active=?,stock=?,image_url=?,img_fit=?,img_pos=?,img_scale=?,specs=?,variants=?,logos=?,color_variants=?,ficha_tecnica=?,ficha=?,sort_order=?,updatedAt=? WHERE id=?`)
        .run(...payload, now, existing.id);
    } else {
      sqlite.prepare(`INSERT INTO products (name,slug,description,price,original_price,category,cat_slug,cat_name,badge,featured,active,stock,image_url,img_fit,img_pos,img_scale,specs,variants,logos,color_variants,ficha_tecnica,ficha,sort_order,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...payload, now);
      counts.products++;
    }
  }
  console.log(`  ✅ ${counts.products} productos nuevos, ${prodsSnap.size - counts.products} actualizados`);

  // ── BANNERS ────────────────────────────────────────────────────────────────
  console.log('⏳ Importando banners...');
  const bannersSnap = await db.collection('banners').get();
  for (const doc of bannersSnap.docs) {
    const b = doc.data();
    const existing = sqlite.prepare('SELECT id FROM banners WHERE title = ?').get(b.title||'');
    if (!existing) {
      sqlite.prepare(`INSERT INTO banners (title,subtitle,cta_text,cta_url,image_url,bg_color,text_color,active,sort_order,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(b.title||'', b.subtitle||'', b.cta_text||'', b.cta_url||'', b.image_url||'', b.bg_color||'#1d1d1f', b.text_color||'#ffffff', b.active!==false?1:0, b.sort_order||0, new Date().toISOString());
      counts.banners++;
    }
  }
  console.log(`  ✅ ${counts.banners} banners importados`);

  // ── ANNOUNCEMENTS ──────────────────────────────────────────────────────────
  console.log('⏳ Importando anuncios...');
  const annoSnap = await db.collection('announcements').get();
  for (const doc of annoSnap.docs) {
    const a = doc.data();
    const existing = sqlite.prepare('SELECT id FROM announcements WHERE title = ?').get(a.title||'');
    if (!existing) {
      sqlite.prepare(`INSERT INTO announcements (title,link,image_url,active,sort_order,logo_height,createdAt) VALUES (?,?,?,?,?,?,?)`)
        .run(a.title||'', a.link||'', a.image_url||'', a.active!==false?1:0, a.sort_order||0, a.logo_height||64, new Date().toISOString());
      counts.announcements++;
    }
  }
  console.log(`  ✅ ${counts.announcements} anuncios importados`);

  // ── PAYMENT METHODS ────────────────────────────────────────────────────────
  console.log('⏳ Importando métodos de pago...');
  const pmSnap = await db.collection('payment_methods').get();
  for (const doc of pmSnap.docs) {
    const pm = doc.data();
    const existing = sqlite.prepare('SELECT id FROM payment_methods WHERE name = ?').get(pm.name||'');
    if (!existing) {
      sqlite.prepare(`INSERT INTO payment_methods (name,description,logo_url,active,sort_order,createdAt) VALUES (?,?,?,?,?,?)`)
        .run(pm.name||'', pm.description||'', pm.logo_url||'', pm.active!==false?1:0, pm.sort_order||0, new Date().toISOString());
      counts.payment_methods++;
    }
  }
  console.log(`  ✅ ${counts.payment_methods} métodos de pago importados`);

  console.log('\n🎉 Importación completada:');
  console.table(counts);
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Error en importación:', err.message);
  process.exit(1);
});
