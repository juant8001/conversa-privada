'use strict';

// Baixa a mídia de um link pra virar figurinha: posts do X/Twitter e GIFs ou
// figurinhas do GIPHY. O servidor só busca em hosts conhecidos (e confere de
// novo depois de cada redirecionamento), então um link qualquer colado no
// chat nunca faz o Mac abrir endereços da rede local.

const { spawn } = require('child_process');
function uerr(message) {
  // Erro que pode ir pra tela como está (já em português).
  const e = new Error(message);
  e.user = true;
  return e;
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LINK_BYTES = 40 * 1024 * 1024;

function hostIs(host, base) {
  return host === base || host.endsWith(`.${base}`);
}

function parseUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u;
  } catch (e) {
    return null;
  }
}

/** Primeiro link http(s) dentro de um texto colado. */
function findLink(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[),.!?]+$/, '') : null;
}

function tweetOf(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|mobile)\./, '');
  if (!['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com'].includes(host)) return null;
  const m = u.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/i);
  return m ? { user: m[1], id: m[2] } : null;
}

// IDs do GIPHY: giphy.com/gifs/nome-ID, giphy.com/stickers/nome-ID,
// giphy.com/embed/ID, media*.giphy.com/media/(v1.xxx/)ID/arquivo, i.giphy.com/ID.gif
function giphyIdOf(u) {
  const host = u.hostname.toLowerCase();
  if (!hostIs(host, 'giphy.com') && host !== 'gph.is') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (/^media\d*\.giphy\.com$/.test(host) || host === 'i.giphy.com') {
    const i = parts.indexOf('media');
    if (i !== -1) {
      id = parts[i + 1] && parts[i + 1].startsWith('v1.') ? parts[i + 2] : parts[i + 1];
    } else if (parts[0]) {
      id = parts[0].replace(/\.(gif|webp|mp4)$/i, '');
    }
  } else if (['gifs', 'stickers', 'clips'].includes(parts[0]) && parts[1]) {
    id = parts[1].split('-').pop();
  } else if (parts[0] === 'embed' && parts[1]) {
    id = parts[1];
  }
  return id && /^[A-Za-z0-9]{5,40}$/.test(id) ? id : null;
}

function isGiphyMediaUrl(u, extraOrigin) {
  if (extraOrigin && u.origin === extraOrigin) return true;
  if (u.protocol !== 'https:') return false;
  return hostIs(u.hostname.toLowerCase(), 'giphy.com');
}

// Download com teto de bytes e de tempo; `allowed(url)` é conferido também
// na URL final, depois dos redirecionamentos.
async function fetchLimited(url, allowed, { maxBytes = MAX_LINK_BYTES, timeoutMs = 45000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
    if (!res.ok || !res.body) throw uerr(`O link respondeu ${res.status}.`);
    if (!allowed(new URL(res.url))) throw uerr('O link redirecionou pra um lugar não permitido.');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw uerr('O arquivo desse link é grande demais.');
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > maxBytes) {
        try { reader.cancel(); } catch (e) { /* ignora */ }
        throw uerr('O arquivo desse link é grande demais.');
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), type: (res.headers.get('content-type') || '').split(';')[0].trim() };
  } catch (e) {
    if (e.name === 'AbortError') throw uerr('O link demorou demais pra responder.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function ytDlpPath() {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  for (const dir of [...String(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dir) continue;
    const p = path.join(dir, 'yt-dlp');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Plano B pro X quando a API pública não ajuda (post protegido, fora do ar).
async function viaYtDlp(url, ffmpegDir) {
  const bin = ytDlpPath();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-link-'));
  try {
    await new Promise((resolve, reject) => {
      const args = ['--no-playlist', '--no-progress', '--quiet', '--no-warnings',
        '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--max-filesize', '40M',
        '-o', path.join(dir, 'midia.%(ext)s'), url];
      if (ffmpegDir) args.unshift('--ffmpeg-location', ffmpegDir);
      const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (c) => {
        clearTimeout(timer);
        if (c === 0) resolve();
        else reject(new Error(`yt-dlp: ${err.trim().split('\n').pop() || c}`));
      });
    });
    const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
    if (!files.length) return null;
    const file = path.join(dir, files[0]);
    if (fs.statSync(file).size > MAX_LINK_BYTES) throw uerr('O arquivo desse link é grande demais.');
    return { buffer: fs.readFileSync(file), source: 'x' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function fromTweet(tweet, url, opts) {
  const apiBase = (process.env.FXTWITTER_API_BASE || 'https://api.fxtwitter.com').replace(/\/$/, '');
  const testOrigin = process.env.FXTWITTER_API_BASE ? new URL(apiBase).origin : null;
  const mediaAllowed = (u) => (testOrigin && u.origin === testOrigin)
    || (u.protocol === 'https:' && hostIs(u.hostname.toLowerCase(), 'twimg.com'));
  let apiError = null;
  try {
    const got = await fetchLimited(`${apiBase}/${encodeURIComponent(tweet.user)}/status/${tweet.id}`,
      (u) => u.origin === new URL(apiBase).origin, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20000 });
    const json = JSON.parse(got.buffer.toString('utf8'));
    const all = (json && json.tweet && json.tweet.media && json.tweet.media.all) || [];
    // Vídeo/GIF primeiro (vira figurinha animada); só foto = figurinha parada.
    const pick = all.find((m) => m.type === 'gif') || all.find((m) => m.type === 'video') || all.find((m) => m.type === 'photo');
    if (pick && pick.url) {
      const mediaUrl = parseUrl(pick.url);
      if (!mediaUrl || !mediaAllowed(mediaUrl)) throw new Error('mídia fora do X');
      const media = await fetchLimited(mediaUrl.toString(), mediaAllowed);
      return { buffer: media.buffer, source: 'x' };
    }
    if (json && json.tweet) throw Object.assign(uerr('Esse post não tem foto, GIF nem vídeo.'), { final: true });
  } catch (e) {
    if (e.final) throw e;
    apiError = e;
  }
  const viaDl = await viaYtDlp(url, opts.ffmpegDir).catch(() => null);
  if (viaDl) return viaDl;
  void apiError;
  throw uerr('Não consegui baixar esse post do X. Se ele for de conta fechada, não tem como.');
}

async function fromGiphy(u, opts) {
  const allowed = (x) => isGiphyMediaUrl(x, opts.giphyExtraOrigin);
  // Link direto de arquivo (inclusive os resultados da busca do próprio chat).
  if (/\.(gif|webp|mp4)$/i.test(u.pathname) && allowed(u)) {
    return { buffer: (await fetchLimited(u.toString(), allowed)).buffer, source: 'giphy' };
  }
  const id = giphyIdOf(u);
  if (!id) throw uerr('Não achei o GIF nesse link do GIPHY.');
  let mediaUrl = `https://media.giphy.com/media/${id}/giphy.gif`;
  if (opts.giphyKey) {
    try {
      const params = new URLSearchParams({ api_key: opts.giphyKey });
      const got = await fetchLimited(`${opts.giphyBase}/v1/gifs/${id}?${params}`,
        (x) => x.origin === new URL(opts.giphyBase).origin, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
      const images = (JSON.parse(got.buffer.toString('utf8')).data || {}).images || {};
      // GIF (mantém a transparência das figurinhas do GIPHY); o original
      // pode ser enorme, então cai pra versões menores se precisar.
      for (const name of ['original', 'downsized_medium', 'downsized', 'fixed_width']) {
        const r = images[name];
        const cand = r && r.url && parseUrl(r.url);
        if (!cand || !allowed(cand)) continue;
        if (name === 'original' && Number(r.size || 0) > 15 * 1024 * 1024) continue;
        mediaUrl = cand.toString();
        break;
      }
    } catch (e) {
      // sem API: tenta o endereço padrão do arquivo
    }
  }
  return { buffer: (await fetchLimited(mediaUrl, allowed)).buffer, source: 'giphy' };
}

/**
 * Baixa a mídia do link. Devolve { buffer, source: 'x' | 'giphy' }.
 * opts: { giphyKey, giphyBase, giphyExtraOrigin, ffmpegDir }
 */
async function fetchLinkMedia(raw, opts = {}) {
  const link = findLink(raw) || String(raw || '').trim();
  const u = parseUrl(link);
  if (!u) throw uerr('Isso não parece um link.');
  const tweet = tweetOf(u);
  if (tweet) return fromTweet(tweet, u.toString(), opts);
  if (hostIs(u.hostname.toLowerCase(), 'giphy.com') || (opts.giphyExtraOrigin && u.origin === opts.giphyExtraOrigin)) {
    return fromGiphy(u, opts);
  }
  throw uerr('Por enquanto só links do X/Twitter e do GIPHY viram figurinha.');
}

module.exports = { fetchLinkMedia, findLink, giphyIdOf, tweetOf };
