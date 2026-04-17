'use strict';
const {
  getAllProducts, getProductById, insertProduct, updateProduct, deleteProduct: dbDeleteProduct,
} = require('../../db/sqlite');

function slugify(text) {
  return String(text||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

const ALLOWED_CATEGORIES   = new Set(['mac','iphone','ipad','airpods']);
const ALLOWED_UPDATE_FIELDS = ['price','original_price','active','description','variants','color_variants','stock','specs','badge','image_url'];

async function searchProducts(filters = {}) {
  let results = getAllProducts();
  if (typeof filters.active === 'boolean')
    results = results.filter(p => (p.active !== false && p.active !== 0) === filters.active);
  if (typeof filters.hasImage === 'boolean')
    results = results.filter(p => Boolean(p.image_url && String(p.image_url).trim()) === filters.hasImage);
  if (filters.category)
    results = results.filter(p => p.category === filters.category);
  if (filters.nameContains) {
    const q = String(filters.nameContains).toLowerCase();
    results = results.filter(p => String(p.name||'').toLowerCase().includes(q));
  }
  return results.slice(0, 80);
}

async function createProduct(payload) {
  const name = String(payload.name||'').trim();
  if (!name) throw new Error('Falta nombre del producto');
  const category = ALLOWED_CATEGORIES.has(String(payload.category||'').toLowerCase()) ? String(payload.category).toLowerCase() : 'mac';
  const price    = Number(payload.price);
  const doc = {
    name, slug: payload.slug || slugify(name), category,
    price: Number.isFinite(price) && price > 0 ? price : 1,
    description: String(payload.description || `${name} disponible en MacStore.`).slice(0,2000),
    active: payload.active !== false ? 1 : 0,
    stock: Number(payload.stock) || 0, sort_order: Number(payload.sort_order) || 0,
    image_url: String(payload.image_url||''),
    color_variants: Array.isArray(payload.color_variants) ? payload.color_variants : [],
    variants: Array.isArray(payload.variants) ? payload.variants : [],
    specs: (payload.specs && typeof payload.specs==='object') ? payload.specs : {},
    badge: String(payload.badge||''),
  };
  const ref = insertProduct(doc);
  return { id: ref.id, ...doc };
}

async function updateProductById(productId, updates = {}) {
  if (!productId) throw new Error('Falta productId');
  const ex = getProductById(productId);
  if (!ex) throw new Error('Producto no encontrado');
  const filtered = {};
  for (const k of ALLOWED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) filtered[k] = updates[k];
  }
  if (!Object.keys(filtered).length) throw new Error('No hay campos válidos para actualizar');
  updateProduct(productId, filtered);
  return { ok: true, productId, updated: Object.keys(filtered) };
}

async function hideProduct(productId)  { return updateProductById(productId, { active: 0 }); }
async function showProduct(productId)  { return updateProductById(productId, { active: 1 }); }

async function deleteProductById(productId) {
  if (!productId) throw new Error('Falta productId');
  dbDeleteProduct(productId);
  return { ok: true, productId };
}

async function bulkDeleteWithoutImage() {
  const withoutImage = getAllProducts().filter(p => !p.image_url || !String(p.image_url).trim());
  withoutImage.forEach(p => dbDeleteProduct(p.id));
  return { ok: true, deletedCount: withoutImage.length };
}

async function syncProductsFromArray(rawProducts, sourceUrl = '') {
  const existing = getAllProducts();
  const bySlug   = new Map(existing.map(p => [p.slug, p]));
  let created = 0, updated = 0;
  for (const p of rawProducts) {
    const name = String(p.name||'').trim();
    if (!name) continue;
    const slug     = slugify(name);
    const category = ALLOWED_CATEGORIES.has(String(p.category||'').toLowerCase()) ? String(p.category).toLowerCase() : 'mac';
    const price    = Number(p.price);
    const payload  = { name, slug, category, price: Number.isFinite(price)&&price>0?price:1, description: String(p.description||`${name} disponible en MacStore.`).slice(0,2000), image_url: String(p.image||p.image_url||''), variants: Array.isArray(p.variants)?p.variants:[], specs: (p.specs&&typeof p.specs==='object')?p.specs:{}, active: 1, ficha: { notas: `Sincronizado desde ${sourceUrl}` } };
    const ex = bySlug.get(slug);
    if (ex) { updateProduct(ex.id, payload); updated++; }
    else    { insertProduct({ ...payload, stock:0, sort_order:0 }); created++; }
  }
  return { ok: true, created, updated, total: rawProducts.length };
}

async function bulkCatalogAction({ ids = [], operation } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('No hay ids para la acción masiva');
  if (operation === 'delete')                      { ids.forEach(id => dbDeleteProduct(id)); return { ok:true, operation, affected:ids.length }; }
  if (operation === 'hide' || operation === 'deactivate') { ids.forEach(id => updateProduct(id,{active:0})); return { ok:true, operation, affected:ids.length }; }
  if (operation === 'show' || operation === 'activate')   { ids.forEach(id => updateProduct(id,{active:1})); return { ok:true, operation, affected:ids.length }; }
  throw new Error(`Operación masiva no soportada: ${operation}`);
}

module.exports = {
  searchProducts, searchCatalogProducts: searchProducts,
  createProduct, createCatalogProduct: createProduct,
  updateProduct: updateProductById, updateCatalogProduct: updateProductById,
  hideProduct, hideCatalogProduct: hideProduct,
  showProduct,
  deleteProduct: deleteProductById, deleteCatalogProduct: deleteProductById,
  bulkDeleteWithoutImage, bulkCatalogAction, syncProductsFromArray,
};
