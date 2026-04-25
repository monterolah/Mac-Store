'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { requireAdmin } = require('../middleware/auth');
const {
  getSettings, getAllCategories, getAllProducts, getAllBanners,
  getAllAnnouncements, getAllPaymentMethods, getAllInventoryEntries,
  getAdminByEmail, getProductById,
} = require('../db/sqlite');
const router = express.Router();
const fmt    = p => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(p || 0);

function sortBySortOrder(items) {
  return [...items].sort((a, b) => {
    const av = Number.isFinite(Number(a?.sort_order)) ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER;
    const bv = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

function getSiteData()   { try { return getSettings(); }                    catch { return {}; } }
function getCategories() { try { return getAllCategories({ active: true }); } catch { return []; } }

// ── GET LOGIN ──────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  const settings = getSiteData();
  res.render('admin/login', { title:'Admin — MacStore', settings, categories:[], announcements:[], error:null });
});

// ── POST LOGIN ─────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const settings = getSiteData();
  try {
    const { email, password } = req.body;
    const admin = getAdminByEmail(email);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.render('admin/login', { title:'Admin', settings, categories:[], announcements:[], error:'Credenciales incorrectas' });
    const token = jwt.sign({ id: admin.id, email: admin.email, name: admin.name }, process.env.JWT_SECRET, { expiresIn:'8h' });
    req.session.adminToken = token;
    res.redirect('/admin');
  } catch (e) {
    console.error('Login error:', e.message);
    res.render('admin/login', { title:'Admin', settings, categories:[], announcements:[], error:'Error al iniciar sesión' });
  }
});

// ── LOGOUT ────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => { req.session.adminToken = null; res.redirect('/admin/login'); });

// ── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const products = sortBySortOrder(getAllProducts());
  const banners  = getAllBanners({ active: true });
  const stats    = { products: products.length, active: products.filter(p => p.active !== false).length, banners: banners.length };
  const recentProducts = [...products].reverse().slice(0, 6);
  res.render('admin/dashboard', { title:'Dashboard — Admin', settings, categories, announcements:[], stats, token: req.session.adminToken, formatPrice: fmt, admin, recentProducts });
});

// ── PRODUCTS LIST ─────────────────────────────────────────────────────────
router.get('/productos', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const products = sortBySortOrder(getAllProducts());
  res.render('admin/products', { title:'Productos — Admin', settings, categories, announcements:[], products, token: req.session.adminToken, formatPrice: fmt, admin });
});

// ── NEW PRODUCT ───────────────────────────────────────────────────────────
router.get('/productos/nuevo', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  res.render('admin/product-form', { title:'Nuevo producto', settings, categories, announcements:[], product:null, token: req.session.adminToken, admin });
});

// ── EDIT PRODUCT ──────────────────────────────────────────────────────────
router.get('/productos/:id/editar', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const product  = getProductById(req.params.id);
  if (!product) return res.redirect('/admin/productos');
  res.render('admin/product-form', { title:'Editar producto', settings, categories, announcements:[], product, token: req.session.adminToken, admin });
});

// ── CATEGORIAS ────────────────────────────────────────────────────────────
router.get('/categorias', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const cats     = getAllCategories();
  res.render('admin/categories', { title:'Categorías — Admin', settings, categories, announcements:[], cats, token: req.session.adminToken, admin });
});

// ── BANNERS ───────────────────────────────────────────────────────────────
router.get('/banners', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const banners  = getAllBanners();
  res.render('admin/banners', { title:'Banners — Admin', settings, categories, announcements:[], banners, token: req.session.adminToken, admin });
});

// ── ANUNCIOS ──────────────────────────────────────────────────────────────
router.get('/anuncios', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const announcements = getAllAnnouncements();
  res.render('admin/announcements', { title:'Anuncios — Admin', settings, categories, announcements, token: req.session.adminToken, admin });
});

// ── MÉTODOS DE PAGO ───────────────────────────────────────────────────────
router.get('/metodos-pago', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const methods  = getAllPaymentMethods();
  res.render('admin/payment-methods', { title:'Métodos de Pago — Admin', settings, categories, announcements:[], methods, token: req.session.adminToken, admin });
});

// ── NOTIFICACIONES / INGRESOS ─────────────────────────────────────────────
router.get('/notificaciones', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  const entries  = getAllInventoryEntries(50);
  res.render('admin/notifications', { title:'Notificaciones — Admin', settings, categories, announcements:[], entries, token: req.session.adminToken, admin });
});

// ── COTIZACIONES ──────────────────────────────────────────────────────────
router.get('/cotizaciones', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  res.render('admin/quotations', { title:'Cotizaciones — Admin', settings, categories, announcements:[], token: req.session.adminToken, admin });
});

// ── ASISTENTE IA ──────────────────────────────────────────────────────────
router.get('/asistente', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  res.render('admin/gemini', { title:'Asistente IA — Admin', settings, categories, announcements:[], token: req.session.adminToken, admin });
});

// ── EDITOR VISUAL ─────────────────────────────────────────────────────────
router.get('/editor', requireAdmin, (req, res) => {
  try {
    const admin      = req.admin || { name:'Admin', email:'' };
    const settings   = getSiteData();
    const categories = getCategories();
    const products   = getAllProducts().filter(p => p.active !== false && p.slug)
                         .sort((a,b) => (Number(a.sort_order)||0) - (Number(b.sort_order)||0));
    res.render('admin/editor', { title:'Editor de Tienda — Admin', settings, categories, products, announcements:[], token: req.session.adminToken, admin });
  } catch(e) { console.error('Editor route error:', e.message); res.status(500).send('Error al cargar el editor: ' + e.message); }
});

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────
router.get('/configuracion', requireAdmin, (req, res) => {
  const admin    = req.admin || { name:'Admin', email:'' };
  const settings = getSiteData();
  const categories = getCategories();
  res.render('admin/settings', { title:'Configuración — Admin', settings, categories, announcements:[], token: req.session.adminToken, admin });
});

module.exports = router;
