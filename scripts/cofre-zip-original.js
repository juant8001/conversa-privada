#!/usr/bin/env node
'use strict';

// Recupera o .zip original que foi guardado (cifrado) no cofre da conversa.
//
//   node scripts/cofre-zip-original.js ~/Desktop/recuperado.zip
//
// Pede o código do cofre (não aparece enquanto digita). Usa a pasta data/
// do lado deste script, ou DATA_DIR.

const path = require('path');
const fs = require('fs');
const vault = require('../lib/vault');

const out = process.argv[2];
if (!out) {
  console.error('Uso: node scripts/cofre-zip-original.js <arquivo-de-saida.zip>');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error('Esse arquivo já existe; escolha outro nome.');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    });
  });
}

(async () => {
  vault.init({ dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') });
  const code = process.env.VAULT_CODE || await askHidden('Código do cofre: ');
  try {
    await vault.exportZip(code, null, out);
    console.log(`Pronto: ${out}`);
  } catch (e) {
    try { fs.rmSync(out, { force: true }); } catch (err) { /* nada */ }
    console.error(e.message || e);
    process.exit(1);
  }
})();
