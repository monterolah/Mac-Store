#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const files = ['macstore', 'quotation', 'admin', 'protect'];

const obfuscatorBin = path.join(__dirname, '..', 'node_modules', '.bin',
  process.platform === 'win32' ? 'javascript-obfuscator.cmd' : 'javascript-obfuscator');

const flags = [
  '--compact true',
  '--control-flow-flattening true',
  '--control-flow-flattening-threshold 0.4',
  '--dead-code-injection true',
  '--dead-code-injection-threshold 0.2',
  '--identifier-names-generator hexadecimal',
  '--rename-globals false',
  '--self-defending true',
  '--string-array true',
  '--string-array-encoding rc4',
  '--string-array-threshold 0.75',
  '--transform-object-keys true',
  '--disable-console-output true',
  '--debug-protection true',
  '--debug-protection-interval 2000',
].join(' ');

for (const f of files) {
  const input  = path.join(__dirname, '..', 'src', 'js', `${f}.src.js`);
  const output = path.join(__dirname, '..', 'public', 'js', `${f}.js`);
  const cmd    = `"${obfuscatorBin}" "${input}" --output "${output}" ${flags}`;
  console.log(`Obfuscating ${f}...`);
  execSync(cmd, { stdio: 'inherit' });
}

console.log('Done.');
