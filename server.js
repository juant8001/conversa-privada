'use strict';

require('./lib/env')();

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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

// Conjunto fixo de reações (estilo WhatsApp - sem teclado de emoji). Mantém
// em sincronia com REACTION_EMOJIS em public/app.js.
const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

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
    if ('.,!?;:'.includes(last)) { raw = raw.slice(0, -1); continue; }
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

function expireEphemeralMessage(data, msg) {
  if (msg.mediaId) store.deleteMediaFile(msg.mediaId);
  // Mídia de visualização única nunca chega a ganhar thumbId (ver POST
  // /api/media), mas apagar aqui também é uma linha e fecha a porta caso
  // algum caminho futuro passe a gravar uma.
  if (msg.thumbId) store.deleteMediaFile(msg.thumbId);
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

// Anything that doesn't match our exact room path is a dead end.
// Wrong slug (or no slug) => 404, not a hint that a chat app lives here.
app.use((req, res, next) => {
  if (req.path === ROOM_PATH || req.path.startsWith(`${ROOM_PATH}/`)) return next();
  return res.status(404).end();
});

const roomRouter = express.Router();
app.use(ROOM_PATH, roomRouter);

roomRouter.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore' }));

roomRouter.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

roomRouter.get('/api/me', (req, res) => {
  const session = auth.getSession(req);
  res.json({ authenticated: !!session });
});

// Senha-armadilha: nunca cria sessão real, nunca conta como tentativa
// errada (não alimenta o rate limit nem aparece nos logs de falha), e não
// chega perto do store/criptografia de verdade. Só sinaliza pro front-end
// mostrar uma tela falsa. Existe pra alguém que não devia estar tentando
// entrar (mas sabe/adivinha esse código específico) não ver rate limit,
// erro de "código incorreto" nem qualquer pista de que existe um chat de
// verdade por trás.
const DECOY_CODE = 'juan123myosotis';

roomRouter.post('/api/login', express.json(), async (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (code === DECOY_CODE) {
    return res.json({ ok: true, decoy: true });
  }
  if (auth.isLocked(req)) {
    return res.status(429).json({ error: 'locked', message: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  if (!code || code.length < 4) {
    return res.status(400).json({ error: 'invalid', message: 'Codigo muito curto.' });
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

const REPLY_SNIPPET_LABELS = {
  image: '📷 Foto',
  video: '🎥 Video',
  audio: '🎤 Audio',
  file: '📄 Arquivo',
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
    snippet = REPLY_SNIPPET_LABELS[original.type] || 'Arquivo';
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
  function parseDimension(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n <= 20000 ? n : undefined;
  }
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

    if (msg.mediaId) store.deleteMediaFile(msg.mediaId);
    if (msg.thumbId) store.deleteMediaFile(msg.thumbId);

    msg.deleted = true;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
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

// Reação a uma mensagem (❤️ 👍 😂 😮 😢 🔥). Uma reação por pessoa por
// mensagem, com toggle: reagir com o mesmo emoji remove; com outro, troca.
// Mesmo modelo de confiança do "apagar" - o servidor confia no requesterName
// que o cliente manda (sala privada de 2 pessoas).
roomRouter.post('/api/messages/:id/react', requireAuth, express.json(), (req, res) => {
  const { requesterName, emoji } = req.body || {};
  if (!requesterName || !String(requesterName).trim() || !REACTION_EMOJIS.includes(emoji)) {
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

roomRouter.post('/api/clear', requireAuth, (req, res) => {
  try {
    store.clearAll(req.session.key);
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
    const data = loadStoreOnly(req);
    const msg = data.messages.find(
      (m) => m.mediaId === req.params.id || m.thumbId === req.params.id
    );
    if (!msg) return res.status(404).end();
    const isThumb = msg.thumbId === req.params.id;
    const buf = store.loadMedia(req.session.key, req.params.id);
    // A miniatura é sempre JPEG (foi gerada por canvas.toBlob). Usar o
    // msg.mimeType aqui entregaria "video/mp4" pra thumb de um vídeo e o
    // <img> da grade não renderizaria nada.
    res.setHeader('Content-Type', isThumb ? 'image/jpeg' : (msg.mimeType || 'application/octet-stream'));
    const name = isThumb ? 'miniatura.jpg' : (msg.filename || 'arquivo');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
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
      });
    }

    res.json({ items, hasMore: i >= 0 });
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.get('/api/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
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
        const safeName = `${m.ts}-${m.mediaId}-${(m.filename || 'arquivo').replace(/[/\\]/g, '_')}`;
        archive.append(buf, { name: `midias/${safeName}` });
      } catch (e) {
        // skip unreadable/corrupt file rather than failing the whole export
      }
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
