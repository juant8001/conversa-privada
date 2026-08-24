'use strict';

require('./lib/env')();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { EventEmitter } = require('events');

const { Store, WrongCodeError } = require('./lib/store');
const auth = require('./lib/auth');
const { randomId } = require('./lib/crypto');

const PORT = parseInt(process.env.PORT || '4177', 10);
const ROOM_SLUG = process.env.ROOM_SLUG;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '300', 10);

if (!ROOM_SLUG || ROOM_SLUG.length < 16) {
  console.error('ROOM_SLUG ausente ou muito curto. Configure um valor aleatorio e longo em .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(DATA_DIR);
const bus = new EventEmitter();
bus.setMaxListeners(50);

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

roomRouter.post('/api/login', express.json(), async (req, res) => {
  if (auth.isLocked(req)) {
    return res.status(429).json({ error: 'locked', message: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  const code = (req.body && req.body.code) || '';
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
  if (original.deleted) {
    snippet = 'Mensagem apagada pelo autor';
  } else if (original.type === 'text') {
    snippet = original.text.length > 140 ? `${original.text.slice(0, 140)}...` : original.text;
  } else {
    snippet = REPLY_SNIPPET_LABELS[original.type] || 'Arquivo';
  }
  return { id: original.id, sender: original.sender, snippet };
}

roomRouter.get('/api/messages', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    res.json({ messages: data.messages });
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
    bus.emit('message', message);
    res.json({ ok: true, message });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'unauthenticated' });
  }
});

roomRouter.post('/api/media', requireAuth, upload.single('file'), (req, res) => {
  const { sender, replyToId } = req.body || {};
  if (!req.file || !sender || !String(sender).trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  const mime = req.file.mimetype || 'application/octet-stream';
  let type = 'file';
  if (mime.startsWith('image/')) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';

  try {
    const data = loadWithSessionKey(req);
    const mediaId = randomId(16);
    store.saveMedia(req.session.key, mediaId, req.file.buffer);
    const message = {
      id: randomId(8),
      type,
      sender: String(sender).trim().slice(0, 60),
      mediaId,
      filename: (req.file.originalname || 'arquivo').slice(0, 200),
      mimeType: mime,
      size: req.file.size,
      ts: Date.now(),
    };
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
    if (msg.sender !== String(requesterName).trim()) {
      return res.status(403).json({ error: 'forbidden', message: 'So quem enviou pode apagar essa mensagem.' });
    }

    if (msg.mediaId) store.deleteMediaFile(msg.mediaId);

    msg.deleted = true;
    msg.deletedAt = Date.now();
    delete msg.text;
    delete msg.mediaId;
    delete msg.filename;
    delete msg.mimeType;
    delete msg.size;

    store.persist(req.session.key, data);
    bus.emit('message-deleted', { id: msg.id, sender: msg.sender, deletedAt: msg.deletedAt });
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

roomRouter.get('/api/media/:id', requireAuth, (req, res) => {
  try {
    const data = loadWithSessionKey(req);
    const msg = data.messages.find((m) => m.mediaId === req.params.id);
    if (!msg) return res.status(404).end();
    const buf = store.loadMedia(req.session.key, req.params.id);
    res.setHeader('Content-Type', msg.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(msg.filename || 'arquivo')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (e) {
    res.status(401).end();
  }
});

roomRouter.get('/api/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

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

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('message', onMessage);
    bus.off('cleared', onCleared);
    bus.off('message-deleted', onDeleted);
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

  archive.append(JSON.stringify(data.messages, null, 2), { name: 'conversa.json' });

  const lines = data.messages.map((m) => {
    const when = new Date(m.ts).toLocaleString('pt-BR');
    if (m.type === 'text') return `[${when}] ${m.sender}: ${m.text}`;
    return `[${when}] ${m.sender}: (${m.type}) ${m.filename || m.mediaId}`;
  });
  archive.append(lines.join('\n'), { name: 'conversa.txt' });

  for (const m of data.messages) {
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Chat privado rodando em http://127.0.0.1:${PORT}${ROOM_PATH}`);
});
