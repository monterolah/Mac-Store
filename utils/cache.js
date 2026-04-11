const memCache = { settings: null, categories: null, announcements: null, homeBanners: null, homeProducts: null, publicData: {} };

function getCache(key) {
  return memCache.publicData[key];
}

function setCache(key, value) {
  memCache.publicData[key] = value;
}

function clearCache() {
  memCache.publicData = {};
  console.log('⚡ Caché en memoria limpiada por un cambio en el admin.');
}

module.exports = { getCache, setCache, clearCache };
