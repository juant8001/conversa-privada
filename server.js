'use strict';

require('./lib/env')();

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { EventEmitter } = require('events');

const { Store, WrongCodeError } = require('./lib/store');
const auth = require('./lib/auth');
const { randomId } = require('./lib/crypto');

const PORT = parseInt(process.env.PORT || '4177', 10);
// Default fica em 127.0.0.1 (só a própria máquina). Setar HOST=0.0.0.0 expõe
// na rede local também — útil pra testar do celular pelo Wi-Fi, mas assume o
// mesmo risco de qualquer app na LAN sem esse limite.
const HOST = process.env.HOST || '127.0.0.1';
const ROOM_SLUG = process.env.ROOM_SLUG;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '300', 10);
// How long a "visualização única" photo/video stays visible after someone
// opens it. Configurable only so tests don't have to sleep 10 real
// seconds - production always gets the real default.
const EPHEMERAL_TTL_MS = parseInt(process.env.EPHEMERAL_TTL_MS || '10000', 10);
// Teto pra miniatura enviada pelo cliente. O canvas gera algo entre 20 e
// 60KB (400px, JPEG q0.72); 512KB é folga suficiente pra qualquer foto
// esquisita e ainda assim recusa alguém tentando usar o campo "thumb" pra
// guardar um arquivo grande de contrabando.
const MAX_THUMB_BYTES = 512 * 1024;

// Atalhos de reação padrão (a barra do menu de contexto). Cada pessoa pode
// trocar os seus - ficam em data.prefs (ver POST /api/prefs) - e reagir com
// qualquer outro emoji pelo "+" da barra. Mantém em sincronia com
// DEFAULT_QUICK_REACTIONS em public/app.js.
const DEFAULT_QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];
const QUICK_REACTIONS_COUNT = 6;

// Reação livre: aceita UM emoji qualquer (um grafema só), nunca texto. A
// regex cobre pictogramas, bandeiras (par de indicadores regionais), keycaps
// (1️⃣) e as sequências com ZWJ / tom de pele / seletor de variação.
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*$/u;
const graphemeSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
function isSingleEmoji(value) {
  if (typeof value !== 'string' || !value || value.length > 32) return false;
  if (!EMOJI_RE.test(value)) return false;
  if (!graphemeSegmenter) return true;
  let n = 0;
  for (const _ of graphemeSegmenter.segment(value)) { // eslint-disable-line no-unused-vars
    n += 1;
    if (n > 1) return false;
  }
  return n === 1;
}

// Coleção compartilhada de figurinhas e GIFs (data.stickers). Os limites
// existem pra coleção não virar um jeito de encher o disco sem querer.
const MAX_STICKER_BYTES = 3 * 1024 * 1024;
const MAX_GIF_BYTES = 20 * 1024 * 1024;
const MAX_LIBRARY_ITEMS = 600;

// Busca de GIF (opcional): só liga se houver GIPHY_API_KEY no .env. Tudo
// passa pelo servidor - a busca, as prévias e o download do GIF escolhido -
// então o navegador de quem está no chat nunca fala direto com o GIPHY.
const GIPHY_API_KEY = (process.env.GIPHY_API_KEY || '').trim();
const GIPHY_API_BASE = (process.env.GIPHY_API_BASE || 'https://api.giphy.com').replace(/\/$/, '');
const GIPHY_RATING = process.env.GIPHY_RATING || 'r';
// Só existe pra teste: quando GIPHY_API_BASE aponta pra um servidor falso,
// as "mídias" dele vêm da mesma origem em vez de *.giphy.com.
const GIPHY_EXTRA_ORIGIN = process.env.GIPHY_API_BASE ? new URL(GIPHY_API_BASE).origin : null;
const GIF_PREVIEW_MAX_BYTES = 6 * 1024 * 1024;

// Códigos e frases opcionais vêm sempre do .env, nunca do código (o
// repositório é público). Sem a variável, o recurso fica desligado.
const ALT_CODE = process.env.ALT_CODE || '';
const HERMES_TRIGGER = process.env.HERMES_TRIGGER || '';
// Código de entrada do Hermes: digitado na tela de entrada NO LUGAR do código
// do chat, abre uma conversa direta com o Hermes Agent deste Mac - sem abrir
// o chat. Quem entra assim ganha uma sessão à parte (cookie próprio, sem a
// chave da conversa) que só serve pra rota /api/hermes: nenhuma rota do chat
// aceita essa sessão. Menos de 8 caracteres = desligado.
const HERMES_CODE = (process.env.HERMES_CODE || '').length >= 8 ? process.env.HERMES_CODE : '';
const HERMES_COOKIE = 'pc_hermes';
const HERMES_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const hermesGuests = new Map(); // token -> criado em (só em memória, some no restart)
// O cliente compara o que foi digitado com este hash (sal novo a cada
// start do processo), então o gatilho em si nunca viaja pro navegador.
const HERMES_SALT = crypto.randomBytes(16).toString('hex');
const HERMES_HASH = HERMES_TRIGGER
  ? crypto.createHash('sha256').update(`${HERMES_SALT}:${HERMES_TRIGGER}`).digest('hex')
  : null;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

if (!ROOM_SLUG || ROOM_SLUG.length < 16) {
  console.error('ROOM_SLUG ausente ou muito curto. Configure um valor aleatorio e longo em .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(DATA_DIR);
const bus = new EventEmitter();
bus.setMaxListeners(50);

// In-memory only, by design (same spirit as sessions - "invalida a cada
// restart do processo"): messageId -> pending setTimeout that will expire
// a viewed ephemeral media. Lost on restart, but reconcileEphemeral() (see
// loadWithSessionKey) self-heals from the persisted viewedAt timestamp the
// next time anyone loads the store, so a restart mid-countdown just means
// the expiry catches up a little late instead of never happening.
const pendingExpiry = new Map();

// Presence tracking, in-memory only (mirrors the "invalida a cada restart"
// spirit of sessions/pendingExpiry above): connectionId -> name, one entry
// per open SSE stream. Used only to answer "a outra pessoa esta online
// agora" - never persisted, never exposed outside /api/stream.
const onlineConnections = new Map();

// Best-effort Open Graph preview for a link pasted into a text message.
// Deliberately runs AFTER the message is already saved/broadcast (see the
// call site in POST /api/messages) so sending a message never waits on a
// third-party site's response time - the bubble appears instantly, the
// preview card (if any) pops in a moment later via the "message-updated"
// SSE event. Any failure (timeout, non-HTML response, no og: tags, blocked
// host) just means no card ever appears; never retried, never surfaced as
// an error to the sender.
const LINK_PREVIEW_TIMEOUT_MS = 5000;
const LINK_PREVIEW_MAX_BYTES = 300 * 1024;
const URL_IN_TEXT_RE = /(https?:\/\/[^\s<>"']+)/i;

// Mirrors linkify's stripTrailingPunctuation in app.js: URL_IN_TEXT_RE's
// raw match greedily includes trailing sentence punctuation ("...html,",
// "...html)."), which would otherwise turn into a request for a URL that
// 404s and silently kills the preview. Keeping both trims in sync matters
// less for correctness (the client-rendered href already excludes this)
// than for making sure the preview is actually fetched for the same link
// the person sees rendered as clickable.
// A pessoa é identificada pelo nome digitado, que ela pode capitalizar de
// forma diferente entre sessões/dispositivos ("Ana" num, "ana" noutro) - a
// identidade tem que reconhecer isso como a mesma pessoa.
function sameSender(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function stripTrailingPunctuationServer(raw) {
  while (raw.length) {
    const last = raw[raw.length - 1];
    if (last === ')') {
      const opens = (raw.match(/\(/g) || []).length;
      const closes = (raw.match(/\)/g) || []).length;
      if (closes > opens) { raw = raw.slice(0, -1); continue; }
      break;
    }
    // *_~` entram aqui por causa da formatação (ver renderRich em app.js):
    // em "*veja https://exemplo.com*" o asterisco fecha o negrito, não faz
    // parte do link.
    if ('.,!?;:*_~`'.includes(last)) { raw = raw.slice(0, -1); continue; }
    break;
  }
  return raw;
}

// Blocks the obvious "someone pasted an internal URL" cases for a link two
// trusted people are sharing with each other - NOT a full SSRF defense
// (no DNS-rebinding protection, doesn't resolve hostnames before matching).
// Good enough here because the two users of this chat are already trusted
// with everything else in it; a general-purpose/public version of this
// feature would need the real thing.
function isBlockedPreviewHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return undefined;
}

async function fetchLinkPreview(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isBlockedPreviewHost(parsed.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrivateChatLinkPreview/1.0)' },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('text/html') || !res.body) return null;

    // A preview only ever needs the <head> - stop reading well before any
    // reasonable page's body, both for speed and so a huge page can't tie
    // up memory here.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let received = 0;
    try {
      while (received < LINK_PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
    } finally {
      try { reader.cancel(); } catch (e) { /* ignore */ }
    }

    const title = extractMetaContent(html, 'og:title')
      || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description');
    let image = extractMetaContent(html, 'og:image');
    if (image) {
      try {
        image = new URL(image, parsed).toString();
        if (!/^https?:\/\//i.test(image)) image = undefined;
      } catch (e) {
        image = undefined;
      }
    }

    if (!title && !description && !image) return null;
    return {
      url: parsed.toString(),
      title: title ? decodeHtmlEntities(title).trim().slice(0, 200) : undefined,
      description: description ? decodeHtmlEntities(description).trim().slice(0, 300) : undefined,
      image,
      siteName: extractMetaContent(html, 'og:site_name') || parsed.hostname,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Re-reads/re-decrypts the store fresh (same pattern as scheduleExpiry
// above) rather than reusing the in-memory `data` from the request that
// created the message - this runs seconds later, after that request has
// already responded and persisted, so a stale reference could clobber
// anything the other person did in between.
async function scheduleLinkPreview(sessionKey, messageId, url) {
  const preview = await fetchLinkPreview(url);
  if (!preview) return;
  try {
    const blob = fs.readFileSync(store.storePath);
    const { decryptBuffer } = require('./lib/crypto');
    const data = JSON.parse(decryptBuffer(sessionKey, blob).toString('utf8'));
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg || msg.deleted) return;
    msg.linkPreview = preview;
    store.persist(sessionKey, data);
    bus.emit('message-updated', { id: msg.id, linkPreview: preview });
  } catch (e) {
    console.error('Falha ao salvar preview de link', e);
  }
}

// Um mesmo blob em data/media pode servir a várias mensagens e à coleção de
// figurinhas/GIFs ao mesmo tempo (mandar uma figurinha não copia o arquivo,
// só aponta pra ele). Então apagar uma mensagem só remove o arquivo do disco
// se mais ninguém aponta pra ele.
function mediaStillReferenced(data, mediaId, ignoreMsgId) {
  if ((data.stickers || []).some((s) => s.mediaId === mediaId || s.thumbId === mediaId)) return true;
  return data.messages.some((m) => m.id !== ignoreMsgId
    && (m.mediaId === mediaId || m.thumbId === mediaId));
}

function releaseMessageMedia(data, msg) {
  for (const id of [msg.mediaId, msg.thumbId]) {
    if (id && !mediaStillReferenced(data, id, msg.id)) store.deleteMediaFile(id);
  }
}

function expireEphemeralMessage(data, msg) {
  // Mídia de visualização única nunca chega a ganhar thumbId (ver POST
  // /api/media) nem entra na coleção, mas passar pelo mesmo caminho fecha a
  // porta caso algum fluxo futuro mude isso.
  releaseMessageMedia(data, msg);
  delete msg.starredBy;
  msg.deleted = true;
  msg.deletedAt = Date.now();
  msg.expiredEphemeral = true;
  delete msg.text;
  delete msg.mediaId;
  delete msg.thumbId;
  delete msg.filename;
  delete msg.mimeType;
  delete msg.size;
}

function scheduleExpiry(sessionKey, msgId, delayMs) {
  if (pendingExpiry.has(msgId)) return;
  const handle = setTimeout(() => {
    pendingExpiry.delete(msgId);
    try {
      const blob = fs.readFileSync(store.storePath);
      const { decryptBuffer } = require('./lib/crypto');
      const data = JSON.parse(decryptBuffer(sessionKey, blob).toString('utf8'));
      const msg = data.messages.find((m) => m.id === msgId);
      if (!msg || msg.deleted) return; // already handled some other way
      expireEphemeralMessage(data, msg);
      store.persist(sessionKey, data);
      bus.emit('message-deleted', { id: msg.id, sender: msg.sender, deletedAt: msg.deletedAt, expiredEphemeral: true });
    } catch (e) {
      console.error('Falha ao expirar midia de visualizacao unica', e);
    }
  }, Math.max(delayMs, 0));
  handle.unref();
  pendingExpiry.set(msgId, handle);
}

// Runs on every authenticated data load (see loadWithSessionKey): catches
// up any ephemeral message whose window quietly finished while nobody had
// the app open to trigger scheduleExpiry's own timer (most commonly: a
// server restart wiped the in-memory timer, or the process simply wasn't
// running for those 10 seconds), and (re)arms a live timer for anything
// still within its window - keyed by pendingExpiry so this never
// double-schedules on repeated calls.
function reconcileEphemeral(sessionKey, data) {
  let changed = false;
  for (const msg of data.messages) {
    if (!msg.ephemeral || msg.deleted || !msg.viewedAt) continue;
    const remaining = EPHEMERAL_TTL_MS - (Date.now() - msg.viewedAt);
    if (remaining <= 0) {
      expireEphemeralMessage(data, msg);
      changed = true;
      bus.emit('message-deleted', { id: msg.id, sender: msg.sender, deletedAt: msg.deletedAt, expiredEphemeral: true });
    } else {
      scheduleExpiry(sessionKey, msg.id, remaining);
    }
  }
  if (changed) store.persist(sessionKey, data);
}

// Ephemeral media is withheld from every general list/broadcast channel -
// mediaId (and the fields only meaningful alongside it) only ever reaches
// a client through the one deliberate reveal point, POST .../view's own
// response. Applies regardless of viewedAt so a mid-window page reload by
// anyone but the active viewer can't pull the file out through the list
// endpoint either.
function sanitizeMessage(msg) {
  if (msg.ephemeral && !msg.deleted) {
    const { mediaId, thumbId, filename, mimeType, size, width, height, ...rest } = msg;
    return rest;
  }
  return msg;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const ROOM_PATH = `/c/${ROOM_SLUG}`;

// Cabeçalhos de segurança em TODA resposta (inclusive o 404 de slug errado,
// pra resposta não mudar de cara conforme o caminho):
//  - CSP: a página só roda o próprio app.js e só fala com a própria origem.
//    Mesmo que algum texto escapasse do tratamento como HTML, script
//    injetado não executa e nada consegue ser enviado pra fora. img-src
//    aceita https: só por causa da imagem do preview de link.
//  - Referrer-Policy: o link secreto da sala nunca vai no Referer de nada
//    que a página abra ou carregue.
//  - frame-ancestors/X-Frame-Options: ninguém embute o chat num iframe.
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
// Pra arquivo enviado pelos usuários: aberto direto numa aba, vira um
// documento "sandbox" sem script e sem acesso à origem do chat. Sem isso um
// .svg/.html mandado como anexo rodaria script com a sessão de quem abriu.
const MEDIA_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  next();
});

// Anything that doesn't match our exact room path is a dead end.
// Wrong slug (or no slug) => 404, not a hint that a chat app lives here.
app.use((req, res, next) => {
  if (req.path === ROOM_PATH || req.path.startsWith(`${ROOM_PATH}/`)) return next();
  return res.status(404).end();
});

const roomRouter = express.Router();
app.use(ROOM_PATH, roomRouter);

// Nenhuma resposta da API pode ficar guardada em cache de navegador ou de
// proxy - é conversa decifrada. (O SSE e a rota de mídia definem o próprio
// Cache-Control por cima deste.)
roomRouter.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Os três arquivos do front (index.html, app.js, style.css) saem comprimidos
// (brotli ou gzip) e com ETag: o app.js sozinho passa de 150KB, e tudo isso
// sobe pelo upload de casa a cada abertura. A versão comprimida fica em
// memória e só é refeita quando o arquivo muda no disco (deploy).
// `no-cache` = o navegador guarda, mas sempre confere o ETag antes de usar,
// então uma versão nova do app aparece no primeiro reload.
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const staticCache = new Map(); // nome -> { sig, raw, gzip, br, etag }

function loadStaticFile(name) {
  const filePath = path.join(PUBLIC_DIR, name);
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    return null;
  }
  if (!st.isFile()) return null;
  const sig = `${st.size}-${Math.round(st.mtimeMs)}`;
  const hit = staticCache.get(name);
  if (hit && hit.sig === sig) return hit;
  const raw = fs.readFileSync(filePath);
  const entry = {
    sig,
    raw,
    gzip: zlib.gzipSync(raw, { level: 9 }),
    br: zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
    }),
    etag: `"${sig}"`,
  };
  staticCache.set(name, entry);
  return entry;
}

function sendStatic(req, res, name) {
  const type = STATIC_TYPES[path.extname(name)];
  const entry = type && loadStaticFile(name);
  if (!entry) return false;
  const accepts = String(req.headers['accept-encoding'] || '');
  let encoding = null;
  if (/\bbr\b/.test(accepts)) encoding = 'br';
  else if (/\bgzip\b/.test(accepts)) encoding = 'gzip';
  const etag = encoding ? entry.etag.replace(/"$/, `-${encoding}"`) : entry.etag;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  const body = encoding ? entry[encoding] : entry.raw;
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', body.length);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

roomRouter.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // Só nome simples (public/ é plano) - nada de subpasta nem "..".
  const m = /^\/([\w.-]+\.(?:html|js|css))$/.exec(req.path);
  if (m && sendStatic(req, res, m[1])) return undefined;
  return next();
});

roomRouter.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore' }));

roomRouter.get('/', (req, res) => {
  if (!sendStatic(req, res, 'index.html')) res.status(404).end();
});

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      return null;
    }
  }
  return null;
}

function hermesCookie(value, maxAgeSeconds) {
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : '; Secure';
  return `${HERMES_COOKIE}=${value}; Path=${ROOM_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

// Devolve o token da sessão "só Hermes" deste request, ou null.
function getHermesGuest(req) {
  const token = readCookie(req, HERMES_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const createdAt = hermesGuests.get(token);
  if (!createdAt) return null;
  if (Date.now() - createdAt > HERMES_SESSION_TTL_MS) {
    hermesGuests.delete(token);
    return null;
  }
  return token;
}

roomRouter.get('/api/me', (req, res) => {
  const session = auth.getSession(req);
  res.json({ authenticated: !!session, hermes: !session && !!getHermesGuest(req) });
});

roomRouter.post('/api/login', express.json(), async (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (ALT_CODE && typeof code === 'string' && safeEqual(code, ALT_CODE)) {
    return res.json({ ok: true, notice: true });
  }
  if (auth.isLocked(req)) {
    return res.status(429).json({ error: 'locked', message: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  if (typeof code !== 'string' || code.length < 4 || code.length > 256) {
    return res.status(400).json({ error: 'invalid', message: 'Codigo muito curto.' });
  }
  // Código do Hermes: depois do bloqueio por tentativas (então adivinhar este
  // código também esbarra no limite) e SEM registerSuccess - senão quem
  // conhece este código poderia usá-lo pra zerar o contador de erros e
  // continuar chutando o código do chat.
  if (HERMES_CODE && safeEqual(code, HERMES_CODE)) {
    const now = Date.now();
    for (const [t, createdAt] of hermesGuests) {
      if (now - createdAt > HERMES_SESSION_TTL_MS) hermesGuests.delete(t);
    }
    const token = crypto.randomBytes(32).toString('hex');
    hermesGuests.set(token, now);
    res.setHeader('Set-Cookie', hermesCookie(token, Math.floor(HERMES_SESSION_TTL_MS / 1000)));
    return res.json({ ok: true, hermes: true });
  }
  try {
    const { key } = await store.unlock(code);
    auth.registerSuccess(req);
    auth.createSession(res, key, ROOM_PATH);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof WrongCodeError) {
      auth.registerFailure(req);
      return res.status(401).json({ error: 'wrong_code', message: 'Codigo incorreto.' });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

roomRouter.post('/api/logout', (req, res) => {
  auth.destroySession(req, res, ROOM_PATH);
  const guest = getHermesGuest(req);
  if (guest) hermesGuests.delete(guest);
  res.append('Set-Cookie', hermesCookie('', 0));
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: 'unauthenticated' });
  req.session = session;
  next();
}

// We never re-ask for the plaintext code once a session exists; instead we keep
// using the session's already-derived key directly against the store file.
function loadWithSessionKey(req) {
  const data = loadStoreOnly(req);
  reconcileEphemeral(req.session.key, data);
  return data;
}

// Mesmo trabalho do loadWithSessionKey, mas SEM reconcileEphemeral. Serve
// só pra rota que entrega bytes de mídia: a grade da aba "Mídia" dispara
// dezenas de requests seguidos, e cada um deles rodar a reconciliação
// (que pode gravar no disco e emitir SSE) é caro e não tem nada a ver com
// ler um arquivo. O self-heal continua acontecendo em todo o resto -
// listar mensagens, enviar, apagar, reagir, exportar.
function loadStoreOnly(req) {
  const blob = fs.readFileSync(store.storePath);
  const { decryptBuffer } = require('./lib/crypto');
  const plaintext = decryptBuffer(req.session.key, blob);
  return JSON.parse(plaintext.toString('utf8'));
}

// Índice "id do blob -> como servir", só pra rota GET /api/media/:id. Antes
// cada miniatura da grade decifrava e fazia JSON.parse da conversa INTEIRA
// só pra descobrir o Content-Type de um arquivo - dezenas de vezes seguidas
// ao abrir a aba Mídia ou a bandeja de figurinhas. O índice é refeito só
// quando store.enc muda no disco (a assinatura abaixo muda a cada persist,
// que grava por rename atômico) e não guarda nada do conteúdo das mensagens:
// só tipo e nome de arquivo. Vive em memória e só é alcançado por request já
// autenticado, igual à chave de sessão.
let mediaIndexCache = null; // { sig, map }

function storeSignature() {
  const st = fs.statSync(store.storePath, { bigint: true });
  return `${st.ino}:${st.mtimeNs}:${st.size}`;
}

function getMediaIndex(req) {
  const sig = storeSignature();
  if (mediaIndexCache && mediaIndexCache.sig === sig) return mediaIndexCache.map;
  const data = loadStoreOnly(req);
  const map = new Map();
  for (const m of data.messages) {
    if (m.mediaId) map.set(m.mediaId, { mimeType: m.mimeType, filename: m.filename });
    if (m.thumbId) map.set(m.thumbId, { thumb: true });
  }
  for (const s of data.stickers || []) {
    if (s.mediaId && !map.has(s.mediaId)) map.set(s.mediaId, { mimeType: s.mimeType, filename: s.kind === 'gif' ? 'gif' : 'figurinha' });
    if (s.thumbId && !map.has(s.thumbId)) map.set(s.thumbId, { thumb: true });
  }
  mediaIndexCache = { sig, map };
  return map;
}

function publicSticker(s) {
  return {
    id: s.id,
    kind: s.kind,
    mediaId: s.mediaId,
    thumbId: s.thumbId,
    mimeType: s.mimeType,
    width: s.width,
    height: s.height,
    addedBy: s.addedBy,
    ts: s.ts,
    lastUsed: s.lastUsed,
  };
}

// Chave de data.prefs pra um nome. O prefixo "u:" impede que um nome como
// "__proto__" ou "constructor" caia em cima de uma propriedade do próprio
// objeto.
function prefsKey(name) {
  const clean = String(name || '').trim().toLowerCase().slice(0, 60);
  return clean ? `u:${clean}` : '';
}

function parseDimension(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : undefined;
}

const REPLY_SNIPPET_LABELS = {
  image: '📷 Foto',
  video: '🎥 Video',
  audio: '🎤 Audio',
  file: '📄 Arquivo',
  sticker: 'Figurinha',
};

// Captures a lightweight, immutable snapshot of the message being replied to
// (sender + short snippet) at reply time — the quote keeps showing this even
// if the original is edited or later deleted, same as most chat apps.
function buildReplySnapshot(data, replyToId) {
  if (!replyToId) return undefined;
  const original = data.messages.find((m) => m.id === String(replyToId));
  if (!original) return undefined;
  let snippet;
  let thumbId;
  if (original.expiredEphemeral) {
    snippet = 'Mídia de visualização única (expirada)';
  } else if (original.deleted) {
    // deletedBy is missing for messages deleted before this field existed -
    // those could only ever have been deleted by their own author (the old
    // rule), so falling back to the original sender is accurate there too.
    snippet = `Mensagem apagada por ${original.deletedBy || original.sender}`;
  } else if (original.ephemeral && !original.deleted) {
    const label = REPLY_SNIPPET_LABELS[original.type];
    snippet = label ? `${label} (visualização única)` : 'Mídia de visualização única';
  } else if (original.type === 'text') {
    snippet = original.text.length > 140 ? `${original.text.slice(0, 140)}...` : original.text;
  } else {
    snippet = original.gif ? 'GIF' : (REPLY_SNIPPET_LABELS[original.type] || 'Arquivo');
    // Figurinha é pequena o bastante pra ser a própria miniatura.
    if (original.type === 'sticker') thumbId = original.mediaId;
    // thumbId (ou o mediaId, só pra foto: um <img> num .mp4 cru baixaria o
    // arquivo inteiro e não decodificaria nada) - só é seguro pegar aqui,
    // no branch que já garante que o original não é ephemeral nem deletado.
    if (original.type === 'image' || original.type === 'video') {
      thumbId = original.thumbId || (original.type === 'image' ? original.mediaId : undefined);
    }
  }
  const result = { id: original.id, sender: original.sender, snippet };
  if (thumbId) result.thumbId = thumbId;
  return result;
}

// Paginação "mais recentes primeiro": sem parâmetros, devolve só o último
// lote (as PAGE_SIZE mensagens mais novas); com ?before=<id> devolve o lote
// imediatamente anterior a essa mensagem. O array no store já está em ordem
// cronológica, então é só fatiar. A ordem de retorno continua ascendente
// (mais antiga → mais nova) pra não mudar o contrato do renderMessage no
// front. hasMore avisa se ainda existe histórico antes do início do lote.
const MESSAGES_PAGE_DEFAULT = 50;
const MESSAGES_PAGE_MAX = 200;

// Quantas mensagens de contexto vêm ACIMA do alvo num salto (?from=). Zero
// deixaria a mensagem colada no topo da lista, e um valor pequeno faria a
// primeira rolagem pra cima já disparar loadOlderMessages na hora.
const JUMP_CONTEXT_BEFORE = 20;

roomRouter.get('/api/messages', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    const all = data.messages;

    // ?from=<id>: salto pra uma mensagem específica ("Ir para a mensagem", na
    // aba Mídia). Devolve o RABO da conversa a partir dela - da mensagem-alvo
    // (com JUMP_CONTEXT_BEFORE de contexto acima) até a mais nova, de uma vez.
    // Ir até o fim é de propósito: loadedMessages no cliente é sempre um
    // sufixo terminando na última mensagem, e é essa invariante que faz o
    // append do SSE, o loadOlderMessages e o botão "ir pro fim" funcionarem
    // sem um segundo cursor "hasMoreNewer" (que não existe). Uma janela
    // centrada no alvo quebraria os três. Por isso `limit` também não vale
    // aqui: cortar o lote deixaria um buraco entre ele e a mensagem mais nova.
    if (req.query.from) {
      const at = all.findIndex((m) => m.id === String(req.query.from));
      if (at === -1) return res.status(404).json({ error: 'not_found' });
      const from = Math.max(0, at - JUMP_CONTEXT_BEFORE);
      return res.json({
        messages: all.slice(from).map(sanitizeMessage),
        hasMore: from > 0,
      });
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = MESSAGES_PAGE_DEFAULT;
    limit = Math.min(limit, MESSAGES_PAGE_MAX);

    let end = all.length;
    if (req.query.before) {
      const idx = all.findIndex((m) => m.id === String(req.query.before));
      // Cursor desconhecido (mensagem apagada do array? nunca acontece hoje,
      // mas seja defensivo) → trata como se não tivesse cursor.
      if (idx !== -1) end = idx;
    }
    const start = Math.max(0, end - limit);
    const slice = all.slice(start, end);

    res.json({ messages: slice.map(sanitizeMessage), hasMore: start > 0 });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/messages', requireAuth, express.json(), (req, res) => {
  const { sender, text, replyToId } = req.body || {};
  if (!sender || !String(sender).trim() || !text || !String(text).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const message = {
      id: randomId(8),
      type: 'text',
      sender: String(sender).trim().slice(0, 60),
      text: String(text).trim().slice(0, 8000),
      ts: Date.now(),
    };
    const replyTo = buildReplySnapshot(data, replyToId);
    if (replyTo) message.replyTo = replyTo;
    data.messages.push(message);
    store.persist(req.session.key, data);
    const outbound = sanitizeMessage(message);
    bus.emit('message', outbound);
    res.json({ ok: true, message: outbound });
    // Fire-and-forget: never delays the response above, and any failure
    // just means no preview card ever shows up for this message.
    const linkMatch = message.text.match(URL_IN_TEXT_RE);
    if (linkMatch) {
      const cleanUrl = stripTrailingPunctuationServer(linkMatch[0]);
      scheduleLinkPreview(req.session.key, message.id, cleanUrl).catch(() => {});
    }
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// upload.fields (e não .single) porque além do arquivo em si o cliente manda
// uma miniatura JPEG que ele mesmo gera num <canvas> antes de enviar (ver
// readMediaMeta em app.js). Consequência: req.file não existe mais nesta
// rota - o arquivo está em req.files.file[0].
const uploadMediaFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]);

roomRouter.post('/api/media', requireAuth, uploadMediaFields, (req, res) => {
  const { sender, replyToId, ephemeral } = req.body || {};
  const file = req.files && req.files.file && req.files.file[0];
  if (!file || !sender || !String(sender).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  // Intrinsic width/height, read client-side (see readMediaMeta in
  // app.js) BEFORE upload and handed back with the message so the <img>/
  // <video> can reserve the right box on first paint instead of jumping
  // around as each file finishes downloading. Best-effort and optional -
  // anything missing/bogus is just silently dropped, never blocks the
  // upload (mirrors how ephemeral is parsed just below).
  const mediaWidth = parseDimension(req.body && req.body.width);
  const mediaHeight = parseDimension(req.body && req.body.height);
  const mime = file.mimetype || 'application/octet-stream';
  let type = 'file';
  if (mime.startsWith('image/')) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';

  try {
    const data = loadWithSessionKey(req);
    const mediaId = randomId(16);
    store.saveMedia(req.session.key, mediaId, file.buffer);
    const message = {
      id: randomId(8),
      type,
      sender: String(sender).trim().slice(0, 60),
      mediaId,
      filename: (file.originalname || 'arquivo').slice(0, 200),
      mimeType: mime,
      size: file.size,
      ts: Date.now(),
    };
    if (mediaWidth && mediaHeight) {
      message.width = mediaWidth;
      message.height = mediaHeight;
    }
    // Marca GIF pra bolha ganhar o selo e o menu oferecer "Salvar nos GIFs".
    if (mime === 'image/gif') message.gif = true;
    // "Visualização única" only makes sense for something you actually
    // look at - silently ignored for audio/other files rather than
    // rejecting the whole upload over it.
    const wantsEphemeral = ephemeral === '1' || ephemeral === 'true' || ephemeral === true;
    if (wantsEphemeral && (type === 'image' || type === 'video')) {
      message.ephemeral = true;
    }
    // Miniatura pra grade da aba "Mídia": mais um blob cifrado em
    // data/media/<id>.enc, com a mesma chave de sessão do original. Nunca
    // para visualização única - uma thumb que sobrevive ao "expira em 10s"
    // é exatamente o vazamento que o sanitizeMessage existe pra impedir.
    // Opcional em todos os sentidos: se o cliente não conseguiu gerar (ver
    // readMediaMeta), a mensagem simplesmente fica sem thumbId e a grade
    // cai no caminho pesado.
    const thumbFile = req.files && req.files.thumb && req.files.thumb[0];
    if (thumbFile && !message.ephemeral && (type === 'image' || type === 'video')
        && thumbFile.size > 0 && thumbFile.size <= MAX_THUMB_BYTES) {
      const thumbId = randomId(16);
      store.saveMedia(req.session.key, thumbId, thumbFile.buffer);
      message.thumbId = thumbId;
    }
    const replyTo = buildReplySnapshot(data, replyToId);
    if (replyTo) message.replyTo = replyTo;
    data.messages.push(message);
    store.persist(req.session.key, data);
    const outbound = sanitizeMessage(message);
    bus.emit('message', outbound);
    res.json({ ok: true, message: outbound });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// The one deliberate reveal point for a "visualização única" photo/video:
// the recipient taps the locked bubble, this hands back the real mediaId
// (never exposed via /api/messages or the SSE broadcast otherwise) and
// arms the expiry countdown on first open. Whoever sent it can never open
// it themselves - same rule real view-once messaging apps use, and it
// also means the sender can't accidentally burn the recipient's only
// viewing window by tapping their own bubble.
roomRouter.post('/api/messages/:id/view', requireAuth, express.json(), (req, res) => {
  const { requesterName } = req.body || {};
  if (!requesterName || !String(requesterName).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (!msg.ephemeral) return res.status(400).json({ error: 'not_ephemeral' });
    if (msg.deleted) {
      return res.status(410).json({ error: 'expired', message: 'Essa mídia já expirou.' });
    }
    if (sameSender(msg.sender, requesterName)) {
      return res.status(403).json({ error: 'forbidden', message: 'Quem enviou não pode abrir uma mídia de visualização única.' });
    }
    if (!msg.viewedAt) {
      msg.viewedAt = Date.now();
      store.persist(req.session.key, data);
      scheduleExpiry(req.session.key, msg.id, EPHEMERAL_TTL_MS);
      bus.emit('message-viewed', { id: msg.id, viewedAt: msg.viewedAt });
    }
    const remainingMs = Math.max(EPHEMERAL_TTL_MS - (Date.now() - msg.viewedAt), 0);
    res.json({ ok: true, message: msg, remainingMs });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/messages/:id/delete', requireAuth, (req, res) => {
  const { requesterName } = req.body || {};
  if (!requesterName || !String(requesterName).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not_found' });

    if (msg.deleted) {
      return res.json({ ok: true, message: msg });
    }
    // Either person in the room can delete any message (2-person private
    // chat, both already trusted with the whole conversation) - the old
    // sender-only restriction just meant a message could get stuck if the
    // person who sent it wasn't around to clean it up. What's tracked
    // instead is WHO actually deleted it, shown on the placeholder, so
    // "apagar" is transparent rather than silent.
    const deletedBy = String(requesterName).trim();

    releaseMessageMedia(data, msg);

    msg.deleted = true;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    delete msg.starredBy;
    delete msg.reactions;
    delete msg.text;
    delete msg.mediaId;
    delete msg.thumbId;
    delete msg.filename;
    delete msg.mimeType;
    delete msg.size;

    store.persist(req.session.key, data);
    bus.emit('message-deleted', { id: msg.id, sender: msg.sender, deletedAt: msg.deletedAt, deletedBy });
    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// Reação a uma mensagem, com qualquer emoji (um só - ver isSingleEmoji).
// Uma reação por pessoa por mensagem, com toggle: reagir com o mesmo emoji
// remove; com outro, troca.
// Mesmo modelo de confiança do "apagar" - o servidor confia no requesterName
// que o cliente manda (sala privada de 2 pessoas).
roomRouter.post('/api/messages/:id/react', requireAuth, express.json(), (req, res) => {
  const { requesterName, emoji } = req.body || {};
  if (!requesterName || !String(requesterName).trim() || !isSingleEmoji(emoji)) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (msg.deleted) return res.json({ ok: true, message: msg });

    const name = String(requesterName).trim();
    if (!Array.isArray(msg.reactions)) msg.reactions = [];
    const i = msg.reactions.findIndex((r) => sameSender(r.sender, name));
    if (i >= 0 && msg.reactions[i].emoji === emoji) {
      msg.reactions.splice(i, 1);
    } else if (i >= 0) {
      msg.reactions[i] = { sender: name, emoji, ts: Date.now() };
    } else {
      msg.reactions.push({ sender: name, emoji, ts: Date.now() });
    }
    if (msg.reactions.length === 0) delete msg.reactions;

    store.persist(req.session.key, data);
    bus.emit('message-reacted', { id: msg.id, reactions: msg.reactions || [] });
    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// ===== Favoritas =====
// Cada pessoa tem as suas (msg.starredBy guarda quem favoritou), igual às
// "mensagens com estrela" do WhatsApp: favoritar não aparece pra outra
// pessoa. Mesmo modelo de confiança de apagar/reagir - vale o requesterName.
roomRouter.post('/api/messages/:id/star', requireAuth, express.json(), (req, res) => {
  const { requesterName } = req.body || {};
  if (!requesterName || !String(requesterName).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    // Apagada não tem o que guardar; visualização única não pode ganhar um
    // atalho permanente.
    if (msg.deleted || msg.ephemeral) return res.status(400).json({ error: 'invalid' });

    const name = String(requesterName).trim().slice(0, 60);
    const list = Array.isArray(msg.starredBy) ? msg.starredBy : [];
    const i = list.findIndex((n) => sameSender(n, name));
    // `starred` explícito (true/false) quando o cliente manda; sem ele, alterna.
    const want = typeof req.body.starred === 'boolean' ? req.body.starred : i === -1;
    if (want && i === -1) list.push(name);
    if (!want && i !== -1) list.splice(i, 1);
    if (list.length) msg.starredBy = list;
    else delete msg.starredBy;

    store.persist(req.session.key, data);
    bus.emit('message-starred', { id: msg.id, starredBy: msg.starredBy || [] });
    res.json({ ok: true, starredBy: msg.starredBy || [] });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// Lista do painel "Favoritas": as mensagens que ESTA pessoa marcou, da mais
// nova pra mais antiga.
roomRouter.get('/api/starred', requireAuth, (req, res) => {
  const name = String((req.query && req.query.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'invalid' });
  try {
    const data = loadWithSessionKey(req);
    const items = [];
    for (let i = data.messages.length - 1; i >= 0 && items.length < 500; i--) {
      const m = data.messages[i];
      if (m.deleted || !Array.isArray(m.starredBy)) continue;
      if (!m.starredBy.some((n) => sameSender(n, name))) continue;
      items.push(sanitizeMessage(m));
    }
    res.json({ items });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// ===== Preferências por pessoa =====
// Hoje só os atalhos de reação (os 6 emojis da barra do menu). Ficam no
// store cifrado, por nome, pra valerem no celular e no computador.
roomRouter.post('/api/prefs', requireAuth, express.json(), (req, res) => {
  const { requesterName, quickReactions } = req.body || {};
  const key = prefsKey(requesterName);
  if (!key || !Array.isArray(quickReactions)
      || quickReactions.length !== QUICK_REACTIONS_COUNT
      || !quickReactions.every(isSingleEmoji)
      || new Set(quickReactions).size !== quickReactions.length) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    if (!data.prefs || typeof data.prefs !== 'object') data.prefs = {};
    data.prefs[key] = { ...(data.prefs[key] || {}), quickReactions };
    store.persist(req.session.key, data);
    res.json({ ok: true, quickReactions });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// Tudo que o cliente precisa saber logo ao entrar, além das mensagens: os
// atalhos de reação dessa pessoa, a coleção de figurinhas/GIFs e quais
// recursos opcionais estão ligados neste servidor.
roomRouter.get('/api/boot', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    const mine = (data.prefs && data.prefs[prefsKey(req.query && req.query.name)]) || {};
    res.json({
      quickReactions: Array.isArray(mine.quickReactions) ? mine.quickReactions : DEFAULT_QUICK_REACTIONS,
      stickers: (data.stickers || []).map(publicSticker),
      giphy: !!GIPHY_API_KEY,
      hermes: HERMES_HASH ? { salt: HERMES_SALT, hash: HERMES_HASH } : null,
    });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// "Fulano está digitando…": só repassa pro SSE, nada é gravado.
roomRouter.post('/api/typing', requireAuth, express.json(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (name) bus.emit('typing', { name });
  res.json({ ok: true });
});

// ===== Coleção de figurinhas e GIFs =====
// Uma coleção só, compartilhada pelos dois (data.stickers). Cada item é um
// blob cifrado em data/media, igual a qualquer mídia. Mandar um item cria
// uma mensagem que APONTA pro mesmo blob (não copia) - por isso apagar
// mensagem/item passa por mediaStillReferenced.
function addLibraryItem(data, item) {
  if (!Array.isArray(data.stickers)) data.stickers = [];
  data.stickers.push(item);
  return item;
}

roomRouter.get('/api/stickers', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    res.json({ stickers: (data.stickers || []).map(publicSticker) });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/stickers', requireAuth, uploadMediaFields, (req, res) => {
  const { sender } = req.body || {};
  const kind = req.body && req.body.kind === 'gif' ? 'gif' : 'sticker';
  const file = req.files && req.files.file && req.files.file[0];
  if (!file || !sender || !String(sender).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  const mime = file.mimetype || '';
  if (!mime.startsWith('image/')) {
    return res.status(400).json({ error: 'invalid', message: 'Só imagens entram na coleção.' });
  }
  if (file.size > (kind === 'gif' ? MAX_GIF_BYTES : MAX_STICKER_BYTES)) {
    return res.status(413).json({ error: 'too_large', message: 'Arquivo grande demais pra coleção.' });
  }
  try {
    const data = loadWithSessionKey(req);
    const list = data.stickers || [];
    // Mesmo arquivo de novo (mesmo conteúdo) não duplica: devolve o que já tem.
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const existing = list.find((s) => s.kind === kind && s.hash === hash);
    if (existing) return res.json({ ok: true, sticker: publicSticker(existing), duplicate: true });
    if (list.length >= MAX_LIBRARY_ITEMS) {
      return res.status(400).json({ error: 'full', message: 'A coleção está cheia. Remova algum item antes.' });
    }

    const mediaId = randomId(16);
    store.saveMedia(req.session.key, mediaId, file.buffer);
    const item = {
      id: randomId(8),
      kind,
      mediaId,
      mimeType: mime,
      size: file.size,
      hash,
      addedBy: String(sender).trim().slice(0, 60),
      ts: Date.now(),
    };
    const w = parseDimension(req.body.width);
    const h = parseDimension(req.body.height);
    if (w && h) { item.width = w; item.height = h; }
    const thumbFile = req.files.thumb && req.files.thumb[0];
    if (kind === 'gif' && thumbFile && thumbFile.size > 0 && thumbFile.size <= MAX_THUMB_BYTES) {
      item.thumbId = randomId(16);
      store.saveMedia(req.session.key, item.thumbId, thumbFile.buffer);
    }
    addLibraryItem(data, item);
    store.persist(req.session.key, data);
    bus.emit('stickers-changed', {});
    res.json({ ok: true, sticker: publicSticker(item) });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// Guarda na coleção uma mídia que já está na conversa (um GIF recebido, ou
// uma figurinha cujo item foi removido) sem subir nada de novo: o item passa
// a apontar pro blob da própria mensagem.
roomRouter.post('/api/stickers/from-message', requireAuth, express.json(), (req, res) => {
  const { requesterName, messageId } = req.body || {};
  if (!requesterName || !String(requesterName).trim() || !messageId) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.id === String(messageId));
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (msg.deleted || msg.ephemeral || !msg.mediaId) return res.status(400).json({ error: 'invalid' });
    let kind;
    if (msg.type === 'sticker') kind = 'sticker';
    else if (msg.type === 'image' && (msg.gif || msg.mimeType === 'image/gif')) kind = 'gif';
    else return res.status(400).json({ error: 'invalid' });

    const list = data.stickers || [];
    // Mesmo hash que o upload direto usa, pra o mesmo arquivo não entrar duas
    // vezes na coleção por caminhos diferentes (salvo da conversa + enviado
    // pelo "+").
    let hash;
    try {
      hash = crypto.createHash('sha256').update(store.loadMedia(req.session.key, msg.mediaId)).digest('hex');
    } catch (e) {
      return res.status(404).json({ error: 'not_found' });
    }
    const existing = list.find((s) => s.mediaId === msg.mediaId || (s.kind === kind && s.hash === hash));
    if (existing) return res.json({ ok: true, sticker: publicSticker(existing), duplicate: true });
    if (list.length >= MAX_LIBRARY_ITEMS) {
      return res.status(400).json({ error: 'full', message: 'A coleção está cheia. Remova algum item antes.' });
    }
    const item = {
      id: randomId(8),
      kind,
      mediaId: msg.mediaId,
      mimeType: msg.mimeType,
      size: msg.size,
      hash,
      addedBy: String(requesterName).trim().slice(0, 60),
      ts: Date.now(),
    };
    if (msg.width && msg.height) { item.width = msg.width; item.height = msg.height; }
    if (kind === 'gif' && msg.thumbId) item.thumbId = msg.thumbId;
    addLibraryItem(data, item);
    store.persist(req.session.key, data);
    bus.emit('stickers-changed', {});
    res.json({ ok: true, sticker: publicSticker(item) });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/stickers/:id/delete', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    const list = data.stickers || [];
    const i = list.findIndex((s) => s.id === req.params.id);
    if (i === -1) return res.json({ ok: true });
    const [item] = list.splice(i, 1);
    // Mensagens já enviadas com esse item continuam funcionando: o arquivo
    // só sai do disco se nenhuma delas (nem outro item) apontar pra ele.
    for (const id of [item.mediaId, item.thumbId]) {
      if (id && !mediaStillReferenced(data, id)) store.deleteMediaFile(id);
    }
    store.persist(req.session.key, data);
    bus.emit('stickers-changed', {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/stickers/:id/send', requireAuth, express.json(), (req, res) => {
  const { sender, replyToId } = req.body || {};
  if (!sender || !String(sender).trim()) return res.status(400).json({ error: 'invalid' });
  try {
    const data = loadWithSessionKey(req);
    const item = (data.stickers || []).find((s) => s.id === req.params.id);
    if (!item || !store.mediaExists(item.mediaId)) return res.status(404).json({ error: 'not_found' });
    const message = {
      id: randomId(8),
      type: item.kind === 'gif' ? 'image' : 'sticker',
      sender: String(sender).trim().slice(0, 60),
      mediaId: item.mediaId,
      mimeType: item.mimeType,
      size: item.size,
      ts: Date.now(),
    };
    if (item.kind === 'gif') {
      message.gif = true;
      message.filename = 'animacao.gif';
      if (item.thumbId) message.thumbId = item.thumbId;
    }
    if (item.width && item.height) { message.width = item.width; message.height = item.height; }
    const replyTo = buildReplySnapshot(data, replyToId);
    if (replyTo) message.replyTo = replyTo;
    data.messages.push(message);
    // Só pra ordenar a bandeja por "usadas recentemente" na próxima carga.
    item.lastUsed = message.ts;
    store.persist(req.session.key, data);
    bus.emit('message', message);
    res.json({ ok: true, message });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// ===== Busca de GIF (GIPHY, opcional) =====
function isAllowedGifUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (e) {
    return null;
  }
  if (GIPHY_EXTRA_ORIGIN && u.origin === GIPHY_EXTRA_ORIGIN) return u;
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'giphy.com' || host.endsWith('.giphy.com')) return u;
  return null;
}

// Baixa uma imagem do GIPHY pro servidor, com teto de tamanho e de tempo.
async function fetchGifBytes(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal, redirect: 'follow' });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/') || !res.body) return null;
    // Redirecionou pra fora do GIPHY? Não segue.
    if (!isAllowedGifUrl(res.url)) return null;
    const chunks = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        try { reader.cancel(); } catch (e) { /* ignore */ }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), mimeType: type };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickGifRendition(images, names) {
  for (const name of names) {
    const r = images && images[name];
    const url = r && (r.url || r.webp);
    if (!url || !isAllowedGifUrl(url)) continue;
    return { url, width: parseDimension(r.width), height: parseDimension(r.height) };
  }
  return null;
}

roomRouter.get('/api/gifs/search', requireAuth, async (req, res) => {
  if (!GIPHY_API_KEY) return res.status(404).json({ error: 'disabled' });
  const q = String((req.query && req.query.q) || '').trim().slice(0, 80);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = 24;
  const params = new URLSearchParams({
    api_key: GIPHY_API_KEY,
    limit: String(limit),
    offset: String(offset),
    rating: GIPHY_RATING,
    bundle: 'messaging_non_clips',
  });
  if (q) {
    params.set('q', q);
    params.set('lang', 'pt');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${GIPHY_API_BASE}/v1/gifs/${q ? 'search' : 'trending'}?${params}`, { signal: controller.signal });
    if (!r.ok) return res.status(502).json({ error: 'giphy', message: 'A busca de GIFs não respondeu.' });
    const body = await r.json();
    const items = [];
    for (const g of body.data || []) {
      const preview = pickGifRendition(g.images, ['fixed_width_small', 'fixed_width_downsampled', 'fixed_width']);
      const full = pickGifRendition(g.images, ['downsized', 'downsized_medium', 'fixed_height', 'original']);
      if (!preview || !full) continue;
      items.push({
        id: String(g.id),
        title: String(g.title || '').slice(0, 120),
        preview: preview.url,
        url: full.url,
        width: full.width,
        height: full.height,
      });
    }
    const total = (body.pagination && body.pagination.total_count) || 0;
    res.json({ items, nextOffset: offset + limit < total ? offset + limit : null });
  } catch (e) {
    res.status(502).json({ error: 'giphy', message: 'A busca de GIFs não respondeu.' });
  } finally {
    clearTimeout(timer);
  }
});

// Prévia de um resultado da busca, repassada pelo servidor.
roomRouter.get('/api/gifs/preview', requireAuth, async (req, res) => {
  if (!GIPHY_API_KEY) return res.status(404).end();
  const url = isAllowedGifUrl(req.query && req.query.u);
  if (!url) return res.status(400).end();
  const got = await fetchGifBytes(url, GIF_PREVIEW_MAX_BYTES);
  if (!got) return res.status(502).end();
  res.setHeader('Content-Type', got.mimeType);
  res.setHeader('Content-Security-Policy', MEDIA_CSP);
  res.send(got.buffer);
});

// Manda um resultado da busca: o servidor baixa o GIF e guarda cifrado como
// qualquer outra mídia - a mensagem não depende mais do GIPHY depois disso.
roomRouter.post('/api/gifs/send', requireAuth, express.json(), async (req, res) => {
  if (!GIPHY_API_KEY) return res.status(404).json({ error: 'disabled' });
  const { sender, replyToId } = req.body || {};
  const url = isAllowedGifUrl(req.body && req.body.url);
  if (!url || !sender || !String(sender).trim()) return res.status(400).json({ error: 'invalid' });
  const got = await fetchGifBytes(url, MAX_GIF_BYTES);
  if (!got) return res.status(502).json({ error: 'giphy', message: 'Não foi possível baixar esse GIF.' });
  try {
    const data = loadWithSessionKey(req);
    const mediaId = randomId(16);
    store.saveMedia(req.session.key, mediaId, got.buffer);
    const message = {
      id: randomId(8),
      type: 'image',
      gif: true,
      sender: String(sender).trim().slice(0, 60),
      mediaId,
      filename: got.mimeType === 'image/webp' ? 'animacao.webp' : 'animacao.gif',
      mimeType: got.mimeType,
      size: got.buffer.length,
      ts: Date.now(),
    };
    const w = parseDimension(req.body.width);
    const h = parseDimension(req.body.height);
    if (w && h) { message.width = w; message.height = h; }
    const replyTo = buildReplySnapshot(data, replyToId);
    if (replyTo) message.replyTo = replyTo;
    data.messages.push(message);
    store.persist(req.session.key, data);
    bus.emit('message', message);
    res.json({ ok: true, message });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// ===== Portal "Hermes": conversa de verdade com o Hermes Agent =====
// Só a tela cheia do portal no app.js chama isto. Roda o agente local em modo
// one-shot, conversacional - só o toolset "memory", sem terminal/browser/redes
// sociais - e devolve a resposta. Nada aqui é salvo no histórico da conversa
// nem transmitido pro outro lado.
// Dois jeitos de chegar aqui, cada um com a sua variável no .env:
//  - HERMES_CODE: sessão "só Hermes", de quem digitou esse código na tela de
//    entrada (ver /api/login);
//  - HERMES_TRIGGER: alguém já dentro do chat que digitou a frase no campo de
//    mensagem (ver /api/boot).
function requireHermesAccess(req, res, next) {
  if (getHermesGuest(req)) return next();
  if (HERMES_TRIGGER && auth.getSession(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthenticated' });
}

// Um pedido por vez: é um modelo local, e dois de uma vez só fariam os dois
// demorarem (ou estourarem o tempo).
let hermesRunning = false;

roomRouter.post('/api/hermes', requireHermesAccess, express.json(), (req, res) => {
  const { execFile } = require('child_process');
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ ok: false, error: 'invalid' });
  if (hermesRunning) {
    return res.status(429).json({ ok: false, message: 'O Hermes ainda está respondendo. Tente de novo em instantes.' });
  }
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

  const HERMES_BIN = process.env.HERMES_BIN
    || path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes');

  // One-shot não tem estado entre chamadas, então mandamos um pedaço do
  // histórico recente só pra dar continuidade (a última msg do Juan já vem
  // separada em `text`, então tiramos ela do contexto pra não duplicar).
  const recent = history
    .slice(-12)
    .filter((m) => m && m.text && (m.role === 'juan' || m.role === 'hermes'));
  const ctx = recent.slice(0, -1);
  let prompt = '';
  if (ctx.length) {
    prompt += 'Conversa até agora (continue de forma natural, em português):\n';
    for (const m of ctx) {
      prompt += `${m.role === 'juan' ? 'Juan' : 'Hermes'}: ${String(m.text).slice(0, 2000)}\n`;
    }
    prompt += '\n';
  }
  prompt += `Juan: ${text}`;

  const args = ['--oneshot', prompt, '--toolsets', 'memory'];
  hermesRunning = true;
  execFile(HERMES_BIN, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    hermesRunning = false;
    const reply = (stdout || '').trim();
    if (reply) return res.json({ ok: true, reply });
    if (err && err.killed) {
      return res.status(504).json({ ok: false, message: 'O Hermes demorou demais pra responder.' });
    }
    console.error('[hermes] falhou:', err && err.message, String(stderr || '').slice(0, 400));
    return res.status(502).json({ ok: false, message: 'Não consegui falar com o Hermes agora.' });
  });
});

roomRouter.post('/api/clear', requireAuth, (req, res) => {
  try {
    // "Limpar conversa" apaga as mensagens e as mídias delas. A coleção de
    // figurinhas/GIFs e os atalhos de reação não são conversa - ficam.
    const data = loadWithSessionKey(req);
    const stickers = Array.isArray(data.stickers) ? data.stickers : [];
    const keepIds = new Set();
    for (const s of stickers) {
      if (s.mediaId) keepIds.add(s.mediaId);
      if (s.thumbId) keepIds.add(s.thumbId);
    }
    for (const handle of pendingExpiry.values()) clearTimeout(handle);
    pendingExpiry.clear();
    store.clearAll(req.session.key, { stickers, prefs: data.prefs || {} }, keepIds);
    bus.emit('cleared', {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Serve tanto o arquivo original (mediaId) quanto a miniatura (thumbId) -
// os dois são só blobs cifrados em data/media/, o que muda é o Content-Type
// e o nome sugerido.
roomRouter.get('/api/media/:id', requireAuth, (req, res) => {
  try {
    if (!/^[0-9a-f]{8,64}$/.test(req.params.id)) return res.status(404).end();
    const entry = getMediaIndex(req).get(req.params.id);
    if (!entry || !store.mediaExists(req.params.id)) return res.status(404).end();
    const isThumb = !!entry.thumb;
    const buf = store.loadMedia(req.session.key, req.params.id);
    // A miniatura é sempre JPEG (foi gerada por canvas.toBlob). Usar o
    // mimeType da mensagem aqui entregaria "video/mp4" pra thumb de um vídeo
    // e o <img> da grade não renderizaria nada.
    const mime = isThumb ? 'image/jpeg' : (entry.mimeType || 'application/octet-stream');
    res.setHeader('Content-Type', mime);
    const name = isThumb ? 'miniatura.jpg' : (entry.filename || 'arquivo');
    // Só foto/vídeo/áudio abrem "inline". Qualquer outra coisa (html, svg
    // disfarçado de arquivo, pdf, zip...) é sempre download - e mesmo o que
    // abre inline vai com a CSP "sandbox" (ver MEDIA_CSP): arquivo enviado
    // por usuário nunca roda como página dentro da origem do chat.
    const inline = /^(image|video|audio)\//.test(mime) && mime !== 'image/svg+xml';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Security-Policy', MEDIA_CSP);
    res.setHeader('Cache-Control', 'private, no-store');
    // Suporte a Range (206): o Safari (iPhone e Mac) exige isso pra tocar
    // <audio>/<video> - ele pede "bytes=0-1" primeiro e, se recebe 200 com
    // o arquivo inteiro, desiste e mostra o player com erro. Como o blob já
    // está decifrado em memória, é só fatiar o buffer.
    res.setHeader('Accept-Ranges', 'bytes');
    const total = buf.length;
    const range = req.headers.range;
    const rm = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (rm && (rm[1] !== '' || rm[2] !== '')) {
      let start;
      let end;
      if (rm[1] === '') {
        start = Math.max(0, total - parseInt(rm[2], 10));
        end = total - 1;
      } else {
        start = parseInt(rm[1], 10);
        end = rm[2] === '' ? total - 1 : Math.min(parseInt(rm[2], 10), total - 1);
      }
      if (start >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      return res.send(buf.subarray(start, end + 1));
    }
    res.send(buf);
  } catch (e) {
    res.status(401).end();
  }
});

// Retrofit das mídias enviadas antes das miniaturas existirem: a grade
// carrega o original desses tiles (pesado, mas funciona), gera a thumb no
// canvas e manda pra cá, uma por vez. Na próxima abertura o tile já é leve.
// Mesma filosofia do reconcileEphemeral - conserta sozinho conforme o app
// é usado, sem script de migração.
roomRouter.post('/api/media/:mediaId/thumb', requireAuth, upload.single('thumb'), (req, res) => {
  if (!req.file || !req.file.size || req.file.size > MAX_THUMB_BYTES) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.mediaId === req.params.mediaId);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (msg.deleted || msg.ephemeral) return res.status(403).json({ error: 'forbidden' });
    if (msg.type !== 'image' && msg.type !== 'video') return res.status(400).json({ error: 'invalid' });
    // Já tem: não desperdiça escrita nem deixa órfão o arquivo antigo.
    if (msg.thumbId) return res.json({ ok: true, thumbId: msg.thumbId });

    const thumbId = randomId(16);
    store.saveMedia(req.session.key, thumbId, req.file.buffer);
    msg.thumbId = thumbId;
    store.persist(req.session.key, data);
    res.json({ ok: true, thumbId });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

// Lista da aba "Mídia": só metadados de foto/vídeo, nenhum byte de arquivo.
// Mesma paginação "mais recentes primeiro" do /api/messages, mas aqui a
// ordem de saída é DECRESCENTE (mais nova primeiro), que é como a grade
// mostra. O cursor `before` é o id da última mensagem já recebida.
const MEDIA_PAGE_DEFAULT = 120;
const MEDIA_PAGE_MAX = 400;

roomRouter.get('/api/media-list', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    const all = data.messages;

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = MEDIA_PAGE_DEFAULT;
    limit = Math.min(limit, MEDIA_PAGE_MAX);

    let end = all.length;
    if (req.query.before) {
      const idx = all.findIndex((m) => m.id === String(req.query.before));
      if (idx !== -1) end = idx;
    }

    // Anda de trás pra frente juntando só o que a grade aceita, até fechar
    // o lote. `end` para na primeira mensagem que sobrou pra trás, então a
    // próxima página continua exatamente daí.
    const items = [];
    let i = end - 1;
    for (; i >= 0 && items.length < limit; i--) {
      const m = all[i];
      if (m.type !== 'image' && m.type !== 'video') continue;
      if (m.deleted || m.ephemeral || !m.mediaId) continue;
      if (!store.mediaExists(m.mediaId)) continue;
      items.push({
        id: m.id,
        type: m.type,
        mediaId: m.mediaId,
        thumbId: m.thumbId,
        width: m.width,
        height: m.height,
        sender: m.sender,
        ts: m.ts,
        filename: m.filename,
        // Pra grade marcar com estrela (e o menu do tile dizer "Desfavoritar")
        // o que esta pessoa já favoritou.
        starredBy: m.starredBy,
      });
    }

    res.json({ items, hasMore: i >= 0 });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.get('/api/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  // no-transform + X-Accel-Buffering: pede pros proxies no caminho (túnel,
  // Cloudflare) não comprimirem nem segurarem o stream em buffer.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  // Snapshot of who else is already in the room BEFORE this connection is
  // registered below - this is what lets the client show "fulano ja esta
  // online" the instant it connects, without waiting for a live event.
  const myPresenceName = String((req.query && req.query.name) || '').trim().slice(0, 60);
  const connId = randomId(8);
  const alreadyOnline = [...new Set([...onlineConnections.values()].filter(Boolean))];
  res.write(`event: presence-init\ndata: ${JSON.stringify({ online: alreadyOnline })}\n\n`);

  function broadcastPresence() {
    const online = [...new Set([...onlineConnections.values()].filter(Boolean))];
    bus.emit('presence', { online });
  }

  const onMessage = (message) => {
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  bus.on('message', onMessage);

  const onCleared = () => {
    res.write(`event: cleared\ndata: {}\n\n`);
  };
  bus.on('cleared', onCleared);

  const onDeleted = (payload) => {
    res.write(`event: message-deleted\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('message-deleted', onDeleted);

  // Lets the sender's own client update a "visualização única" bubble from
  // "enviado" to "aberto" the moment the other person opens it, without
  // revealing anything about the media itself (no mediaId in this payload).
  const onViewed = (payload) => {
    res.write(`event: message-viewed\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('message-viewed', onViewed);

  // Live presence updates from here on (either side joining/leaving) - keeps
  // every connected tab's online indicator in sync, not just the one-shot
  // check done above at connect time.
  const onPresence = (payload) => {
    res.write(`event: presence\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('presence', onPresence);

  // A link preview finished resolving (see scheduleLinkPreview) after the
  // message itself was already sent/broadcast - patches it onto the
  // already-rendered bubble instead of making the sender wait for it.
  const onMessageUpdated = (payload) => {
    res.write(`event: message-updated\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('message-updated', onMessageUpdated);

  // Alguém reagiu (ou removeu a reação de) uma mensagem - patch parcial na
  // bolha já renderizada, mesma ideia do message-updated acima.
  const onReacted = (payload) => {
    res.write(`event: message-reacted\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('message-reacted', onReacted);

  // Eventos que são só "repasse cru" pro cliente: favoritar, mudança na
  // coleção de figurinhas/GIFs e "digitando…".
  const passthrough = ['message-starred', 'stickers-changed', 'typing'].map((name) => {
    const fn = (payload) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    bus.on(name, fn);
    return [name, fn];
  });

  onlineConnections.set(connId, myPresenceName);
  broadcastPresence();

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    onlineConnections.delete(connId);
    broadcastPresence();
    bus.off('message', onMessage);
    bus.off('cleared', onCleared);
    bus.off('message-deleted', onDeleted);
    bus.off('message-viewed', onViewed);
    bus.off('presence', onPresence);
    bus.off('message-updated', onMessageUpdated);
    bus.off('message-reacted', onReacted);
    for (const [name, fn] of passthrough) bus.off(name, fn);
  });
});

roomRouter.get('/api/export', requireAuth, (req, res) => {
  let data;
  try {
    data = loadWithSessionKey(req);
  } catch (e) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="backup-conversa-${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error(err);
    res.status(500).end();
  });
  archive.pipe(res);

  // Ephemeral media is never bundled into the backup, at any point in its
  // life (locked, mid-countdown, or already expired) - exporting a
  // "visualização única" file would quietly defeat the entire point of it.
  archive.append(JSON.stringify(data.messages.map(sanitizeMessage), null, 2), { name: 'conversa.json' });

  const lines = data.messages.map((m) => {
    const when = new Date(m.ts).toLocaleString('pt-BR');
    const reactions = (m.reactions && m.reactions.length)
      ? ` [reações: ${m.reactions.map((r) => `${r.emoji} ${r.sender}`).join(', ')}]`
      : '';
    if (m.type === 'text') return `[${when}] ${m.sender}: ${m.text}${reactions}`;
    if (m.type === 'sticker' && !m.deleted) return `[${when}] ${m.sender}: (figurinha)${reactions}`;
    if (m.expiredEphemeral) return `[${when}] ${m.sender}: (mídia de visualização única, expirada)`;
    if (m.ephemeral) return `[${when}] ${m.sender}: (${m.type}, visualização única - não incluída no backup)${reactions}`;
    if (m.deleted) return `[${when}] ${m.sender}: (mensagem apagada por ${m.deletedBy || m.sender})`;
    return `[${when}] ${m.sender}: (${m.type}) ${m.filename || m.mediaId}${reactions}`;
  });
  archive.append(lines.join('\n'), { name: 'conversa.txt' });

  for (const m of data.messages) {
    if (m.ephemeral) continue;
    if (m.mediaId && store.mediaExists(m.mediaId)) {
      try {
        const buf = store.loadMedia(req.session.key, m.mediaId);
        const fallbackName = m.type === 'sticker' ? 'figurinha' : 'arquivo';
        const safeName = `${m.ts}-${m.mediaId}-${(m.filename || fallbackName).replace(/[/\\]/g, '_')}`;
        archive.append(buf, { name: `midias/${safeName}` });
      } catch (e) {
        // skip unreadable/corrupt file rather than failing the whole export
      }
    }
  }

  // A coleção de figurinhas e GIFs também vai no backup (pasta colecao/),
  // inclusive os itens que nunca foram enviados numa mensagem.
  for (const s of data.stickers || []) {
    if (!s.mediaId || !store.mediaExists(s.mediaId)) continue;
    try {
      const buf = store.loadMedia(req.session.key, s.mediaId);
      const ext = String(s.mimeType || '').split('/')[1] || 'bin';
      archive.append(buf, { name: `colecao/${s.kind === 'gif' ? 'gif' : 'figurinha'}-${s.id}.${ext.replace(/[^a-z0-9]/gi, '')}` });
    } catch (e) {
      // idem: pula o item ilegível
    }
  }

  archive.finalize();
});

app.use((req, res) => res.status(404).end());

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

app.listen(PORT, HOST, () => {
  console.log(`Chat privado rodando em http://${HOST}:${PORT}${ROOM_PATH}`);
  if (HOST === '0.0.0.0') {
    const lan = lanAddress();
    if (lan) console.log(`Na rede local: http://${lan}:${PORT}${ROOM_PATH}`);
  }
});
