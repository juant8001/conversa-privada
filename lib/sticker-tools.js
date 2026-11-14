'use strict';

// Converte imagem, GIF ou vídeo em figurinha: WebP com o maior lado em até
// 512px, animada quando a entrada é animada. Tudo roda em programas do
// próprio Mac (ffmpeg + as ferramentas do pacote "webp" do Homebrew), sem
// dependência nova no package.json.
//
// Dois caminhos, escolhidos sozinhos:
//  - o ffmpeg sabe gerar WebP (tem o encoder libwebp_anim): faz tudo nele;
//  - o ffmpeg do Homebrew NÃO tem esse encoder: o ffmpeg só tira os quadros
//    em PNG e o img2webp/cwebp monta o WebP.
// Sem ffmpeg (ou sem nenhum dos dois caminhos) a conversão fica desligada e
// o resto do chat segue igual.

const { spawn, spawnSync } = require('child_process');
function uerr(message) {
  // Erro que pode ir pra tela como está (já em português).
  const e = new Error(message);
  e.user = true;
  return e;
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const ANIM_TARGET_BYTES = 1024 * 1024; // figurinha animada: até ~1MB
const STATIC_TARGET_BYTES = 300 * 1024;
const RUN_TIMEOUT_MS = 90 * 1000;

function findBin(name, envVar) {
  const fromEnv = envVar && process.env[envVar];
  if (fromEnv) return isExecutable(fromEnv) ? fromEnv : null;
  const dirs = [...String(process.env.PATH || '').split(':').filter(Boolean), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

let toolsCache = null;
function tools() {
  if (toolsCache) return toolsCache;
  const ffmpeg = findBin('ffmpeg', 'FFMPEG_PATH');
  let libwebp = false;
  if (ffmpeg) {
    const out = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 });
    libwebp = /\blibwebp_anim\b/.test(out.stdout || '') && /\blibwebp\b/.test(out.stdout || '');
  }
  const img2webp = findBin('img2webp', 'IMG2WEBP_PATH');
  const cwebp = findBin('cwebp', 'CWEBP_PATH');
  // gif2webp é o único que mantém a transparência num WebP animado com
  // perda (o img2webp -lossy e o libwebp_anim do ffmpeg jogam o alfa fora).
  const gif2webp = findBin('gif2webp', 'GIF2WEBP_PATH');
  // STICKER_ENCODER=img2webp força o segundo caminho (existe pra teste).
  let mode = null;
  if (ffmpeg && libwebp && process.env.STICKER_ENCODER !== 'img2webp') mode = 'ffmpeg';
  else if (ffmpeg && img2webp && cwebp) mode = 'img2webp';
  toolsCache = { ffmpeg, img2webp, cwebp, gif2webp, mode };
  return toolsCache;
}

function available() {
  return !!tools().mode;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), RUN_TIMEOUT_MS);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} falhou: ${err.trim().split('\n').pop() || code}`));
    });
  });
}

// Uma conversão por vez: são pesadas, e o servidor é o Mac de alguém.
let queue = Promise.resolve();
function serialize(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// Lê largura, altura e se é animado direto do cabeçalho do WebP.
function webpInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const flags = buf[20];
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { width, height, animated: !!(flags & 0x02) };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, animated: false };
  }
  return null;
}

function sniffType(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'video'; // webm/mkv
  return 'unknown';
}

function scaleFilter(side) {
  // Maior lado em até `side` px, sem esticar o que já é menor.
  return `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
}

async function convertStatic(t, dir, input) {
  const png = path.join(dir, 'quadro.png');
  const out = path.join(dir, 'saida.webp');
  await run(t.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-frames:v', '1', '-vf', `${scaleFilter(512)},format=rgba`, png]);
  let result = null;
  for (const q of [88, 75, 60, 45]) {
    if (t.mode === 'ffmpeg') {
      await run(t.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png,
        '-c:v', 'libwebp', '-q:v', String(q), '-compression_level', '5', out]);
    } else {
      await run(t.cwebp, ['-quiet', '-q', String(q), '-alpha_q', '90', '-m', '5', png, '-o', out]);
    }
    result = fs.readFileSync(out);
    if (result.length <= STATIC_TARGET_BYTES) break;
  }
  return result;
}

const ANIM_ATTEMPTS = [
  { fps: 15, q: 70, dur: 8, side: 512 },
  { fps: 12, q: 55, dur: 8, side: 512 },
  { fps: 10, q: 45, dur: 6, side: 384 },
  { fps: 10, q: 35, dur: 5, side: 320 },
  { fps: 8, q: 30, dur: 4, side: 256 },
];

async function convertAnimated(t, dir, input) {
  const out = path.join(dir, 'saida.webp');
  let result = null;
  for (const a of ANIM_ATTEMPTS) {
    const vf = `fps=${a.fps},${scaleFilter(a.side)},format=rgba`;
    if (t.mode === 'ffmpeg') {
      await run(t.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-t', String(a.dur), '-vf', vf, '-an', '-c:v', 'libwebp_anim', '-lossless', '0',
        '-q:v', String(a.q), '-compression_level', '4', '-loop', '0', out]);
    } else {
      const framesDir = path.join(dir, `q${a.q}`);
      fs.mkdirSync(framesDir);
      await run(t.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-t', String(a.dur), '-vf', vf, '-an', path.join(framesDir, '%04d.png')]);
      const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort();
      if (!frames.length) throw uerr('Não deu pra ler os quadros desse arquivo.');
      const delay = String(Math.round(1000 / a.fps));
      await run(t.img2webp, ['-loop', '0', '-lossy', '-q', String(a.q), '-m', '4', '-d', delay,
        ...frames.map((f) => path.join(framesDir, f)), '-o', out]);
    }
    result = fs.readFileSync(out);
    if (result.length <= ANIM_TARGET_BYTES) break;
  }
  return result;
}

// GIF (pode ter fundo transparente, como as figurinhas do GIPHY): o ffmpeg
// reduz tamanho, quadros e duração gerando OUTRO GIF com a transparência
// preservada na paleta, e o gif2webp faz o WebP com perda mantendo o alfa.
async function convertGif(t, dir, input) {
  const out = path.join(dir, 'saida.webp');
  let result = null;
  for (const a of ANIM_ATTEMPTS) {
    const small = path.join(dir, `q${a.q}.gif`);
    await run(t.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', String(a.dur),
      '-filter_complex',
      `[0:v]fps=${a.fps},${scaleFilter(a.side)},split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=3`,
      '-loop', '0', small]);
    await run(t.gif2webp, ['-quiet', '-lossy', '-q', String(a.q), '-m', '4', small, '-o', out]);
    result = fs.readFileSync(out);
    if (result.length <= ANIM_TARGET_BYTES) break;
  }
  return result;
}

/**
 * Converte `buffer` em figurinha.
 * Devolve { buffer, mimeType: 'image/webp', width, height, animated }.
 * WebP que já é figurinha (até 512px e até `passthroughMax` bytes) passa
 * direto: o ffmpeg nem sabe abrir WebP animado.
 */
async function toSticker(buffer, { passthroughMax = 1024 * 1024 } = {}) {
  const kind = sniffType(buffer);
  if (kind === 'webp') {
    const info = webpInfo(buffer);
    if (!info) throw uerr('Esse WebP não abriu.');
    if (info.animated || (buffer.length <= passthroughMax && Math.max(info.width, info.height) <= 768)) {
      if (buffer.length > passthroughMax) throw uerr('Essa figurinha animada é grande demais.');
      return { buffer, mimeType: 'image/webp', width: info.width, height: info.height, animated: info.animated };
    }
  }
  const t = tools();
  if (!t.mode && kind === 'gif' && buffer.length <= passthroughMax && buffer.length >= 10) {
    // Sem conversor: GIF pequeno entra como está (o navegador anima igual).
    return { buffer, mimeType: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), animated: true };
  }
  if (!t.mode) {
    const err = uerr('Este servidor não tem as ferramentas pra converter (ffmpeg e webp).');
    err.code = 'NO_TOOLS';
    throw err;
  }
  if (kind === 'unknown') throw uerr('Esse arquivo não parece imagem, GIF nem vídeo.');
  return serialize(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fig-'));
    try {
      const input = path.join(dir, 'entrada');
      fs.writeFileSync(input, buffer);
      const animated = kind === 'gif' || kind === 'video';
      let out;
      if (kind === 'gif' && t.gif2webp) out = await convertGif(t, dir, input);
      else if (animated) out = await convertAnimated(t, dir, input);
      else out = await convertStatic(t, dir, input);
      const info = webpInfo(out);
      if (!info) throw uerr('A conversão não gerou uma figurinha válida.');
      return { buffer: out, mimeType: 'image/webp', width: info.width, height: info.height, animated: info.animated };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

module.exports = { available, toSticker, webpInfo, sniffType, tools };
