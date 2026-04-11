'use strict';

const https = require('https');
const http = require('http');
// No external HTML parsing - use regex to avoid File API dependency (cheerio → undici → File error)

const BLOCKED_HOSTS = new Set([
  '0.0.0.0', '::1',
  '10.0.0.1', '169.254.169.254',
]);

function isBlockedHost(hostname = '') {
  const h = String(hostname).toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  return false;
}

/**
 * Descarga el HTML de una URL y lo devuelve como string limpio.
 */
async function fetchHtml(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo no permitido');
  if (isBlockedHost(parsed.hostname)) throw new Error('Host no permitido');

  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 RamiroBot/2.0' },
      timeout: 14000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return resolve(fetchHtml(loc)); // seguir redirect una vez
        return reject(new Error('Redirect sin destino'));
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout al leer URL')); });
  });
}

/**
 * Lee una URL y devuelve su contenido en texto limpio + metadatos.
 */
async function readUrlContent(url) {
  const html = await fetchHtml(url);

  // Remove script, style, noscript, svg tags
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');

  // Extract title
  const titleMatch = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract meta description
  const metaDescMatch = cleaned.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || cleaned.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';

  // Extract headings
  const headings = [];
  const headingMatches = cleaned.matchAll(/<h[1-3][^>]*>([^<]*)<\/h[1-3]>/gi);
  for (const match of headingMatches) {
    const text = match[1].trim().replace(/&#?\w+;/g, '');
    if (text) headings.push(text);
  }

  // Extract paragraphs
  const paragraphs = [];
  const paraMatches = cleaned.matchAll(/<p[^>]*>([^<]*)<\/p>/gi);
  for (const match of paraMatches) {
    const text = match[1].trim().replace(/&#?\w+;/g, '');
    if (text.length >= 30) paragraphs.push(text);
  }

  // Extract images
  const images = [];
  const imgMatches = cleaned.matchAll(/<img\b[^>]*src=["']([^"']*?)["'][^>]*(?:alt=["']([^"']*?)["'])?/gi);
  for (const match of imgMatches) {
    const src = match[1];
    const alt = match[2] || '';
    if (src && !src.startsWith('data:')) images.push({ src, alt });
  }

  const rawText = [title, metaDesc, ...headings, ...paragraphs]
    .join('\n')
    .replace(/\s{3,}/g, '\n')
    .slice(0, 14000);

  return {
    url,
    title,
    metaDescription: metaDesc,
    headings: headings.slice(0, 25),
    paragraphs: paragraphs.slice(0, 25),
    images: images.slice(0, 30),
    rawText,
  };
}

/**
 * Extrae productos de una URL usando heurísticas + selectores comunes.
 * Retorna array de {name, price, image, link}.
 */
async function extractProductsFromUrl(url) {
  const html = await fetchHtml(url);
  const products = [];

  // Remove scripts and styles first
  const cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Find all potential product containers (.product, .card, [data-product], etc)
  const containerRegex = /<(div|article|li|section)[^>]*(product|card|item|catalog)[^>]*>([^<]*(?:<(?!\/\1)[^<]*)*)<\/\1>/gi;
  const containers = [...cleaned.matchAll(containerRegex)];

  for (const containerMatch of containers) {
    const containerHtml = containerMatch[0];

    // Extract name from heading or text
    const nameMatch = containerHtml.match(/<(?:h[1-4]|div|span)[^>]*(?:title|name|product)[^>]*>([^<]+)<\/(?:h[1-4]|div|span)>/i)
      || containerHtml.match(/<h[1-4][^>]*>([^<]+)<\/h[1-4]>/i)
      || containerHtml.match(/<(?:span|a)[^>]*>([^<]{2,80})<\/(?:span|a)>/i);
    const name = nameMatch ? nameMatch[1].trim().replace(/&#?\w+;/g, '') : null;

    // Extract price using price patterns
    const priceMatch = containerHtml.match(/\$?\s*([0-9]+(?:[.,][0-9]{2})?)\s*(?:USD|AUD|€|£)?/i)
      || containerHtml.match(/price[^>]*>([^<$]*\d+[^<]*)<\//i);
    const priceRaw = priceMatch ? priceMatch[1].trim() : '';

    // Extract image
    const imgMatch = containerHtml.match(/<img\b[^>]*src=["']([^"']*?)["']/i);
    const image = imgMatch && !imgMatch[1].startsWith('data:') ? imgMatch[1] : null;

    // Extract link
    const linkMatch = containerHtml.match(/<a\b[^>]*href=["']([^"']*?)["']/i);
    let link = null;
    if (linkMatch) {
      try {
        link = new URL(linkMatch[1], url).href;
      } catch {
        link = null;
      }
    }

    if (name && name.length >= 2 && (priceRaw || image)) {
      const priceNum = parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || null;
      products.push({ name, price: priceNum, priceRaw, image, link });
    }
  }

  // Deduplicar por nombre+precio
  const seen = new Set();
  const unique = [];
  for (const p of products) {
    const key = `${p.name}::${p.priceRaw}`;
    if (!seen.has(key)) { seen.add(key); unique.push(p); }
  }

  return unique.slice(0, 200);
}

module.exports = { readUrlContent, extractProductsFromUrl };
