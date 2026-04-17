'use strict';
const express = require('express');
const { getCache, setCache } = require('../utils/cache');
const {
  getSettings, getAllProducts, getAllCategories, getAllBanners, getAllAnnouncements,
  getProductBySlug, getPageDesign,
} = require('../db/sqlite');
const router = express.Router();
const fmt = p => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p || 0);

function getCookie(req, name) {
  const str  = req.headers.cookie || '';
  const pair = str.split(';').find(c => c.trim().startsWith(name + '='));
  return pair ? decodeURIComponent(pair.split('=')[1].trim()) : null;
}

router.use((req, res, next) => {
  res.locals.vendorMode = getCookie(req, 'vendorMode') === '1';
  next();
});

router.get('/tienda',       (req, res) => { res.cookie('vendorMode', '1', { maxAge: 8*60*60*1000, sameSite:'lax' }); res.redirect('/'); });
router.get('/salir-tienda', (req, res) => { res.clearCookie('vendorMode'); res.redirect('/'); });

// ── Helpers cacheados ─────────────────────────────────────────────────────
function cachedSettings() {
  if (getCache('settings')) return getCache('settings');
  const data = getSettings();
  setCache('settings', data);
  return data;
}

function cachedCategories() {
  if (getCache('categories')) return getCache('categories');
  const data = getAllCategories({ active: true });
  setCache('categories', data);
  return data;
}

function cachedAnnouncements() {
  if (getCache('announcements')) return getCache('announcements');
  const data = getAllAnnouncements({ active: true });
  setCache('announcements', data);
  return data;
}

// Devuelve el CSS guardado desde el editor (si existe)
function getEditorCss(pageName) {
  try {
    const d = getPageDesign(pageName);
    return (d && d.css) ? d.css : '';
  } catch (e) { return ''; }
}

// Si el editor guardó HTML para esta página, lo devuelve; si no, null
function getSavedHtml(pageName) {
  try {
    const d = getPageDesign(pageName);
    return (d && d.html && d.html.trim()) ? d.html : null;
  } catch (e) { return null; }
}

// ── HOME ──────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const saved = getSavedHtml('home');
    if (saved) return res.send(saved);

    const settings      = cachedSettings();
    const categories    = cachedCategories();
    const announcements = cachedAnnouncements();

    let banners     = getCache('homeBanners');
    let allProducts = getCache('homeProducts');

    if (!banners)     { banners = getAllBanners({ active: true }); setCache('homeBanners', banners); }
    if (!allProducts) { allProducts = getAllProducts({ active: true }); setCache('homeProducts', allProducts); }

    const featured       = allProducts.filter(p => p.featured);
    const activeCatSlugs = new Set(allProducts.map(p => p.category));
    const visibleCats    = categories.filter(c => c.force_show || activeCatSlugs.has(c.slug));

    res.render('home', {
      req, announcements,
      title:       settings.store_name || 'MacStore',
      description: settings.store_tagline || '',
      settings, categories: visibleCats, banners, featured,
      formatPrice: fmt,
      editorCss:   getEditorCss('home'),
    });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── CATEGORY ──────────────────────────────────────────────────────────────
router.get('/categoria/:slug', (req, res) => {
  try {
    const slug          = req.params.slug;
    const settings      = cachedSettings();
    const categories    = cachedCategories();
    const announcements = cachedAnnouncements();
    const category      = categories.find(c => c.slug === slug);

    if (!category) return res.status(404).render('404', { title:'No encontrado', description:'', settings, categories, announcements });

    const saved = getSavedHtml('category-' + slug);
    if (saved) return res.send(saved);

    const products = getAllProducts({ active: true, category: slug });
    res.render('category', {
      req, title: category.name, description: category.description || '',
      settings, categories, category, products, announcements,
      formatPrice: fmt,
      editorCss:   getEditorCss('category-' + slug) || getEditorCss('category'),
    });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── PRODUCT ───────────────────────────────────────────────────────────────
router.get('/producto/:slug', (req, res) => {
  try {
    const slug          = req.params.slug;
    const settings      = cachedSettings();
    const categories    = cachedCategories();
    const announcements = cachedAnnouncements();
    const product       = getProductBySlug(slug);

    if (!product || !product.active) return res.status(404).render('404', { title:'No encontrado', description:'', settings, categories, announcements });

    const saved = getSavedHtml('product-' + slug);
    if (saved) return res.send(saved);

    const related = getAllProducts({ active: true, category: product.category })
      .filter(p => p.id !== product.id)
      .slice(0, 4);

    res.render('product', {
      req, title: product.name, description: product.description || '',
      settings, categories, product, related, announcements,
      formatPrice: fmt,
      editorCss:   getEditorCss('product-' + slug) || getEditorCss('product'),
    });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── CATALOG ───────────────────────────────────────────────────────────────
router.get('/productos', (req, res) => {
  try {
    const cat = req.query.cat;
    const q   = (req.query.q || '').trim().toLowerCase();

    // Usar HTML guardado por el editor solo si no hay filtros activos
    if (!q && !cat) {
      const saved = getSavedHtml('catalog');
      if (saved) return res.send(saved);
    }

    const settings      = cachedSettings();
    const categories    = cachedCategories();
    const announcements = cachedAnnouncements();

    let products = getAllProducts({ active: true, ...(cat ? { category: cat } : {}) });
    if (q) {
      products = products.filter(p =>
        (p.name        || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.category    || '').toLowerCase().includes(q) ||
        (p.badge       || '').toLowerCase().includes(q)
      );
    }

    res.render('catalog', {
      req,
      title: q ? `Búsqueda: ${req.query.q}` : 'Catálogo',
      description: 'Todos los productos Apple disponibles',
      settings, categories, products, announcements,
      formatPrice: fmt, searchQuery: req.query.q || '',
      editorCss: getEditorCss('catalog'),
    });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

module.exports = router;
