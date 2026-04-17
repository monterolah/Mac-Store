#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const sslDir = path.join(__dirname, '..', 'ssl');

// Crear directorio ssl si no existe (cross-platform, equivale a mkdir -p)
fs.mkdirSync(sslDir, { recursive: true });

const keyOut  = path.join(sslDir, 'key.pem');
const certOut = path.join(sslDir, 'cert.pem');

const cmd = [
  'openssl req -x509 -newkey rsa:2048',
  `-keyout "${keyOut}"`,
  `-out "${certOut}"`,
  '-days 825 -nodes',
  '-subj "/C=MX/ST=Local/L=Local/O=MacStore/CN=192.168.1.244"',
  '-addext "subjectAltName=IP:192.168.1.244,IP:127.0.0.1,DNS:localhost"',
].join(' ');

console.log('Generando certificado SSL...');
try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\nCertificado generado en: ${sslDir}`);
  console.log('  key.pem  → clave privada');
  console.log('  cert.pem → certificado');
} catch (e) {
  console.error('\nError: asegúrate de tener OpenSSL instalado.');
  console.error('  Mac/Linux: ya suele estar instalado.');
  console.error('  Windows:   instala Git for Windows (incluye OpenSSL) o descarga OpenSSL.');
  process.exit(1);
}
