'use strict';

// Cada pessoa da conversa conecta o PRÓPRIO WhatsApp pra importar as
// figurinhas DELA. O que ela importa vai pra coleção dos dois
// (data.stickers, compartilhada) - só a conexão é por pessoa.
//
// A pessoa é identificada como em todo o resto do chat: pelo nome
// (prefsKey, sem diferenciar maiúsculas). Dois jeitos de conectar:
//
//  - "mac": o número é o mesmo do WhatsApp deste Mac (o do Bot de
//    Figurinhas). Pra provar que é a pessoa, o bot manda um código de 6
//    dígitos pra conversa "Você" dela. A fonte das figurinhas continua a de
//    antes (lib/whatsapp-favorites.js: bancos do WhatsApp do Mac + reenvio
//    pelo bot), só que agora só quem confirmou o número vê.
//  - "device": qualquer outro número. O servidor vira um aparelho conectado
//    daquele WhatsApp (Baileys, igual ao WhatsApp Web), pareado com o código
//    de 8 letras que a pessoa digita no celular. A lista de favoritas vem da
//    sincronização do app (a mesma ação favoriteSticker que o Mac guarda) e
//    as que ela mandou/recebeu, do histórico que o celular manda ao
//    conectar e das mensagens novas enquanto a conexão está aberta. Link
//    expirado: pede ao celular pra subir de novo (como o bot faz na v50).
//
// Tudo da conexão (chaves do WhatsApp, lista de figurinhas, quem conectou o
// quê) fica em data/wa-links, CIFRADO com a chave da conversa, igual às
// mensagens: sem o código de acesso ninguém lê nem reconecta. Por isso a
// conexão só sobe com alguém já dentro da conversa (depois de reiniciar o
// servidor, quando a pessoa abre a tela do WhatsApp) e cai sozinha depois de
// um tempo sem uso - as chaves ficam guardadas pra reconectar sem parear de
// novo.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { encryptBuffer, decryptBuffer, randomId } = require('./crypto');
const waFavorites = require('./whatsapp-favorites');

const IDLE_MS = Number(process.env.WHATSAPP_LINK_IDLE_MS || 15 * 60 * 1000);
const SYNC_GRACE_MS = Number(process.env.WHATSAPP_SYNC_GRACE_MS || 90 * 1000);
const SCAN_TTL_MS = 10 * 60 * 1000;
const MAX_MSG_STICKERS = 6000;
const CODE_TTL_MS = 10 * 60 * 1000;
const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;
const PATCH_NAMES = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular', 'regular_low'];

let dataDir = null;
function init(opts) {
  dataDir = opts.dataDir;
}
function linksDir() {
  return path.join(dataDir, 'wa-links');
}

function userError(message) {
  const e = new Error(message);
  e.user = true;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, message) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message || 'tempo esgotado')), ms); })])
    .finally(() => clearTimeout(t));
}

// ---- Números ----
// Digitado com ou sem 55; no Brasil o WhatsApp às vezes guarda o número sem
// o 9 da frente (ex.: 5583 8888-7777), então pra comparar vale DDD + 8 finais.
function normNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d;
}
function sameNumber(a, b) {
  const x = normNumber(a);
  const y = normNumber(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.startsWith('55') && y.startsWith('55') && x.length >= 12 && y.length >= 12) {
    return x.slice(2, 4) === y.slice(2, 4) && x.slice(-8) === y.slice(-8);
  }
  return false;
}
function maskNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length < 6) return '';
  if (d.startsWith('55') && d.length >= 12) return `+55 ${d.slice(2, 4)} •••••-${d.slice(-4)}`;
  return `+${d.slice(0, 2)} ••••-${d.slice(-4)}`;
}

// ---- Índice cifrado: quem conectou o quê ----
// { [who]: { kind: 'mac'|'device', id?, number, name, at } }
let indexCache = null;
function indexFile() {
  return path.join(linksDir(), 'index.enc');
}
function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readIndex(key) {
  if (indexCache) return indexCache;
  let blob;
  try {
    blob = fs.readFileSync(indexFile());
  } catch (e) {
    indexCache = {};
    return indexCache;
  }
  indexCache = JSON.parse(decryptBuffer(key, blob).toString('utf8'));
  return indexCache;
}
function writeIndex(key, idx) {
  atomicWrite(indexFile(), encryptBuffer(key, Buffer.from(JSON.stringify(idx))));
  indexCache = idx;
}
function setRecord(key, who, rec) {
  const idx = { ...readIndex(key) };
  if (rec) idx[who] = rec;
  else delete idx[who];
  writeIndex(key, idx);
}

function getRecord(key, who) {
  const rec = readIndex(key)[who];
  return rec && typeof rec === 'object' ? rec : null;
}

// ---- Baileys (opcional) ----
let baileysP = null;
function loadBaileys() {
  if (!baileysP) {
    const spec = process.env.WHATSAPP_BAILEYS_MODULE ? pathToFileURL(process.env.WHATSAPP_BAILEYS_MODULE).href : 'baileys';
    baileysP = import(spec).catch((e) => {
      baileysP = null;
      throw e;
    });
  }
  return baileysP;
}
let deviceOk = null;
function deviceAvailable() {
  if (deviceOk === null) {
    if (process.env.WHATSAPP_BAILEYS_MODULE) deviceOk = fs.existsSync(process.env.WHATSAPP_BAILEYS_MODULE);
    else {
      deviceOk = false;
      const extra = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
      for (const base of [...module.paths, ...extra]) {
        if (fs.existsSync(path.join(base, 'baileys', 'package.json'))) {
          deviceOk = true;
          break;
        }
      }
    }
  }
  return deviceOk;
}

function enabled() {
  return process.env.WHATSAPP_IMPORT === '1' && (deviceAvailable() || waFavorites.enabled());
}

// ---- Dono do WhatsApp do Mac (pelo Bot de Figurinhas) ----
function botUrl(route) {
  const cfg = waFavorites.reuploadConfig();
  if (!cfg) return null;
  try {
    return { url: new URL(route, cfg.url).href, token: cfg.token };
  } catch (e) {
    return null;
  }
}
async function botCall(route, body) {
  const b = botUrl(route);
  if (!b) return null;
  try {
    const res = await withTimeout(fetch(b.url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-token': b.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), 20000);
    const json = await res.json().catch(() => ({}));
    return res.ok && json.ok ? json : null;
  } catch (e) {
    return null;
  }
}
let ownerCache = null;
async function macOwnerNumber() {
  if (!waFavorites.enabled()) return null;
  if (ownerCache && Date.now() - ownerCache.at < 60000) return ownerCache.number;
  const r = await botCall('eu');
  const number = r && typeof r.numero === 'string' ? normNumber(r.numero) : null;
  if (number) ownerCache = { at: Date.now(), number };
  return number;
}

// Códigos de confirmação em andamento (só em memória).
const codes = new Map(); // who -> { code, exp, tries, number, name }
const codeSentAt = [];   // pra não virar spam no celular do dono do Mac

async function sendMacCode(who, name, number) {
  const now = Date.now();
  const prev = codes.get(who);
  if (prev && now - (prev.exp - CODE_TTL_MS) < 30000) throw userError('Acabei de mandar um código. Espere uns segundos antes de pedir outro.');
  while (codeSentAt.length && now - codeSentAt[0] > 3600000) codeSentAt.shift();
  if (codeSentAt.length >= 6) throw userError('Muitos códigos pedidos. Tente de novo daqui a pouco.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const r = await botCall('mandar-codigo', { codigo: code });
  if (!r) throw userError('Não consegui mandar o código agora (o Bot de Figurinhas está desligado?).');
  codeSentAt.push(now);
  codes.set(who, { code, exp: now + CODE_TTL_MS, tries: 0, number, name });
}

function verifyCode(key, who, typed) {
  const c = codes.get(who);
  if (!c || Date.now() > c.exp) {
    codes.delete(who);
    throw userError('O código expirou. Peça outro.');
  }
  c.tries += 1;
  const a = Buffer.from(String(typed || '').replace(/\D/g, ''));
  const b = Buffer.from(c.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    if (c.tries >= 5) {
      codes.delete(who);
      throw userError('Código errado de novo. Peça outro.');
    }
    throw userError('Código errado. Confira na conversa “Você” do seu WhatsApp.');
  }
  codes.delete(who);
  setRecord(key, who, { kind: 'mac', number: c.number, name: c.name, at: Date.now() });
}

// ---- Aparelho conectado (Baileys) ----
const devices = new Map();   // who -> dev
const loggedOut = new Map(); // who -> quando o WhatsApp desconectou (pra avisar uma vez)
let versionP = null;

function blobFile(id) {
  return path.join(linksDir(), `${id}.enc`);
}
function cacheDirOf(id) {
  return path.join(linksDir(), id);
}

function newDev(fields) {
  return {
    sock: null,
    connecting: null,
    open: false,
    openedAt: 0,
    appStateAt: 0,
    appStateRunning: false,
    historyDone: false,
    firstPair: false,
    wantPairing: false,
    pairingRequested: false,
    pairingCode: null,
    pairingWaiter: null,
    pairingExpired: false,
    closing: false,
    retries: 0,
    lastUse: Date.now(),
    idleTimer: null,
    saveTimer: null,
    catalog: { favs: new Map(), msgs: new Map() },
    version: 0,
    loaded: new Map(),
    failed: new Map(),
    reFailed: new Map(),
    reQueue: new Map(),
    reRunning: false,
    scanCache: null,
    scanRunning: null,
    ...fields,
  };
}

function toMs(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'object' ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
const buf = (v) => (v && v.length ? Buffer.from(v) : null);

function paired(dev) {
  return !!(dev.auth && dev.auth.creds && dev.auth.creds.account);
}

function changed(dev) {
  dev.version += 1;
  scheduleSave(dev);
}

function scheduleSave(dev) {
  if (!paired(dev) || dev.unlinked) return;
  clearTimeout(dev.saveTimer);
  dev.saveTimer = setTimeout(() => saveDev(dev), 1500);
}

async function saveDev(dev) {
  clearTimeout(dev.saveTimer);
  dev.saveTimer = null;
  if (!paired(dev) || dev.unlinked) return;
  try {
    const B = await loadBaileys();
    // Limita as figurinhas de conversa guardadas: sai primeiro a recebida
    // mais antiga.
    if (dev.catalog.msgs.size > MAX_MSG_STICKERS) {
      const sorted = [...dev.catalog.msgs.entries()].sort((a, b) => (a[1].fromMe - b[1].fromMe) || (a[1].ts - b[1].ts));
      for (const [h] of sorted.slice(0, dev.catalog.msgs.size - MAX_MSG_STICKERS)) dev.catalog.msgs.delete(h);
    }
    const obj = {
      v: 1,
      number: dev.number,
      name: dev.name,
      creds: dev.auth.creds,
      keys: dev.auth.keys,
      favs: [...dev.catalog.favs.values()],
      msgs: [...dev.catalog.msgs.entries()],
      reFailed: Object.fromEntries(dev.reFailed),
    };
    atomicWrite(blobFile(dev.id), encryptBuffer(dev.key, Buffer.from(JSON.stringify(obj, B.BufferJSON.replacer))));
  } catch (e) {
    console.error('whatsapp: não consegui guardar a conexão:', e.message);
  }
}

async function loadDev(key, who, rec) {
  const B = await loadBaileys();
  const obj = JSON.parse(decryptBuffer(key, fs.readFileSync(blobFile(rec.id))).toString('utf8'), B.BufferJSON.reviver);
  const dev = newDev({ who, id: rec.id, key, number: rec.number, name: rec.name, auth: { creds: obj.creds, keys: obj.keys || {} } });
  for (const f of obj.favs || []) if (f && f.hash) dev.catalog.favs.set(f.hash, f);
  for (const [h, m] of obj.msgs || []) if (h && m) dev.catalog.msgs.set(h, m);
  for (const [h, id] of Object.entries(obj.reFailed || {})) dev.reFailed.set(h, id);
  return dev;
}

// Guarda das chaves do WhatsApp em memória (o Baileys põe a transação por
// cima); vai pro disco cifrado junto com o resto, em saveDev.
function keyStore(dev, B) {
  return {
    get: async (type, ids) => {
      const t = dev.auth.keys[type] || {};
      const out = {};
      for (const id of ids) {
        let v = t[id];
        if (v === undefined || v === null) continue;
        if (type === 'app-state-sync-key') v = B.proto.Message.AppStateSyncKeyData.fromObject(v);
        out[id] = v;
      }
      return out;
    },
    set: async (data) => {
      for (const type of Object.keys(data)) {
        if (!dev.auth.keys[type]) dev.auth.keys[type] = {};
        for (const id of Object.keys(data[type])) {
          const v = data[type][id];
          if (v) dev.auth.keys[type][id] = v;
          else delete dev.auth.keys[type][id];
        }
      }
      scheduleSave(dev);
    },
  };
}

// O Baileys não entende a ação "favoriteSticker" da sincronização e só a
// registra no log como "unprocessable update" - é por aí que a pegamos.
function makeLogger(dev) {
  const noop = () => {};
  const logger = {
    level: 'debug',
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug(obj, msg) {
      if (msg === 'unprocessable update' && obj && obj.syncAction) onSyncAction(dev, obj.syncAction);
    },
    child() {
      return logger;
    },
  };
  return logger;
}

// Favoritas: index ["favoriteSticker", sha256 do arquivo em base64];
// isFavorite false = tirou das favoritas.
function onSyncAction(dev, mutation) {
  try {
    const idx = mutation.index || [];
    if (idx[0] !== 'favoriteSticker') return;
    const hash = String(idx[1] || '');
    if (!HASH_RE.test(hash)) return;
    const value = (mutation.syncAction && mutation.syncAction.value) || {};
    const sa = value.stickerAction;
    if (!sa || sa.isFavorite === false || sa.isLottie || sa.mimetype === 'application/was') {
      if (dev.catalog.favs.delete(hash)) changed(dev);
      return;
    }
    dev.catalog.favs.set(hash, {
      hash,
      ts: toMs(value.timestamp),
      url: sa.url || '',
      directPath: sa.directPath || '',
      mediaKey: buf(sa.mediaKey),
      fileEncSha256: buf(sa.fileEncSha256),
    });
    changed(dev);
  } catch (e) { /* ação estranha: ignora */ }
}

// Figurinha numa mensagem (histórico ou nova): guarda a cópia mais recente
// (link, chave e a mensagem, pra pedir reenvio) e se a pessoa já mandou.
function collectMessage(dev, B, msg) {
  if (!msg || !msg.message || !msg.key) return false;
  let content;
  try {
    content = B.normalizeMessageContent(msg.message);
  } catch (e) {
    return false;
  }
  const st = content && content.stickerMessage;
  if (!st || !st.fileSha256 || !st.mediaKey) return false;
  if (st.isLottie || st.mimetype === 'application/was') return false;
  const hash = Buffer.from(st.fileSha256).toString('base64');
  if (!HASH_RE.test(hash)) return false;
  const ts = toMs(msg.messageTimestamp) * 1000;
  const fromMe = !!msg.key.fromMe;
  const prev = dev.catalog.msgs.get(hash);
  const entry = prev || { fromMe: false, ts: -1 };
  if (fromMe) entry.fromMe = true;
  if (ts >= entry.ts) {
    entry.ts = ts;
    entry.url = st.url || '';
    entry.directPath = st.directPath || '';
    entry.mediaKey = Buffer.from(st.mediaKey);
    entry.encSha = buf(st.fileEncSha256);
    entry.key = {
      remoteJid: msg.key.remoteJid,
      id: msg.key.id,
      fromMe,
      ...(msg.key.participant ? { participant: msg.key.participant } : {}),
    };
  }
  dev.catalog.msgs.set(hash, entry);
  return true;
}

async function ensureAppState(dev) {
  if (!dev.sock || !dev.open || dev.appStateRunning || !dev.auth.creds.myAppStateKeyId) return;
  dev.appStateRunning = true;
  const sock = dev.sock;
  try {
    const B = await loadBaileys();
    await withTimeout(sock.resyncAppState(B.ALL_WA_PATCH_NAMES || PATCH_NAMES, false), 120000);
    if (dev.sock === sock) dev.appStateAt = Date.now();
    changed(dev);
  } catch (e) {
    console.error('whatsapp: sincronização das favoritas falhou:', e.message);
  } finally {
    dev.appStateRunning = false;
  }
}

function touch(dev) {
  dev.lastUse = Date.now();
  clearTimeout(dev.idleTimer);
  dev.idleTimer = setTimeout(() => {
    if (Date.now() - dev.lastUse < IDLE_MS - 1000) return touch(dev);
    // Ninguém usando: fecha (as chaves ficam guardadas). Pareamento que
    // não terminou é descartado.
    closeSock(dev);
    if (!paired(dev) && devices.get(dev.who) === dev) devices.delete(dev.who);
  }, IDLE_MS);
  if (dev.idleTimer.unref) dev.idleTimer.unref();
}

function closeSock(dev) {
  if (!dev.sock) return;
  dev.closing = true;
  try {
    dev.sock.end(undefined);
  } catch (e) { /* já caiu */ }
}

async function connect(dev) {
  if (dev.sock || dev.connecting) return dev.connecting;
  dev.connecting = (async () => {
    const B = await loadBaileys();
    if (!versionP) {
      versionP = B.fetchLatestBaileysVersion
        ? withTimeout(B.fetchLatestBaileysVersion(), 5000).then((r) => r.version).catch(() => undefined)
        : Promise.resolve(undefined);
    }
    const version = await versionP;
    const makeWASocket = typeof B.default === 'function' ? B.default : B.makeWASocket;
    dev.closing = false;
    dev.open = false;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: dev.auth.creds, keys: keyStore(dev, B) },
      logger: makeLogger(dev),
      browser: B.Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    dev.sock = sock;
    wire(dev, sock, B);
    touch(dev);
  })().finally(() => {
    dev.connecting = null;
  });
  return dev.connecting;
}

function wire(dev, sock, B) {
  sock.ev.on('creds.update', (update) => {
    if (dev.sock !== sock) return;
    scheduleSave(dev);
    if (update && (update.accountSyncCounter || update.myAppStateKeyId)) ensureAppState(dev);
  });

  sock.ev.on('connection.update', async (u) => {
    if (dev.sock !== sock) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr && !paired(dev)) {
      if (!dev.wantPairing || dev.pairingRequested) return;
      dev.pairingRequested = true;
      const waiter = dev.pairingWaiter;
      try {
        const raw = await sock.requestPairingCode(dev.number);
        dev.pairingCode = String(raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
        dev.pairingAt = Date.now();
        if (waiter) waiter.resolve(dev.pairingCode);
      } catch (e) {
        if (waiter) waiter.reject(e);
      }
      return;
    }
    if (u.isNewLogin) {
      dev.firstPair = true;
      scheduleSave(dev);
    }
    if (connection === 'open') {
      dev.open = true;
      dev.openedAt = Date.now();
      dev.retries = 0;
      dev.wantPairing = false;
      dev.pairingCode = null;
      if (dev.pendingRecord) {
        // Pareou agora: guarda a conexão e marca a pessoa como conectada.
        const me = String((dev.auth.creds.me && dev.auth.creds.me.id) || '').split(':')[0].split('@')[0];
        dev.number = normNumber(me) || dev.number;
        dev.pendingRecord = false;
        await saveDev(dev);
        try {
          setRecord(dev.key, dev.who, { kind: 'device', id: dev.id, number: dev.number, name: dev.name, at: Date.now() });
        } catch (e) {
          console.error('whatsapp: não consegui registrar a conexão:', e.message);
        }
      }
      if ((dev.auth.creds.accountSyncCounter || 0) > 0 || !dev.firstPair) ensureAppState(dev);
      return;
    }
    if (connection === 'close') {
      dev.sock = null;
      dev.open = false;
      const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      if (dev.unlinked) return;
      if (status === B.DisconnectReason.loggedOut && paired(dev)) {
        // Tiraram o aparelho no celular (ou o WhatsApp derrubou): esquece tudo.
        forgetDevice(dev);
        loggedOut.set(dev.who, Date.now());
        return;
      }
      if (status === B.DisconnectReason.restartRequired) {
        // Normal logo depois de parear.
        connect(dev).catch(() => {});
        return;
      }
      if (!paired(dev)) {
        // Pareamento não terminou (o código vence em uns minutos).
        dev.pairingExpired = true;
        if (dev.pairingWaiter) dev.pairingWaiter.reject(new Error('fechou'));
        return;
      }
      if (dev.closing) return;
      if (dev.retries < 5 && Date.now() - dev.lastUse < IDLE_MS) {
        dev.retries += 1;
        setTimeout(() => {
          if (!dev.sock && !dev.unlinked && devices.get(dev.who) === dev) connect(dev).catch(() => {});
        }, 2000 * dev.retries);
      }
    }
  });

  sock.ev.on('messaging-history.set', (h) => {
    if (dev.sock !== sock) return;
    let any = false;
    for (const m of (h && h.messages) || []) if (collectMessage(dev, B, m)) any = true;
    if (h && (h.isLatest || h.progress === 100)) dev.historyDone = true;
    if (any) changed(dev);
  });
  sock.ev.on('messaging-history.status', (s) => {
    if (dev.sock === sock && s && (s.status === 'complete' || s.status === 'paused')) dev.historyDone = true;
  });
  sock.ev.on('messages.upsert', (u) => {
    if (dev.sock !== sock) return;
    let any = false;
    for (const m of (u && u.messages) || []) if (collectMessage(dev, B, m)) any = true;
    if (any) changed(dev);
  });
}

function forgetDevice(dev) {
  dev.unlinked = true;
  clearTimeout(dev.saveTimer);
  clearTimeout(dev.idleTimer);
  if (devices.get(dev.who) === dev) devices.delete(dev.who);
  try {
    const idx = readIndex(dev.key);
    if (idx[dev.who] && idx[dev.who].id === dev.id) setRecord(dev.key, dev.who, null);
  } catch (e) { /* índice ilegível: fica como está */ }
  removeDeviceFiles(dev.id);
}

function removeDeviceFiles(id) {
  if (!id || !/^[0-9a-f]+$/.test(id)) return;
  try { fs.rmSync(blobFile(id), { force: true }); } catch (e) { /* já foi */ }
  try { fs.rmSync(cacheDirOf(id), { recursive: true, force: true }); } catch (e) { /* já foi */ }
}

// Conexão viva da pessoa (sobe se precisar). null se ela não tem aparelho.
async function ensureDevice(key, who) {
  const rec = getRecord(key, who);
  if (!rec || rec.kind !== 'device') return null;
  let dev = devices.get(who);
  if (!dev || dev.id !== rec.id) {
    dev = await loadDev(key, who, rec);
    devices.set(who, dev);
  }
  touch(dev);
  if (!dev.sock && !dev.connecting) {
    dev.retries = 0;
    connect(dev).catch((e) => {
      dev.connectError = e.message;
    });
  }
  return dev;
}

async function startPairing(key, who, name, number) {
  if (!deviceAvailable()) throw userError('Este servidor não consegue conectar outro WhatsApp (falta instalar o Baileys).');
  const old = devices.get(who);
  if (old) {
    if (paired(old) && !old.unlinked) throw userError('Seu WhatsApp já está conectado.');
    old.unlinked = true;
    closeSock(old);
    devices.delete(who);
  }
  const B = await loadBaileys();
  const dev = newDev({
    who, id: randomId(12), key, name, number,
    auth: { creds: B.initAuthCreds(), keys: {} },
    wantPairing: true,
    pendingRecord: true,
  });
  devices.set(who, dev);
  const code = await withTimeout(new Promise((resolve, reject) => {
    dev.pairingWaiter = { resolve, reject };
    connect(dev).catch(reject);
  }), 30000, 'O WhatsApp não respondeu. Tente de novo.').catch((e) => {
    dev.unlinked = true;
    closeSock(dev);
    if (devices.get(who) === dev) devices.delete(who);
    throw userError(e.user ? e.message : 'Não consegui gerar o código agora. Confira o número e tente de novo.');
  });
  dev.pairingWaiter = null;
  return code;
}

function devState(dev) {
  if (!dev) return 'connecting';
  if (!dev.sock || !dev.open) return dev.connectError && !dev.connecting ? 'offline' : 'connecting';
  const young = Date.now() - dev.openedAt < SYNC_GRACE_MS;
  if (young && (!dev.appStateAt || (dev.firstPair && !dev.historyDone))) return 'syncing';
  return 'ready';
}

// ---- Varredura (mesmo formato de whatsapp-favorites.scan) ----
function readCache(dev, hash) {
  try {
    const plain = decryptBuffer(dev.key, fs.readFileSync(path.join(cacheDirOf(dev.id), `${Buffer.from(hash, 'base64').toString('hex')}.enc`)));
    return crypto.createHash('sha256').update(plain).digest('base64') === hash ? plain : null;
  } catch (e) {
    return null;
  }
}
function writeCache(dev, hash, plain) {
  if (dev.unlinked) return;
  try {
    atomicWrite(path.join(cacheDirOf(dev.id), `${Buffer.from(hash, 'base64').toString('hex')}.enc`), encryptBuffer(dev.key, plain));
  } catch (e) { /* fica só na memória */ }
}

function fullUrl(directPath) {
  return `${waFavorites.mediaBase()}${directPath.startsWith('/') ? '' : '/'}${directPath}`;
}

async function loadSticker(dev, hash, fav, keep) {
  if (dev.loaded.has(hash)) return dev.loaded.get(hash);
  const cached = readCache(dev, hash);
  if (cached) {
    dev.loaded.set(hash, cached);
    return cached;
  }
  const m = dev.catalog.msgs.get(hash);
  const tries = [];
  if (m && m.mediaKey) {
    if (m.directPath) tries.push([fullUrl(m.directPath), m.mediaKey, m.encSha]);
    if (m.url && !process.env.WHATSAPP_MEDIA_BASE) tries.push([m.url, m.mediaKey, m.encSha]);
  }
  if (fav && fav.mediaKey) {
    if (fav.directPath) tries.push([fullUrl(fav.directPath), fav.mediaKey, fav.fileEncSha256]);
    if (fav.url && !process.env.WHATSAPP_MEDIA_BASE) tries.push([fav.url, fav.mediaKey, fav.fileEncSha256]);
  }
  const sig = tries.map((t) => t[0]).join(' ');
  if (!tries.length || dev.failed.get(hash) === sig) return null;
  let transient = false;
  for (const [url, mk, encSha] of tries) {
    const got = await waFavorites.fetchDecrypted(url, mk, hash, encSha);
    if (got.plain) {
      if (!waFavorites.isWebp(got.plain)) break;
      dev.loaded.set(hash, got.plain);
      dev.failed.delete(hash);
      if (keep) writeCache(dev, hash, got.plain);
      return got.plain;
    }
    if (!got.gone) transient = true;
  }
  if (!transient) dev.failed.set(hash, sig);
  return null;
}

// Link expirado: pede ao celular pra subir de novo a mídia da mensagem mais
// recente com essa figurinha. Só pras da pessoa (favoritas e mandadas).
function enqueueReupload(dev, hash) {
  const m = dev.catalog.msgs.get(hash);
  if (!m || !m.key || !m.mediaKey || dev.reQueue.has(hash) || dev.reFailed.get(hash) === m.key.id) return;
  dev.reQueue.set(hash, m);
  if (!dev.reRunning) runReupload(dev);
}

async function runReupload(dev) {
  dev.reRunning = true;
  try {
    while (dev.reQueue.size && !dev.unlinked) {
      if (!dev.sock || !dev.open) {
        // Espera a conexão (sobe quando alguém está usando) por até 30 s.
        const start = Date.now();
        while ((!dev.sock || !dev.open) && Date.now() - start < 30000 && !dev.unlinked) await sleep(500);
        if (!dev.sock || !dev.open) {
          dev.reQueue.clear();
          break;
        }
      }
      const [hash, m] = dev.reQueue.entries().next().value;
      let result = 'later';
      try {
        const r = await withTimeout(dev.sock.updateMediaMessage({
          key: { ...m.key },
          message: { stickerMessage: { mediaKey: m.mediaKey, directPath: m.directPath || '', url: m.url || '', mimetype: 'image/webp' } },
        }), 20000);
        const st = r && r.message && r.message.stickerMessage;
        const url = st && (st.directPath ? fullUrl(st.directPath) : st.url);
        if (url) {
          const got = await waFavorites.fetchDecrypted(url, m.mediaKey, hash, null);
          if (got.plain && waFavorites.isWebp(got.plain)) {
            dev.loaded.set(hash, got.plain);
            dev.failed.delete(hash);
            writeCache(dev, hash, got.plain);
            m.directPath = st.directPath || m.directPath;
            m.url = st.url || m.url;
            dev.scanCache = null;
            result = 'ok';
          } else if (got.gone || got.plain) result = 'fail';
        }
      } catch (e) {
        const code = e && e.output && e.output.statusCode;
        if (code) result = 'fail'; // o celular respondeu que não tem
      }
      if (result === 'fail') {
        dev.reFailed.set(hash, m.key.id);
        scheduleSave(dev);
      }
      dev.reQueue.delete(hash);
      await sleep(Number(process.env.WHATSAPP_REUPLOAD_GAP_MS || 300));
    }
  } finally {
    dev.reRunning = false;
  }
}

async function doScan(dev) {
  const favs = [...dev.catalog.favs.values()].sort((a, b) => b.ts - a.ts);
  const favHashes = new Set(favs.map((f) => f.hash));
  const entries = favs.map((fav) => ({ group: 'fav', hash: fav.hash, fav, ts: fav.ts }));
  const mine = [];
  const recv = [];
  for (const [hash, m] of dev.catalog.msgs) {
    if (favHashes.has(hash)) continue;
    (m.fromMe ? mine : recv).push({ group: m.fromMe ? 'mine' : 'chat', hash, ts: m.ts });
  }
  mine.sort((a, b) => b.ts - a.ts);
  recv.sort((a, b) => b.ts - a.ts);
  entries.push(...mine, ...recv);
  const found = new Array(entries.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      found[i] = await loadSticker(dev, e.hash, e.fav, e.group !== 'chat');
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  const items = [];
  const groups = { fav: { total: 0, missing: 0 }, mine: { total: 0, missing: 0 }, chat: { total: 0, missing: 0 } };
  entries.forEach((e, i) => {
    groups[e.group].total += 1;
    if (!found[i]) {
      groups[e.group].missing += 1;
      if (e.group !== 'chat') enqueueReupload(dev, e.hash);
      return;
    }
    items.push({ key: crypto.createHash('sha256').update(found[i]).digest('hex'), ts: e.ts, group: e.group, buffer: found[i] });
  });
  return { items, total: entries.length, missing: entries.length - items.length, groups };
}

async function scanDevice(dev, fresh) {
  touch(dev);
  const sig = dev.version;
  const c = dev.scanCache;
  if (!fresh && c && c.sig === sig && Date.now() - c.at < SCAN_TTL_MS) return c.result;
  if (!dev.scanRunning) {
    dev.scanRunning = doScan(dev)
      .then((result) => {
        dev.scanCache = { sig, at: Date.now(), result };
        return result;
      })
      .finally(() => {
        dev.scanRunning = null;
      });
  }
  return dev.scanRunning;
}

// ---- O que o servidor usa ----

/**
 * Fonte das figurinhas de uma pessoa: { kind, scan({fresh}), recovering(),
 * syncing } ou null se ela ainda não conectou o WhatsApp dela.
 */
async function sourceFor(key, who) {
  const rec = getRecord(key, who);
  if (!rec) return null;
  if (rec.kind === 'mac') {
    if (!waFavorites.enabled()) return null;
    return { kind: 'mac', scan: (o) => waFavorites.scan(o), recovering: () => waFavorites.recovering(), syncing: false };
  }
  if (rec.kind !== 'device') return null;
  const dev = await ensureDevice(key, who);
  if (!dev) return null;
  return {
    kind: 'device',
    scan: (o) => scanDevice(dev, !!(o && o.fresh)),
    recovering: () => dev.reQueue.size,
    syncing: devState(dev) !== 'ready',
  };
}

async function status(key, who) {
  const rec = getRecord(key, who);
  if (!rec) {
    const dev = devices.get(who);
    if (dev && !paired(dev) && dev.pairingCode) {
      return { linked: false, pairing: { code: dev.pairingCode, expired: dev.pairingExpired || !dev.sock } };
    }
    if (dev && paired(dev) && dev.pendingRecord) return { linked: false, pairing: { done: true } };
    const c = codes.get(who);
    if (c && Date.now() < c.exp) return { linked: false, awaitingCode: true };
    const out = { linked: false };
    if (loggedOut.has(who)) {
      loggedOut.delete(who);
      out.loggedOut = true;
    }
    return out;
  }
  if (rec.kind === 'mac') {
    return { linked: true, kind: 'mac', number: maskNumber(rec.number), state: waFavorites.enabled() ? 'ready' : 'offline' };
  }
  const dev = await ensureDevice(key, who);
  return { linked: true, kind: 'device', number: maskNumber(rec.number), state: devState(dev) };
}

/** Começa a conexão: { method: 'code' } (código no "Você") ou { method: 'pairing', code }. */
async function startLink(key, who, name, rawNumber) {
  const number = normNumber(rawNumber);
  if (number.length < 10 || number.length > 15) throw userError('Digite o número com DDD (ex.: 83 99999-8888).');
  if (getRecord(key, who)) throw userError('Seu WhatsApp já está conectado.');
  const owner = await macOwnerNumber();
  if (owner && sameNumber(owner, number)) {
    await sendMacCode(who, name, owner);
    return { method: 'code' };
  }
  codes.delete(who);
  const code = await startPairing(key, who, name, number);
  return { method: 'pairing', code };
}

/** Desconecta: tira o aparelho do celular (se der) e apaga o que é dela. */
async function unlink(key, who) {
  const rec = getRecord(key, who);
  codes.delete(who);
  let dev = devices.get(who);
  if (!dev && rec && rec.kind === 'device') {
    try {
      dev = await ensureDevice(key, who);
      const start = Date.now();
      while (dev && (!dev.sock || !dev.open) && Date.now() - start < 10000) await sleep(300);
    } catch (e) {
      dev = null;
    }
  }
  let removedFromPhone = rec ? rec.kind === 'mac' : false;
  if (dev) {
    const sock = dev.sock;
    dev.unlinked = true;
    if (sock && dev.open && paired(dev)) {
      try {
        await withTimeout(sock.logout(), 8000);
        removedFromPhone = true;
      } catch (e) { /* tira manualmente no celular */ }
    }
    closeSock(dev);
    forgetDevice(dev);
  }
  if (rec) {
    setRecord(key, who, null);
    if (rec.kind === 'device') removeDeviceFiles(rec.id);
  }
  return { ok: true, removedFromPhone };
}

/** Cancela um pareamento ou código em andamento. */
function cancel(who) {
  codes.delete(who);
  const dev = devices.get(who);
  if (dev && !paired(dev)) {
    dev.unlinked = true;
    closeSock(dev);
    devices.delete(who);
  }
}

module.exports = {
  init, enabled, deviceAvailable, status, startLink, verifyCode, unlink, cancel, sourceFor,
  normNumber, sameNumber, maskNumber,
};
