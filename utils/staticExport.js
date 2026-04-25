'use strict';
/**
 * staticExport.js — Generador de sitio estático para GoDaddy
 *
 * Genera HTML estático desde las vistas EJS + datos de SQLite.
 * El resultado se guarda en /exports/<timestamp>/ y como /exports/latest/
 * Con "publicar" se crea además un ZIP descargable.
 */

const ejs    = require('ejs');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const {
  getSettings, getAllProducts, getAllCategories, getAllBanners, getAllAnnouncements, getPageDesign,
} = require('../db/sqlite');
const { patchSavedHtml } = require('./htmlPatch');

const VIEWS_DIR   = path.join(__dirname, '../views');
const PUBLIC_DIR  = path.join(__dirname, '../public');
const EXPORTS_DIR = path.join(__dirname, '../exports');

const formatPrice = p =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p || 0);

/* ── Reescritura de links para hosting estático ───────────────────────── */
function rewriteLinks(html, depth) {
  const up = depth > 0 ? '../' : '';

  return html
    // CSS / JS locales
    .replace(/src="\/css\//g,      `src="${up}css/`)
    .replace(/href="\/css\//g,     `href="${up}css/`)
    .replace(/src="\/js\//g,       `src="${up}js/`)
    .replace(/href="\/js\//g,      `href="${up}js/`)
    .replace(/src="\/uploads\//g,  `src="${up}uploads/`)

    // Páginas internas
    .replace(/href="\/producto\/([^"?#]+)"/g, `href="${up}producto/$1.html"`)
    .replace(/href="\/categoria\/([^"?#]+)"/g, `href="${up}categoria/$1.html"`)
    .replace(/href="\/productos[^"]*"/g,        `href="${up}catalogo.html"`)
    .replace(/href="\/#([^"]*)"/g,              `href="${up}index.html#$1"`)
    .replace(/href="\/"/g,                      `href="${up}index.html"`)

    // Quitar enlaces que apuntan al admin dinámico
    .replace(/href="\/admin[^"]*"/g, 'href="#"')

    // Quitar acciones de formularios (sitio es solo lectura)
    .replace(/action="\/[^"]*"/g, 'action="#"');
}

/* ── Renderiza un template EJS a string ──────────────────────────────── */
async function renderPage(template, data, depth = 0) {
  // req simulado mínimo para que el header no rompa al leer req.session
  const fakeReq = { session: {} };

  const html = await ejs.renderFile(
    path.join(VIEWS_DIR, template),
    {
      ...data,
      vendorMode: false,
      req: fakeReq,
      locals: {},
    },
    {
      views: [VIEWS_DIR, path.join(VIEWS_DIR, 'partials')],
      rmWhitespace: false,
    }
  );

  return rewriteLinks(html, depth);
}

/* ── Copia recursiva de carpeta ──────────────────────────────────────── */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(f => {
    const s = path.join(src, f);
    const d = path.join(dest, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  });
}

/* ── Exportador principal ────────────────────────────────────────────── */
async function exportSite(label) {
  // Traer todos los datos desde SQLite
  const settings      = getSettings() || {};
  const products      = getAllProducts().filter(p => p.active !== false && p.active !== 0)
                          .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const categories    = getAllCategories({ active: true })
                          .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const banners       = getAllBanners({ active: true })
                          .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const announcements = getAllAnnouncements()
                          .filter(a => a.active !== false && a.active !== 0);

  // Carpeta de salida
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir     = path.join(EXPORTS_DIR, label || timestamp);
  const latestDir  = path.join(EXPORTS_DIR, 'latest');

  [outDir, latestDir].forEach(d => {
    fs.mkdirSync(path.join(d, 'producto'),  { recursive: true });
    fs.mkdirSync(path.join(d, 'categoria'), { recursive: true });
    fs.mkdirSync(path.join(d, 'css'),       { recursive: true });
    fs.mkdirSync(path.join(d, 'js'),        { recursive: true });
  });

  const common = {
    settings,
    categories,
    announcements,
    formatPrice,
    vendorMode: false,
  };

  /* Usa HTML guardado del editor (con parche de datos frescos) si existe,
     si no, renderiza EJS fresco con el CSS del editor. */
  async function getPageHtml(pageName, ejsTemplate, ejsData, depth) {
    const saved = getPageDesign(pageName);
    if (saved && saved.html && saved.html.trim()) {
      return rewriteLinks(patchSavedHtml(pageName, saved.html), depth);
    }
    const editorCss = (saved && saved.css) ? saved.css : '';
    return renderPage(ejsTemplate, { ...ejsData, editorCss }, depth);
  }

  /* ── index.html ── */
  const homeHtml = await getPageHtml('home', 'home.ejs', {
    ...common, banners, featured: products, title: settings.store_name || 'MacStore',
  }, 0);
  fs.writeFileSync(path.join(outDir,    'index.html'), homeHtml);
  fs.writeFileSync(path.join(latestDir, 'index.html'), homeHtml);

  /* ── catalogo.html ── */
  const catalogHtml = await getPageHtml('catalog', 'catalog.ejs', {
    ...common, products, title: 'Catálogo',
  }, 0);
  fs.writeFileSync(path.join(outDir,    'catalogo.html'), catalogHtml);
  fs.writeFileSync(path.join(latestDir, 'catalogo.html'), catalogHtml);

  /* ── producto/slug.html ── */
  for (const p of products) {
    if (!p.slug) continue;
    const related = products
      .filter(x => x.id !== p.id && (x.cat_slug === p.cat_slug || x.category === p.category))
      .slice(0, 4);
    const html = await getPageHtml('product-' + p.slug, 'product.ejs', {
      ...common, product: p, related,
      settings: { ...settings, show_admin_icon: false }, title: p.name,
    }, 1);
    fs.writeFileSync(path.join(outDir,    'producto', `${p.slug}.html`), html);
    fs.writeFileSync(path.join(latestDir, 'producto', `${p.slug}.html`), html);
  }

  /* ── categoria/slug.html ── */
  for (const c of categories) {
    if (!c.slug) continue;
    const catProducts = products.filter(
      x => x.cat_slug === c.slug || x.category === c.slug || x.category === c.name
    );
    const html = await getPageHtml('category-' + c.slug, 'category.ejs', {
      ...common, category: c, products: catProducts, title: c.name,
    }, 1);
    fs.writeFileSync(path.join(outDir,    'categoria', `${c.slug}.html`), html);
    fs.writeFileSync(path.join(latestDir, 'categoria', `${c.slug}.html`), html);
  }

  /* ── Copiar assets estáticos ── */
  ['css', 'js'].forEach(dir => {
    copyDir(path.join(PUBLIC_DIR, dir), path.join(outDir,    dir));
    copyDir(path.join(PUBLIC_DIR, dir), path.join(latestDir, dir));
  });

  const stats = {
    pages:      2 + products.length + categories.length,
    products:   products.length,
    categories: categories.length,
    folder:     outDir,
    timestamp,
  };

  return { outDir, latestDir, stats };
}

/* ── Crear ZIP del directorio de exportación ────────────────────────── */
function createZip(sourceDir, zipPath) {
  // Usa el comando `zip` nativo de macOS/Linux
  execSync(`cd "${sourceDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
  return zipPath;
}

module.exports = { exportSite, createZip, EXPORTS_DIR };
