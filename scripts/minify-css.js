#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const cleancssBin = path.join(__dirname, '..', 'node_modules', '.bin',
  process.platform === 'win32' ? 'cleancss.cmd' : 'cleancss');

const input  = path.join(__dirname, '..', 'src', 'macstore.src.css');
const output = path.join(__dirname, '..', 'public', 'css', 'macstore.css');

const cmd = `"${cleancssBin}" -o "${output}" "${input}"`;
console.log('Minificando CSS...');
execSync(cmd, { stdio: 'inherit' });
console.log(`Listo → ${output}`);
