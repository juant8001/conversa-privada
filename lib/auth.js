'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'pc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAILS = 6;
const LOCK_MS = 10 * 60 * 1000; // 10 minutes

// Regenerated every process start -> all cookies invalidated on restart
// (nobody's plaintext code or key is ever written to disk).
const SESSION_SECRET = crypto.randomBytes(32);

const sessions = new Map(); // sessionId -> { key: Buffer, createdAt }
const attempts = new Map(); // ip -> { fails, lockUntil }

function sign(value) {
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${h}`;
}

function unsign(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  if (expected.length !== signed.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signed));
  return ok ? value : null;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function createSession(res, key, roomPath) {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { key, createdAt: Date.now() });
  const cookieVal = encodeURIComponent(sign(id));
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : '; Secure';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${cookieVal}; Path=${roomPath}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure}`
  );
  return id;
}

function destroySession(req, res, roomPath) {
  const cookies = parseCookies(req);
  const id = unsign(cookies[COOKIE_NAME]);
  if (id) sessions.delete(id);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=${roomPath}; HttpOnly; Max-Age=0`);
}

function getSession(req) {
  const cookies = parseCookies(req);
  const id = unsign(cookies[COOKIE_NAME]);
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return { id, ...s };
}

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function isLocked(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (rec.lockUntil && rec.lockUntil > Date.now()) return true;
  return false;
}

function registerFailure(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip) || { fails: 0, lockUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
}

function registerSuccess(req) {
  attempts.delete(clientIp(req));
}

module.exports = {
  createSession,
  destroySession,
  getSession,
  isLocked,
  registerFailure,
  registerSuccess,
};
