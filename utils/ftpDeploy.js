'use strict';
const ftp  = require('basic-ftp');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXPORTS_DIR  = path.join(__dirname, '../exports/latest');
const MANIFEST_PATH = path.join(__dirname, '../exports/.manifest.json');

function fileHash(filePath) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
  } catch { return ''; }
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}

function saveManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function collectFiles(dir, base = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(full, base));
    else results.push({ local: full, relative: path.relative(base, full) });
  }
  return results;
}

async function deployToGodaddy(onProgress) {
  const host = process.env.GODADDY_FTP_HOST;
  const user = process.env.GODADDY_FTP_USER;
  const pass = process.env.GODADDY_FTP_PASS;
  const dir  = process.env.GODADDY_FTP_DIR || '/public_html/';

  if (!host || !user || !pass) throw new Error('Faltan credenciales FTP en el archivo .env');
  if (!fs.existsSync(EXPORTS_DIR))  throw new Error('No hay archivos exportados. Guarda primero desde el editor.');

  const allFiles = collectFiles(EXPORTS_DIR);
  if (!allFiles.length) throw new Error('La carpeta de exportación está vacía.');

  const manifest = loadManifest();
  const toUpload = allFiles.filter(f => fileHash(f.local) !== manifest[f.relative]);

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host, user, password: pass, secure: false });
    onProgress?.({ type: 'connected', total: toUpload.length });

    let uploaded = 0;
    for (const file of toUpload) {
      const remotePath = dir.replace(/\/$/, '') + '/' + file.relative.replace(/\\/g, '/');
      const remoteDir  = remotePath.substring(0, remotePath.lastIndexOf('/'));
      await client.ensureDir(remoteDir);
      await client.uploadFrom(file.local, remotePath);
      manifest[file.relative] = fileHash(file.local);
      uploaded++;
      onProgress?.({ type: 'progress', uploaded, total: toUpload.length, file: file.relative });
    }

    saveManifest(manifest);
    return { uploaded, total: allFiles.length, skipped: allFiles.length - toUpload.length };
  } finally {
    client.close();
  }
}

module.exports = { deployToGodaddy };
