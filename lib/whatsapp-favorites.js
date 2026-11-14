'use strict';

// Lê as figurinhas favoritas do WhatsApp instalado neste Mac.
//
// O WhatsApp não tem "exportar favoritas". Mas o app do Mac guarda, no
// próprio contêiner, a lista que ele sincroniza com o celular (AppState,
// ação "favoriteSticker"): pra cada favorita vem o hash do arquivo, a chave
// da mídia e o endereço no servidor do WhatsApp. Daqui:
//  1. o arquivo já está no disco (pasta stickers/, achado pelo hash em
//     Sticker.sqlite) -> usa ele;
//  2. senão baixa do servidor de mídia do WhatsApp e decifra com a chave da
//     própria favorita (o mesmo esquema de qualquer mídia do WhatsApp).
// Em todo caso o SHA-256 do resultado tem de bater com o hash da lista.
//
// Só leitura: os bancos são abertos com o sqlite3 do sistema em modo
// somente-leitura. Desligado a menos que WHATSAPP_IMPORT=1 no .env.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONTAINER = path.join(os.homedir(), 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared');
const MAX_STICKER_DOWNLOAD = 2 * 1024 * 1024;

function containerDir() {
  return process.env.WHATSAPP_CONTAINER || DEFAULT_CONTAINER;
}

function sqliteBin() {
  for (const p of [process.env.SQLITE3_PATH, '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function appStateDb() {
  const base = path.join(containerDir(), 'AppState');
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch (e) {
    return null;
  }
  // Pode haver mais de uma pasta (contas antigas): fica com a mais recente.
  let best = null;
  for (const d of dirs) {
    const f = path.join(base, d, 'AppState.sqlite');
    try {
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    } catch (e) { /* ignora */ }
  }
  return best && best.f;
}

function enabled() {
  return process.env.WHATSAPP_IMPORT === '1' && !!sqliteBin() && !!appStateDb();
}

function query(db, sql) {
  return new Promise((resolve, reject) => {
    execFile(sqliteBin(), ['-readonly', '-batch', '-noheader', '-separator', '|', `file:${db}?mode=ro`, sql],
      { maxBuffer: 64 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
        if (err) reject(new Error('Não consegui ler o banco do WhatsApp.'));
        else resolve(stdout.split('\n').filter(Boolean).map((l) => l.split('|')));
      });
  });
}

// Protobuf mínimo: só o que a ação de figurinha usa.
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf truncado');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}

function parseFields(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
    } else if (wire === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error('protobuf desconhecido');
    }
    if (!fields.has(field)) fields.set(field, value);
  }
  return fields;
}

// SyncActionValue { 1: timestamp, 33: StickerAction }
// StickerAction { 1 url, 2 fileEncSha256, 3 mediaKey, 4 mimetype,
//                 7 directPath, 8 fileLength, 9 isFavorite, 11 isLottie }
function parseFavorite(valueHex, indexText) {
  const outer = parseFields(Buffer.from(valueHex, 'hex'));
  const inner = outer.get(33);
  if (!Buffer.isBuffer(inner)) return null;
  const f = parseFields(inner);
  let hash = null;
  try {
    const idx = JSON.parse(indexText);
    if (Array.isArray(idx) && idx[0] === 'favoriteSticker') hash = String(idx[1] || '');
  } catch (e) { /* ignora */ }
  const str = (n) => (Buffer.isBuffer(f.get(n)) ? f.get(n).toString('utf8') : '');
  return {
    hash, // SHA-256 do arquivo, em base64
    ts: outer.has(1) ? Number(outer.get(1)) : 0,
    url: str(1),
    fileEncSha256: Buffer.isBuffer(f.get(2)) ? Buffer.from(f.get(2)) : null,
    mediaKey: Buffer.isBuffer(f.get(3)) ? Buffer.from(f.get(3)) : null,
    mimetype: str(4),
    directPath: str(7),
    isFavorite: f.has(9) ? f.get(9) === 1n : true,
    isLottie: f.get(11) === 1n || str(4) === 'application/was',
  };
}

/** Lista as favoritas atuais, da mais recente pra mais antiga. */
async function listFavorites() {
  const db = appStateDb();
  if (!db) throw new Error('Não achei o WhatsApp deste Mac.');
  const rows = await query(db,
    "select ZVERSION, cast(ZINDEX as text), hex(ZVALUE) from ZAPPSTATECONFIRMEDMUTATIONENTITY where ZACTIONNAME = 'favoriteSticker'");
  const latest = new Map();
  for (const [version, index, valueHex] of rows) {
    let fav;
    try {
      fav = parseFavorite(valueHex, index);
    } catch (e) {
      continue;
    }
    if (!fav || !fav.hash) continue;
    const prev = latest.get(fav.hash);
    const v = Number(version) || 0;
    if (!prev || v > prev.v || (v === prev.v && fav.ts >= prev.fav.ts)) latest.set(fav.hash, { v, fav });
  }
  return [...latest.values()]
    .map((x) => x.fav)
    .filter((f) => f.isFavorite && !f.isLottie)
    .sort((a, b) => b.ts - a.ts);
}

// Arquivos de figurinha que o WhatsApp já tem no disco, por hash (base64).
async function localFiles() {
  const db = path.join(containerDir(), 'Sticker.sqlite');
  const map = new Map();
  if (!fs.existsSync(db)) return map;
  try {
    const rows = await query(db, 'select ZFILEHASH, ZRELATIVEIMAGEPATH from ZWACDSTICKER where ZFILEHASH is not null and ZRELATIVEIMAGEPATH is not null');
    for (const [hash, rel] of rows) {
      if (!hash || !rel || rel.includes('..')) continue;
      map.set(hash, path.join(containerDir(), 'stickers', rel));
    }
  } catch (e) { /* sem cache local: tudo vai pelo download */ }
  return map;
}

function sha256b64(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64');
}

// Esquema de mídia do WhatsApp: HKDF-SHA256(mediaKey) -> iv | chave AES |
// chave do MAC; o arquivo é AES-256-CBC + 10 bytes de HMAC no fim.
function decryptMedia(enc, mediaKey) {
  const keys = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from('WhatsApp Image Keys'), 112));
  const iv = keys.subarray(0, 16);
  const cipherKey = keys.subarray(16, 48);
  const macKey = keys.subarray(48, 80);
  if (enc.length < 26) throw new Error('arquivo curto demais');
  const body = enc.subarray(0, enc.length - 10);
  const mac = enc.subarray(enc.length - 10);
  const expected = crypto.createHmac('sha256', macKey).update(iv).update(body).digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(mac, expected)) throw new Error('MAC não confere');
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function mediaBase() {
  return (process.env.WHATSAPP_MEDIA_BASE || 'https://mmg.whatsapp.net').replace(/\/$/, '');
}

function allowedMediaUrl(u) {
  const testBase = process.env.WHATSAPP_MEDIA_BASE;
  if (testBase && u.origin === new URL(testBase).origin) return true;
  const host = u.hostname.toLowerCase();
  return u.protocol === 'https:' && (host === 'whatsapp.net' || host.endsWith('.whatsapp.net'));
}

async function download(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (!allowedMediaUrl(u)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(u, { signal: controller.signal, headers: { 'User-Agent': 'WhatsApp/2', Origin: 'https://web.whatsapp.com' } });
    if (!res.ok || !allowedMediaUrl(new URL(res.url))) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_STICKER_DOWNLOAD ? buf : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Arquivo (WebP) de uma favorita, ou null se não deu. */
async function loadFavorite(fav, locals) {
  const local = locals && locals.get(fav.hash);
  if (local) {
    try {
      const buf = fs.readFileSync(local);
      if (sha256b64(buf) === fav.hash) return buf;
    } catch (e) { /* cai pro download */ }
  }
  if (!fav.mediaKey || fav.mediaKey.length !== 32) return null;
  const urls = [];
  if (fav.directPath) urls.push(`${mediaBase()}${fav.directPath.startsWith('/') ? '' : '/'}${fav.directPath}`);
  if (fav.url && !process.env.WHATSAPP_MEDIA_BASE) urls.push(fav.url);
  for (const url of urls) {
    const enc = await download(url);
    if (!enc) continue;
    if (fav.fileEncSha256 && sha256b64(enc) !== fav.fileEncSha256.toString('base64')) continue;
    try {
      const plain = decryptMedia(enc, fav.mediaKey);
      if (sha256b64(plain) === fav.hash) return plain;
    } catch (e) { /* tenta o próximo endereço */ }
  }
  return null;
}

// Varredura completa (lista + arquivo de cada favorita), guardada em memória
// por 10 minutos ou até o WhatsApp mexer nos bancos. É o que alimenta a tela
// de escolher: as prévias e a importação usam os MESMOS bytes já conferidos.
const SCAN_TTL_MS = 10 * 60 * 1000;
let scanCache = null;
let scanRunning = null;

function fileSig(f) {
  try {
    const st = fs.statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return '-';
  }
}

function scanSig() {
  const db = appStateDb();
  const sticker = path.join(containerDir(), 'Sticker.sqlite');
  return [db, fileSig(db), fileSig(`${db}-wal`), fileSig(sticker), fileSig(`${sticker}-wal`)].join('|');
}

async function doScan() {
  const favs = await listFavorites();
  const locals = await localFiles();
  const found = new Array(favs.length).fill(null);
  // Downloads em paralelo (8 por vez): os que falham respondem rápido, mas
  // um por um somaria vários segundos com 150 favoritas.
  let next = 0;
  async function worker() {
    while (next < favs.length) {
      const i = next++;
      const buf = await loadFavorite(favs[i], locals);
      if (buf) found[i] = buf;
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const items = [];
  favs.forEach((fav, i) => {
    if (!found[i]) return;
    items.push({
      key: crypto.createHash('sha256').update(found[i]).digest('hex'),
      ts: fav.ts,
      buffer: found[i],
    });
  });
  return { items, total: favs.length, missing: favs.length - items.length };
}

/** { items: [{ key (sha256 hex), ts, buffer }], total, missing }, da mais recente pra mais antiga. */
async function scan() {
  const sig = scanSig();
  if (scanCache && scanCache.sig === sig && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.result;
  if (!scanRunning) {
    scanRunning = doScan()
      .then((result) => {
        scanCache = { sig, at: Date.now(), result };
        return result;
      })
      .finally(() => {
        scanRunning = null;
      });
  }
  return scanRunning;
}

module.exports = { enabled, listFavorites, localFiles, loadFavorite, decryptMedia, parseFavorite, scan };
