'use strict';

// Lê as figurinhas do WhatsApp instalado neste Mac: as favoritas e todas as
// que passaram por conversas (as que a pessoa mandou - inclusive as que ela
// criou - e as que recebeu).
//
// O WhatsApp não tem "exportar favoritas". Mas o app do Mac guarda, no
// próprio contêiner, a lista que ele sincroniza com o celular (AppState,
// ação "favoriteSticker"): pra cada favorita vem o hash do arquivo, a chave
// da mídia e o endereço no servidor do WhatsApp. Daqui:
//  1. o arquivo já está no disco (pasta stickers/, achado pelo hash em
//     Sticker.sqlite) -> usa ele;
//  2. a mesma figurinha passou por alguma conversa (ChatStorage.sqlite guarda
//     o hash de cada mídia): usa o arquivo dessa mensagem, se ainda existir;
//  3. senão baixa do servidor de mídia do WhatsApp e decifra - primeiro com a
//     chave da própria favorita, depois com a das mensagens mais recentes
//     que trouxeram a mesma figurinha. O link da favorita costuma expirar
//     (403); o de uma mensagem nova vale. Por isso mandar a figurinha do
//     celular pra qualquer conversa faz ela aparecer aqui.
// Em todo caso o SHA-256 do resultado tem de bater com o hash da lista.
// As figurinhas de conversas (v49) vêm pelos passos 2 e 3. O link de mídia do
// WhatsApp vale umas duas ou três semanas e o Mac apaga o arquivo local logo,
// então figurinha antiga que só passou por conversa fica só no celular...
// a menos que o celular mande de novo: desde a v50, se o Bot de Figurinhas
// (aparelho conectado ao mesmo número) estiver rodando, pedimos a ele que
// peça ao celular pra subir de novo a mídia da mensagem mais recente com
// aquela figurinha (o que o WhatsApp do computador faz ao tocar numa foto
// velha). Vale pras favoritas e pras que a pessoa mandou; o que volta fica
// guardado em data/wa-cache pra não pedir de novo.
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

// ZMEDIAKEY no ChatStorage é um protobuf { 1: mediaKey (32 bytes),
// 2: fileEncSha256, 3: timestamp } - até a v48 o código esperava os 32 bytes
// crus e nunca baixava nada das conversas. Aceita os dois jeitos.
function parseMediaKeyBlob(hex) {
  const none = { mediaKey: null, encSha: null };
  if (!hex || !/^[0-9A-Fa-f]+$/.test(hex)) return none;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length === 32) return { mediaKey: buf, encSha: null };
  try {
    const f = parseFields(buf);
    const k = f.get(1);
    const e = f.get(2);
    return {
      mediaKey: Buffer.isBuffer(k) && k.length === 32 ? Buffer.from(k) : null,
      encSha: Buffer.isBuffer(e) && e.length === 32 ? Buffer.from(e) : null,
    };
  } catch (err) {
    return none;
  }
}

// Link de mídia que serve pra baixar. O WhatsApp às vezes grava só
// "https://a.whatsapp.net" (sem caminho), que não leva a nada.
function usableUrl(u) {
  if (!u) return false;
  try {
    return new URL(u).pathname.length > 1;
  } catch (e) {
    return false;
  }
}

// Figurinhas que passaram por conversas: hash (base64) -> { copies, fromMe,
// ts }. copies são as cópias mais recentes que ainda têm por onde buscar
// [{ local, url, mediaKey, encSha }]; fromMe = a pessoa mandou essa
// figurinha alguma vez (é aí que entram as que ela criou); ts = data da
// mensagem mais recente, em ms. No ChatStorage do WhatsApp do Mac o hash do
// arquivo de cada mídia fica em ZWAMEDIAITEM.ZVCARDNAME; figurinha é a
// mensagem de tipo 15.
const CHAT_COPIES = 2;
const APPLE_EPOCH = 978307200; // 2001-01-01, base das datas do Core Data
async function chatStickers() {
  const db = path.join(containerDir(), 'ChatStorage.sqlite');
  const map = new Map();
  if (!fs.existsSync(db)) return map;
  try {
    const rows = await query(db,
      "select i.ZVCARDNAME, ifnull(i.ZMEDIALOCALPATH, ''), ifnull(i.ZMEDIAURL, ''), ifnull(hex(i.ZMEDIAKEY), ''), ifnull(m.ZISFROMME, 0), ifnull(m.ZMESSAGEDATE, 0), ifnull(s.ZCONTACTJID, ''), ifnull(m.ZSTANZAID, ''), ifnull(gm.ZMEMBERJID, '') from ZWAMEDIAITEM i join ZWAMESSAGE m on m.Z_PK = i.ZMESSAGE left join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION left join ZWAGROUPMEMBER gm on gm.Z_PK = m.ZGROUPMEMBER where m.ZMESSAGETYPE = 15 and i.ZVCARDNAME is not null order by m.ZMESSAGEDATE desc, i.Z_PK desc");
    for (const [hash, local, url, keyHex, fromMe, date, chatJid, stanzaId, memberJid] of rows) {
      if (!hash) continue;
      let entry = map.get(hash);
      if (!entry) {
        const secs = Number(date) || 0;
        entry = { copies: [], fromMe: false, ts: secs ? Math.round((secs + APPLE_EPOCH) * 1000) : 0, retry: null };
        map.set(hash, entry);
      }
      if (fromMe === '1') entry.fromMe = true;
      const { mediaKey, encSha } = parseMediaKeyBlob(keyHex);
      // A mensagem mais recente com chave serve pra pedir reenvio ao celular.
      if (!entry.retry && mediaKey && chatJid && stanzaId) {
        entry.retry = { remoteJid: chatJid, id: stanzaId, fromMe: fromMe === '1', participant: memberJid || '', mediaKey };
      }
      if (entry.copies.length >= CHAT_COPIES) continue;
      const localPath = local && !local.includes('..') && !local.startsWith('/') ? path.join(containerDir(), 'Message', local) : '';
      const goodUrl = usableUrl(url) && mediaKey ? url : '';
      if (!localPath && !goodUrl) continue;
      entry.copies.push({ local: localPath, url: goodUrl, mediaKey, encSha });
    }
  } catch (e) { /* sem conversas: segue só com as favoritas */ }
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

// { buf } quando baixou; { gone: true } quando o servidor respondeu que não
// tem (link expirado - não adianta tentar de novo); {} em erro de rede.
async function download(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return { gone: true };
  }
  if (!allowedMediaUrl(u)) return { gone: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(u, { signal: controller.signal, headers: { 'User-Agent': 'WhatsApp/2', Origin: 'https://web.whatsapp.com' } });
    if (!res.ok) return res.status >= 400 && res.status < 500 ? { gone: true } : {};
    if (!allowedMediaUrl(new URL(res.url))) return { gone: true };
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_STICKER_DOWNLOAD ? { buf } : { gone: true };
  } catch (e) {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function readIfHash(file, hash) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length <= MAX_STICKER_DOWNLOAD && sha256b64(buf) === hash) return buf;
  } catch (e) { /* não está lá */ }
  return null;
}

// { plain } quando deu; { gone } / {} como em download().
async function fetchDecrypted(url, mediaKey, hash, encSha) {
  if (!url || !mediaKey || mediaKey.length !== 32) return { gone: true };
  const got = await download(url);
  if (!got.buf) return got;
  const enc = got.buf;
  if (encSha && sha256b64(enc) !== encSha.toString('base64')) return { gone: true };
  try {
    const plain = decryptMedia(enc, mediaKey);
    return sha256b64(plain) === hash ? { plain } : { gone: true };
  } catch (e) {
    return { gone: true };
  }
}

// Figurinha é WebP (estática ou animada). As "Lottie" do WhatsApp (pacote
// zip) não servem aqui.
function isWebp(buf) {
  return buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

// Figurinhas que voltaram do celular ficam aqui (nome = sha256 em hex).
function cacheDir() {
  return process.env.WHATSAPP_CACHE_DIR
    || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wa-cache');
}
const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;
function cacheFile(hash) {
  return path.join(cacheDir(), `${Buffer.from(hash, 'base64').toString('hex')}.webp`);
}

// Memória entre varreduras: o que já baixou (por hash) e o que já falhou de
// vez com aquele mesmo conjunto de links. Uma mensagem nova com a mesma
// figurinha traz link novo e faz tentar de novo. Erro de rede não fica
// guardado.
const loaded = new Map();
const failed = new Map();

/**
 * Arquivo (WebP) de uma figurinha, ou null se não deu. fav pode ser uma
 * favorita (com link e chave próprios) ou só { hash } pra figurinha de
 * conversa.
 */
async function loadFavorite(fav, locals, chats) {
  const hash = fav.hash;
  if (loaded.has(hash)) return loaded.get(hash);
  if (HASH_RE.test(hash || '')) {
    const cached = readIfHash(cacheFile(hash), hash);
    if (cached) {
      loaded.set(hash, cached);
      return cached;
    }
  }
  const local = locals && locals.get(hash);
  if (local) {
    const buf = readIfHash(local, hash);
    if (buf) return buf;
  }
  const chat = chats && chats.get(hash);
  const copies = (chat && chat.copies) || [];
  for (const c of copies) {
    if (!c.local) continue;
    const buf = readIfHash(c.local, hash);
    if (buf) return buf;
  }
  const tries = [];
  if (fav.mediaKey) {
    if (fav.directPath) tries.push([`${mediaBase()}${fav.directPath.startsWith('/') ? '' : '/'}${fav.directPath}`, fav.mediaKey, fav.fileEncSha256]);
    if (fav.url && !process.env.WHATSAPP_MEDIA_BASE) tries.push([fav.url, fav.mediaKey, fav.fileEncSha256]);
  }
  for (const c of copies) if (c.url) tries.push([c.url, c.mediaKey, c.encSha]);
  const sig = tries.map((t) => t[0]).join(' ');
  if (!tries.length || failed.get(hash) === sig) return null;
  let transient = false;
  for (const [url, key, encSha] of tries) {
    const got = await fetchDecrypted(url, key, hash, encSha);
    if (got.plain) {
      if (isWebp(got.plain)) {
        loaded.set(hash, got.plain);
        failed.delete(hash);
        return got.plain;
      }
      break; // baixou, mas não é WebP: não adianta outro link
    }
    if (!got.gone) transient = true;
  }
  if (!transient) failed.set(hash, sig);
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
  const chat = path.join(containerDir(), 'ChatStorage.sqlite');
  return [db, fileSig(db), fileSig(`${db}-wal`), fileSig(sticker), fileSig(`${sticker}-wal`), fileSig(chat), fileSig(`${chat}-wal`)].join('|');
}

// ---- Reenvio pelo celular (via Bot de Figurinhas) ----
function reuploadConfig() {
  let token = process.env.WHATSAPP_REUPLOAD_TOKEN || '';
  if (!token && process.env.WHATSAPP_REUPLOAD_TOKEN_FILE) {
    try {
      token = fs.readFileSync(process.env.WHATSAPP_REUPLOAD_TOKEN_FILE, 'utf8').trim();
    } catch (e) { /* bot ainda não criou o token */ }
  }
  if (!token) return null;
  return { url: process.env.WHATSAPP_REUPLOAD_URL || 'http://127.0.0.1:4191/reenviar', token };
}

// hash -> id da mensagem cujo reenvio o celular recusou (não tem mais a
// mídia). Só tenta de novo se aparecer outra mensagem com a figurinha.
let reFailedMap = null;
function reFailed() {
  if (!reFailedMap) {
    reFailedMap = new Map();
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'recusadas.json'), 'utf8'));
      for (const [h, id] of Object.entries(obj)) if (typeof id === 'string') reFailedMap.set(h, id);
    } catch (e) { /* ainda não tem */ }
  }
  return reFailedMap;
}
function saveReFailed() {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDir(), 'recusadas.json'), JSON.stringify(Object.fromEntries(reFailed())), { mode: 0o600 });
  } catch (e) { /* tenta de novo da próxima vez */ }
}

const reQueue = new Map(); // hash -> retry
let reRunning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'ok' | 'fail' (celular recusou: guarda) | 'later' (sem resposta agora) |
// 'down' (bot fora do ar: para a fila)
async function reuploadOne(hash, retry) {
  const cfg = reuploadConfig();
  if (!cfg) return 'down';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  let body = {};
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-token': cfg.token },
      body: JSON.stringify({
        remoteJid: retry.remoteJid, id: retry.id, fromMe: retry.fromMe,
        participant: retry.participant || undefined, mediaKey: retry.mediaKey.toString('base64'),
      }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 503 || res.status === 404) return 'down';
  if (!res.ok || !body.ok || typeof body.url !== 'string') {
    if (res.status === 502 && body.status) { // o celular respondeu que não tem
      reFailed().set(hash, retry.id);
      saveReFailed();
      return 'fail';
    }
    return 'later';
  }
  const got = await fetchDecrypted(body.url, retry.mediaKey, hash, null);
  if (!got.plain || !isWebp(got.plain)) {
    if (got.gone || got.plain) {
      reFailed().set(hash, retry.id);
      saveReFailed();
      return 'fail';
    }
    return 'later';
  }
  try {
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile(hash), got.plain, { mode: 0o600 });
  } catch (e) { /* fica só na memória */ }
  loaded.set(hash, got.plain);
  failed.delete(hash);
  return 'ok';
}

async function runReupload() {
  reRunning = true;
  try {
    while (reQueue.size) {
      const [hash, retry] = reQueue.entries().next().value;
      const r = await reuploadOne(hash, retry);
      reQueue.delete(hash);
      if (r === 'ok') scanCache = null; // a próxima varredura já inclui
      if (r === 'down') {
        reQueue.clear();
        break;
      }
      await sleep(Number(process.env.WHATSAPP_REUPLOAD_GAP_MS || 300));
    }
  } finally {
    reRunning = false;
  }
}

function enqueueReupload(hash, retry) {
  if (!retry || !HASH_RE.test(hash || '') || reQueue.has(hash) || reFailed().get(hash) === retry.id) return;
  if (!reuploadConfig()) return;
  reQueue.set(hash, retry);
  if (!reRunning) runReupload();
}

/** Quantas figurinhas estão sendo buscadas no celular agora. */
function recovering() {
  return reQueue.size;
}

// Grupos, nessa ordem na tela: favoritas (ordem do WhatsApp), as que a
// pessoa mandou em conversas e as que ela recebeu (da mais recente pra mais
// antiga). Cada figurinha aparece uma vez só, no primeiro grupo em que cabe.
const GROUPS = ['fav', 'mine', 'chat'];

async function doScan() {
  const favs = (await listFavorites()).filter((f) => !f.isLottie);
  const locals = await localFiles();
  const chats = await chatStickers();
  const favHashes = new Set(favs.map((f) => f.hash));
  const entries = favs.map((fav) => ({ group: 'fav', fav, ts: fav.ts }));
  const mine = [];
  const recv = [];
  for (const [hash, c] of chats) {
    if (favHashes.has(hash)) continue;
    (c.fromMe ? mine : recv).push({ group: c.fromMe ? 'mine' : 'chat', fav: { hash }, ts: c.ts });
  }
  entries.push(...mine, ...recv);
  const found = new Array(entries.length).fill(null);
  // Downloads em paralelo: os links expirados respondem rápido, mas um por
  // um somaria muito com quase 2 mil figurinhas nas conversas.
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const buf = await loadFavorite(entries[i].fav, locals, chats);
      if (buf && isWebp(buf)) found[i] = buf;
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  const items = [];
  const groups = {};
  for (const g of GROUPS) groups[g] = { total: 0, missing: 0 };
  entries.forEach((e, i) => {
    groups[e.group].total += 1;
    if (!found[i]) {
      groups[e.group].missing += 1;
      // As da pessoa (favoritas e mandadas) o celular pode mandar de novo.
      if (e.group !== 'chat') {
        const chat = chats.get(e.fav.hash);
        if (chat && chat.retry) enqueueReupload(e.fav.hash, chat.retry);
      }
      return;
    }
    items.push({
      key: crypto.createHash('sha256').update(found[i]).digest('hex'),
      ts: e.ts,
      group: e.group,
      buffer: found[i],
    });
  });
  return { items, total: entries.length, missing: entries.length - items.length, groups };
}

/**
 * { items: [{ key (sha256 hex), ts, group, buffer }], total, missing,
 *   groups: { fav|mine|chat: { total, missing } } }, por grupo e, dentro
 * dele, da mais recente pra mais antiga. fresh: true ignora o que está guardado (abrir a
 * tela de escolha ou tocar em Atualizar), pra pegar figurinha que acabou de
 * chegar numa conversa. As prévias e a importação usam o guardado.
 */
async function scan({ fresh = false } = {}) {
  const sig = scanSig();
  if (!fresh && scanCache && scanCache.sig === sig && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.result;
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

module.exports = { enabled, listFavorites, localFiles, chatStickers, loadFavorite, decryptMedia, parseFavorite, parseMediaKeyBlob, scan, recovering };
