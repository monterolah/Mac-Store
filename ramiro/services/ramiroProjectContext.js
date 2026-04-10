'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = { text: '', builtAt: 0 };

function safeRead(filePath, maxLen = 12000) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').slice(0, maxLen);
  } catch {
    return '';
  }
}

function extractPackageScripts(packageRaw) {
  if (!packageRaw) return [];
  try {
    const parsed = JSON.parse(packageRaw);
    const scripts = parsed.scripts || {};
    return Object.keys(scripts).slice(0, 10).map(k => `${k}: ${scripts[k]}`);
  } catch {
    return [];
  }
}

function extractServerMounts(serverRaw) {
  if (!serverRaw) return [];
  const mounts = [];
  const regex = /(?:app|adminApp|adminApiApp)\.use\([^\n]+\)/g;
  const found = serverRaw.match(regex) || [];
  for (const line of found.slice(0, 30)) mounts.push(line.trim());
  return mounts;
}

function summarizeFolders(rootDir) {
  const focus = {
    'routes': 'rutas Express (public, admin, api, ramiro)',
    'ramiro': 'motor IA (brain, memoria, prompt, extractores)',
    'views': 'plantillas EJS de storefront y admin',
    'public': 'assets cliente (css/js)',
    'src': 'fuentes JS/CSS antes de ofuscacion/minificado',
    'middleware': 'auth y utilidades de request',
    'db': 'inicializacion y acceso Firebase/DB',
    'utils': 'importador catalogo y subida de archivos',
    'functions': 'Firebase Cloud Functions',
  };

  const lines = [];
  for (const [folder, desc] of Object.entries(focus)) {
    const abs = path.join(rootDir, folder);
    const exists = fs.existsSync(abs);
    if (!exists) continue;

    let fileCount = 0;
    try {
      fileCount = fs.readdirSync(abs).length;
    } catch {
      fileCount = 0;
    }

    lines.push(`- ${folder}: ${desc} (items: ${fileCount})`);
  }
  return lines;
}

function buildProjectContextSnapshot(rootDir) {
  const now = Date.now();
  if (cached.text && now - cached.builtAt < CACHE_TTL_MS) {
    return cached.text;
  }

  const readme = safeRead(path.join(rootDir, 'README.md'), 6000);
  const packageRaw = safeRead(path.join(rootDir, 'package.json'), 8000);
  const serverRaw = safeRead(path.join(rootDir, 'server.js'), 12000);

  const scripts = extractPackageScripts(packageRaw);
  const mounts = extractServerMounts(serverRaw);
  const folders = summarizeFolders(rootDir);

  const context = [
    'RESUMEN GLOBAL DEL PROYECTO',
    '- App web de MacStore con Node.js + Express + EJS + Firebase/Firestore.',
    '- Arquitectura principal: rutas publicas + panel admin + API admin + modulo Ramiro IA.',
    '- Entidades clave: products, categories, banners, announcements, payment_methods, quotations, settings.',
    '',
    'ESTRUCTURA PRINCIPAL',
    ...folders,
    '',
    'RUTAS / MONTAJES DEL SERVIDOR',
    ...mounts.map(m => `- ${m}`),
    '',
    'SCRIPTS DE EJECUCION',
    ...scripts.map(s => `- ${s}`),
    '',
    'REGLAS OPERATIVAS IMPORTANTES',
    '- Cambios de catalogo se reflejan en Firestore (coleccion products).',
    '- Acciones sensibles requieren confirmacion (crear, borrar, acciones masivas, sync por URL).',
    '- El admin usa autenticacion por JWT + sesion.',
    '- Cotizaciones PDF se generan en backend (PDFKit) y se guardan en historial.',
    '- Ramiro debe responder natural, pero nunca inventar ejecuciones ni datos.',
    '',
    'README (extracto)',
    readme || '- Sin README disponible.'
  ].join('\n').slice(0, 18000);

  cached = { text: context, builtAt: now };
  return context;
}

module.exports = { buildProjectContextSnapshot };
