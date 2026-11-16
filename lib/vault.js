'use strict';

// Cofre (v52): uma aba só do dono (VAULT_OWNER no .env) com fotos, vídeos,
// áudios e figurinhas que vieram de um .zip, pra mandar na conversa sem
// procurar arquivo nenhum.
//
// O que fica no Mac é só texto cifrado, com uma chave que sai de um código
// que SÓ o dono sabe (scrypt, igual ao código do chat, mas outro código e
// outro sal): nem quem tem o código da conversa abre o cofre, e nenhum
// arquivo tem extensão ou cabeçalho de imagem pro Finder/Fotos mostrar.
//
//   data/vault/salt.bin            sal (público)
//   data/vault/index.enc           lista das mídias (cifrada)
//   data/vault/blobs/<id>.enc      cada mídia (cifrada)
//   data/vault/thumbs/<id>.enc     miniatura de foto/vídeo (cifrada)
//   data/vault/zips/<id>.enc       o .zip original inteiro (cifrado em fluxo)
//   data/vault/inbox/*.zip         zip esperando a importação (EM CLARO: só
//                                  até a importação terminar e conferir)
//
// A importação precisa da chave, então só começa quando o dono cria (ou
// abre) o cofre na tela. Ordem: cifra o zip inteiro e confere que ele volta
// igual; separa as mídias (lib/vault-extract.py lê o zip e manda cada
// arquivo pela saída padrão, nada vai pro disco em claro); HEIC vira JPEG e
// foto/vídeo ganham miniatura - essas duas conversões precisam de arquivo,
// então usam uma pasta temporária privada (data/vault/tmp, 0700) apagada na
// hora; no fim apaga o zip em claro. Se o servidor cair no meio, continua de
// onde parou na próxima vez que o cofre for aberto.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform, Writable } = require('stream');
const { deriveKey, encryptBuffer, decryptBuffer, randomId } = require('./crypto');

let dir = null;
let ffmpegBin = () => null;

function init(opts) {
  dir = path.join(opts.dataDir, 'vault');
  if (opts.ffmpeg) ffmpegBin = opts.ffmpeg;
}

function owner() {
  return String(process.env.VAULT_OWNER || '').trim();
}
function enabled() {
  return !!owner();
}
function isOwner(name) {
  const o = owner().toLowerCase();
  return !!o && String(name || '').trim().toLowerCase() === o;
}

const p = {
  salt: () => path.join(dir, 'salt.bin'),
  index: () => path.join(dir, 'index.enc'),
  blob: (id) => path.join(dir, 'blobs', `${id}.enc`),
  thumb: (id) => path.join(dir, 'thumbs', `${id}.enc`),
  zip: (id) => path.join(dir, 'zips', `${id}.enc`),
  inbox: () => path.join(dir, 'inbox'),
  tmp: () => path.join(dir, 'tmp'),
};

function userError(message, status) {
  const e = new Error(message);
  e.user = true;
  e.status = status || 400;
  return e;
}

function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function exists() {
  return fs.existsSync(p.index()) && fs.existsSync(p.salt());
}

function inboxZips() {
  try {
    return fs.readdirSync(p.inbox()).filter((f) => /\.zip$/i.test(f) && !f.startsWith('.')).sort();
  } catch (e) {
    return [];
  }
}

// ---- chave e índice ----
let index = null;      // índice decifrado em memória (enquanto alguém abriu)
let indexKeyId = null; // impressão da chave que abriu esse índice

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function readIndex(key) {
  if (index && indexKeyId === keyId(key)) return index;
  const data = JSON.parse(decryptBuffer(key, fs.readFileSync(p.index())).toString('utf8'));
  index = data;
  indexKeyId = keyId(key);
  return index;
}

function saveIndex(key) {
  atomicWrite(p.index(), encryptBuffer(key, Buffer.from(JSON.stringify(index))));
}

// Tentativas erradas: 5 seguidas travam por 10 minutos.
let fails = 0;
let lockedUntil = 0;

async function unlock(code) {
  if (!exists()) throw userError('O cofre ainda não foi criado.', 404);
  if (Date.now() < lockedUntil) throw userError('Muitas tentativas erradas. Espere uns minutos.', 429);
  const key = await deriveKey(String(code || ''), fs.readFileSync(p.salt()));
  try {
    readIndex(key);
  } catch (e) {
    fails += 1;
    if (fails >= 5) {
      fails = 0;
      lockedUntil = Date.now() + 10 * 60 * 1000;
    }
    throw userError('Código do cofre errado.', 401);
  }
  fails = 0;
  return key;
}

async function setup(code) {
  if (exists()) throw userError('O cofre já existe.', 409);
  const c = String(code || '');
  if (c.length < 6) throw userError('Use pelo menos 6 caracteres.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(16);
  atomicWrite(p.salt(), salt);
  const key = await deriveKey(c, salt);
  index = { v: 1, createdAt: Date.now(), items: [], seen: {}, hashes: {}, zips: {} };
  indexKeyId = keyId(key);
  saveIndex(key);
  return key;
}

// ---- tipos ----
const KINDS = {
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.png': ['image', 'image/png'],
  '.gif': ['image', 'image/gif'], '.heic': ['image', 'image/heic'], '.heif': ['image', 'image/heic'],
  '.webp': ['sticker', 'image/webp'],
  '.mov': ['video', 'video/quicktime'], '.mp4': ['video', 'video/mp4'], '.m4v': ['video', 'video/mp4'], '.3gp': ['video', 'video/3gpp'],
  '.opus': ['audio', 'audio/ogg'], '.ogg': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'],
  '.mp3': ['audio', 'audio/mpeg'], '.aac': ['audio', 'audio/aac'], '.wav': ['audio', 'audio/wav'],
};

// Export do WhatsApp: "00001234-PHOTO-2025-03-01-12-34-56.jpg".
function tsFromName(name, mtime) {
  const m = /(20\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)/.exec(name);
  if (m) {
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (Number.isFinite(t)) return t;
  }
  return mtime ? Math.round(mtime * 1000) : Date.now();
}

function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...(opts || {}) }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const SIPS = '/usr/bin/sips';

async function imageDims(file) {
  try {
    const { stdout } = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = /pixelWidth:\s*(\d+)/.exec(stdout);
    const h = /pixelHeight:\s*(\d+)/.exec(stdout);
    return w && h ? { w: +w[1], h: +h[1] } : {};
  } catch (e) {
    return {};
  }
}

// Converte/mede numa pasta temporária privada, apagada logo depois.
async function withTemp(buf, ext, fn) {
  fs.mkdirSync(p.tmp(), { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(p.tmp(), 'x-'));
  const input = path.join(work, `in${ext}`);
  try {
    fs.writeFileSync(input, buf, { mode: 0o600 });
    return await fn(input, work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function prepareImage(buf, ext) {
  if (!fs.existsSync(SIPS)) return { buf, mime: KINDS[ext][1] };
  return withTemp(buf, ext, async (input, work) => {
    let full = buf;
    let mime = KINDS[ext][1];
    let src = input;
    if (ext === '.heic' || ext === '.heif') {
      const jpg = path.join(work, 'full.jpg');
      await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', input, '--out', jpg]);
      full = fs.readFileSync(jpg);
      mime = 'image/jpeg';
      src = jpg;
    }
    const dims = await imageDims(src);
    let thumb = null;
    try {
      const t = path.join(work, 'thumb.jpg');
      await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '360', src, '--out', t]);
      thumb = fs.readFileSync(t);
    } catch (e) { /* sem miniatura: a grade mostra um ícone */ }
    return { buf: full, mime, thumb, ...dims };
  });
}

async function prepareVideo(buf, ext) {
  const ff = ffmpegBin();
  if (!ff) return { buf, mime: KINDS[ext][1] };
  return withTemp(buf, ext, async (input, work) => {
    const t = path.join(work, 'thumb.jpg');
    let info = '';
    let thumb = null;
    for (const ss of ['0.5', '0']) {
      try {
        const r = await run(ff, ['-hide_banner', '-y', '-ss', ss, '-i', input, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', t]);
        info = r.stderr;
        if (fs.existsSync(t) && fs.statSync(t).size > 0) {
          thumb = fs.readFileSync(t);
          break;
        }
      } catch (e) {
        info = e.stderr || '';
      }
    }
    const d = /Video:.*?[ ,](\d{2,5})x(\d{2,5})[ ,\]]/.exec(info);
    const dur = /Duration: (\d+):(\d\d):(\d\d)/.exec(info);
    let w = d ? +d[1] : undefined;
    let h = d ? +d[2] : undefined;
    // Vídeo do iPhone gravado em pé vem com rotação nos metadados.
    if (w && h && /rotate\s*:\s*-?(90|270)|rotation of -?(90|270)/.test(info)) [w, h] = [h, w];
    return {
      buf, mime: KINDS[ext][1], thumb, w, h,
      dur: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : undefined,
    };
  });
}

// ---- importação ----
let job = null; // { phase, done, total, error }

function status() {
  return job ? { phase: job.phase, done: job.done, total: job.total } : null;
}

function startImport(key) {
  if (job || !inboxZips().length) return;
  job = { phase: 'começando', done: 0, total: 0 };
  runImport(key)
    .catch((e) => {
      console.error('cofre: importação parou:', e && e.message);
    })
    .finally(() => {
      job = null;
    });
}

async function runImport(key) {
  for (const name of inboxZips()) {
    const zipPath = path.join(p.inbox(), name);
    readIndex(key);
    if (!index.zips[name] || !index.zips[name].ok) {
      job.phase = 'cifrando o zip original';
      const id = randomId(12);
      const { sha, size } = await encryptStream(key, zipPath, p.zip(id));
      job.phase = 'conferindo o zip cifrado';
      const back = await decryptStreamSha(key, p.zip(id));
      if (back !== sha) throw new Error('o zip cifrado não confere');
      if (index.zips[name] && index.zips[name].id) fs.rmSync(p.zip(index.zips[name].id), { force: true });
      index.zips[name] = { id, sha, size, ok: true, at: Date.now() };
      saveIndex(key);
    }
    job.phase = 'separando as mídias';
    const ok = await extractMedia(key, zipPath);
    if (!ok) throw new Error('a leitura do zip não terminou');
    // Tudo conferido: o zip em claro sai do Mac (fica a cópia cifrada).
    index.zips[name].imported = Date.now();
    saveIndex(key);
    fs.rmSync(zipPath, { force: true });
  }
  fs.rmSync(p.tmp(), { recursive: true, force: true });
}

// Formato do zip cifrado: "PCVZ1" + iv(12) + texto cifrado + tag(16).
const MAGIC = Buffer.from('PCVZ1');

async function encryptStream(key, src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sha = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, enc, cb) {
      sha.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, Buffer.concat([MAGIC, iv]));
    const sink = new Writable({
      write(chunk, enc, cb) {
        try {
          fs.writeSync(fd, chunk);
          cb();
        } catch (e) {
          cb(e);
        }
      },
    });
    await pipeline(fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 }), tap, cipher, sink);
    fs.writeSync(fd, cipher.getAuthTag());
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  return { sha: sha.digest('hex'), size };
}

async function decryptStreamSha(key, file, outPath) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.readSync(fd, tag, 0, 16, st.size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('não é um zip do cofre');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const sha = crypto.createHash('sha256');
  const tap = new Transform({
    transform(chunk, enc, cb) {
      sha.update(chunk);
      cb(null, outPath ? chunk : null);
    },
  });
  const streams = [fs.createReadStream(file, { start: head.length, end: st.size - 17, highWaterMark: 4 * 1024 * 1024 }), decipher, tap];
  if (outPath) streams.push(fs.createWriteStream(outPath, { mode: 0o600 }));
  else streams.push(new Writable({ write(c, e, cb) { cb(); } }));
  await pipeline(...streams);
  return sha.digest('hex');
}

function pythonBin() {
  for (const b of [process.env.VAULT_PYTHON, '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    if (b && fs.existsSync(b)) return b;
  }
  return 'python3';
}

// Lê os quadros que o vault-extract.py manda e guarda cada mídia cifrada.
async function extractMedia(key, zipPath) {
  fs.mkdirSync(p.tmp(), { recursive: true, mode: 0o700 });
  const doneList = path.join(p.tmp(), `feitos-${process.pid}.txt`);
  fs.writeFileSync(doneList, Object.keys(index.seen).join('\n'), { mode: 0o600 });
  const child = spawn(pythonBin(), ['-I', path.join(__dirname, 'vault-extract.py'), zipPath, doneList], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  let ended = false;
  let sinceSave = 0;
  const exited = new Promise((resolve) => child.on('close', resolve));
  job.total = 0;
  job.done = 0;

  // Lê exatamente n bytes do processo (com pausa: um vídeo grande não
  // enche a memória mais rápido do que a gente cifra). Junta os pedaços uma
  // vez só no fim - concatenar a cada pedaço seria quadrático num vídeo de
  // 700 MB.
  // O leitor manda mais rápido do que a gente cifra: os pedaços ficam numa
  // fila e o fluxo pausa quando passa de 64 MB (ou do tamanho do arquivo
  // que estamos esperando, pra um vídeo grande caber inteiro). Juntar os
  // pedaços só uma vez no fim - concatenar a cada um seria quadrático.
  const readable = child.stdout;
  const HIGH = 64 * 1024 * 1024;
  let chunks = [];
  let plen = 0;
  let need = 0;
  let streamEnded = false;
  let wake = null;
  const poke = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  readable.on('data', (c) => {
    chunks.push(c);
    plen += c.length;
    if (plen >= Math.max(need, HIGH)) readable.pause();
    poke();
  });
  readable.on('end', () => { streamEnded = true; poke(); });
  readable.on('error', () => { streamEnded = true; poke(); });
  async function take(n) {
    need = n;
    while (plen < n) {
      if (streamEnded) return null;
      if (readable.isPaused()) readable.resume();
      await new Promise((r) => { wake = r; });
    }
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, plen);
    const rest = all.subarray(n);
    chunks = rest.length ? [rest] : [];
    plen = rest.length;
    need = 0;
    if (!streamEnded && readable.isPaused() && plen < HIGH) readable.resume();
    return all.subarray(0, n);
  }

  try {
    for (;;) {
      const lenBuf = await take(4);
      if (!lenBuf) break;
      const hdrBuf = await take(lenBuf.readUInt32BE(0));
      if (!hdrBuf) break;
      const hdr = JSON.parse(hdrBuf.toString('utf8'));
      if (hdr.end) {
        ended = true;
        break;
      }
      if (typeof hdr.expect === 'number') {
        job.total += hdr.expect;
        continue;
      }
      if (typeof hdr.skip === 'string') {
        job.done += 1;
        continue;
      }
      const data = hdr.size ? await take(hdr.size) : Buffer.alloc(0);
      if (data === null) break;
      try {
        await addItem(key, hdr.path, hdr.mtime, data);
      } catch (e) {
        console.error('cofre: não deu pra guardar uma mídia:', e && e.message);
      }
      index.seen[hdr.path] = 1;
      job.done += 1;
      sinceSave += 1;
      if (sinceSave >= 25) {
        saveIndex(key);
        sinceSave = 0;
      }
    }
  } finally {
    saveIndex(key);
    fs.rmSync(doneList, { force: true });
  }
  const code = await exited;
  if (code !== 0) console.error('cofre: leitor do zip saiu com erro:', stderr.trim().split('\n').pop());
  return ended && code === 0;
}

async function addItem(key, srcPath, mtime, data) {
  if (!data.length) return;
  const base = srcPath.split('/').pop();
  const ext = path.extname(base).toLowerCase();
  const kind = KINDS[ext];
  if (!kind) return;
  let prepared;
  if (kind[0] === 'image') prepared = await prepareImage(data, ext);
  else if (kind[0] === 'video') prepared = await prepareVideo(data, ext);
  else prepared = { buf: data, mime: kind[1] };
  const hash = crypto.createHash('sha256').update(prepared.buf).digest('hex');
  if (index.hashes[hash]) return; // o mesmo arquivo duas vezes
  const id = randomId(16);
  atomicWrite(p.blob(id), encryptBuffer(key, prepared.buf));
  if (prepared.thumb) atomicWrite(p.thumb(id), encryptBuffer(key, prepared.thumb));
  const item = {
    id,
    kind: kind[0],
    mime: prepared.mime,
    size: prepared.buf.length,
    name: prepared.mime === 'image/jpeg' && /\.hei[cf]$/i.test(base) ? base.replace(/\.hei[cf]$/i, '.jpg') : base,
    from: srcPath.includes('!/') ? 'whatsapp' : 'pasta',
    ts: tsFromName(base, mtime),
  };
  if (prepared.thumb) item.thumb = true;
  if (prepared.w && prepared.h) {
    item.w = prepared.w;
    item.h = prepared.h;
  }
  if (prepared.dur !== undefined) item.dur = prepared.dur;
  index.items.push(item);
  index.hashes[hash] = id;
}

// ---- leitura ----
function list(key, { kind, offset = 0, limit = 120 } = {}) {
  readIndex(key);
  const all = index.items.filter((it) => !kind || it.kind === kind).sort((a, b) => b.ts - a.ts);
  const counts = { image: 0, video: 0, audio: 0, sticker: 0 };
  for (const it of index.items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  return { items: all.slice(offset, offset + limit), total: all.length, counts };
}

function getItem(key, id) {
  readIndex(key);
  return index.items.find((it) => it.id === id) || null;
}

// Arquivo grande decifrado fica um pouco em memória: o Safari pede o vídeo
// em vários pedaços (Range) e decifrar 700 MB a cada pedaço travaria tudo.
let fileCache = null; // { id, buf, at }
function readFile(key, id) {
  if (fileCache && fileCache.id === id && Date.now() - fileCache.at < 120000) {
    fileCache.at = Date.now();
    return fileCache.buf;
  }
  const buf = decryptBuffer(key, fs.readFileSync(p.blob(id)));
  if (buf.length > 8 * 1024 * 1024) fileCache = { id, buf, at: Date.now() };
  return buf;
}
setInterval(() => {
  if (fileCache && Date.now() - fileCache.at > 120000) fileCache = null;
}, 30000).unref();

function readThumb(key, item) {
  if (item.kind === 'sticker') return { buf: readFile(key, item.id), mime: 'image/webp' };
  if (!item.thumb) return null;
  return { buf: decryptBuffer(key, fs.readFileSync(p.thumb(item.id))), mime: 'image/jpeg' };
}

// Trancar: some o que está decifrado em memória (menos durante a
// importação, que ainda está usando o índice).
function forget() {
  fileCache = null;
  if (job) return;
  index = null;
  indexKeyId = null;
}

// Pro script de recuperação (scripts/cofre-zip-original.js).
async function exportZip(code, name, outPath) {
  const key = await unlock(code);
  const z = index.zips[name] || Object.values(index.zips)[0];
  if (!z) throw userError('Nenhum zip guardado no cofre.');
  const sha = await decryptStreamSha(key, p.zip(z.id), outPath);
  if (sha !== z.sha) throw new Error('o zip recuperado não confere');
  return outPath;
}

module.exports = {
  init, enabled, isOwner, exists, inboxZips, setup, unlock, startImport, status,
  list, getItem, readFile, readThumb, forget, exportZip,
  _tsFromName: tsFromName,
};
