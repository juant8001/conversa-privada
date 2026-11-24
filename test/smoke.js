'use strict';

// Teste de fumaça da API, sem dependências: sobe o server.js de verdade numa
// porta e numa pasta de dados temporárias e exercita as rotas por fetch.
//
//   node test/smoke.js
//
// Não toca em nada do .env nem da pasta data/ reais.

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = 4300 + Math.floor(Math.random() * 500);
const SLUG = 'smoke-test-slug-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}/c/${SLUG}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-smoke-'));
const CODE = 'codigo-de-teste';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`);
  }
}

// PNG 1x1 transparente e GIF 1x1 - o menor arquivo válido de cada tipo.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Duas figurinhas WebP 2x2 (vermelha e azul), pras favoritas do WhatsApp falso.
const WEBP_RED = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ/Y/+ByKi/wEA', 'base64');
const WEBP_BLUE = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ0f/+ByKi/wEA', 'base64');
const b64sha = (buf) => crypto.createHash('sha256').update(buf).digest('base64');

// Arquivo cifrado como o WhatsApp guarda no servidor de mídia dele.
function waEncrypt(plain, mediaKey) {
  const keys = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from('WhatsApp Image Keys'), 112));
  const iv = keys.subarray(0, 16);
  const c = crypto.createCipheriv('aes-256-cbc', keys.subarray(16, 48), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const mac = crypto.createHmac('sha256', keys.subarray(48, 80)).update(iv).update(enc).digest().subarray(0, 10);
  return Buffer.concat([enc, mac]);
}
const WA_KEY_BLUE = crypto.randomBytes(32);
const WA_ENC_BLUE = waEncrypt(WEBP_BLUE, WA_KEY_BLUE);
// A favorita "perdida" chegando de novo numa conversa (mandada do celular):
// a mensagem traz link novo e chave própria.
// Cabeçalho de WebP com recheio qualquer: só aparece na lista, não é importada.
const fakeWebp = (txt) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(`WEBP${txt}`)]);
const WA_SUMIU = fakeWebp('sumiu');
const WA_KEY_MSG = crypto.randomBytes(32);
const WA_ENC_MSG = waEncrypt(WA_SUMIU, WA_KEY_MSG);
// Figurinhas que só passaram por conversas (v49): uma que o Juan mandou
// (criada por ele; WebP de verdade, importável) e uma que ele recebeu.
// A chave da mensagem vai no formato real do ChatStorage (protobuf).
function webpWithExtraChunk(base, tag) {
  const chunk = Buffer.concat([Buffer.from(tag), Buffer.from([4, 0, 0, 0]), Buffer.from('oi!!')]);
  const out = Buffer.concat([base, chunk]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
const WEBP_CRIADA = webpWithExtraChunk(WEBP_RED, 'XTRA');
const WA_KEY_CRIADA = crypto.randomBytes(32);
const WA_ENC_CRIADA = waEncrypt(WEBP_CRIADA, WA_KEY_CRIADA);
const WA_RECEBIDA = fakeWebp('recebida');
const WA_KEY_RECEBIDA = crypto.randomBytes(32);
const WA_ENC_RECEBIDA = waEncrypt(WA_RECEBIDA, WA_KEY_RECEBIDA);
const WA_LOTTIE = Buffer.from('PK\x03\x04lottie');
const WA_KEY_LOTTIE = crypto.randomBytes(32);
const WA_ENC_LOTTIE = waEncrypt(WA_LOTTIE, WA_KEY_LOTTIE);
const encShaOf = (enc) => crypto.createHash('sha256').update(enc).digest();
// Favorita antiga (link expirado) que o celular manda de novo a pedido do
// Bot de Figurinhas (v50), e uma mandada que o celular não tem mais.
const WEBP_VELHA = webpWithExtraChunk(WEBP_BLUE, 'VELH');
const WA_KEY_VELHA = crypto.randomBytes(32);
const WA_ENC_VELHA = waEncrypt(WEBP_VELHA, WA_KEY_VELHA);
const botCalls = [];
// WhatsApp do Teo (v51): conectado como aparelho, pelo Baileys de mentira.
const TEO_FAV = webpWithExtraChunk(WEBP_RED, 'TEO1');
const TEO_KEY_FAV = crypto.randomBytes(32);
const TEO_ENC_FAV = waEncrypt(TEO_FAV, TEO_KEY_FAV);
const TEO_MINE = webpWithExtraChunk(WEBP_BLUE, 'TEO2'); // link expirado: volta pelo celular
const TEO_KEY_MINE = crypto.randomBytes(32);
const TEO_ENC_MINE = waEncrypt(TEO_MINE, TEO_KEY_MINE);
const TEO_RECV = webpWithExtraChunk(WEBP_RED, 'TEO3');
const TEO_KEY_RECV = crypto.randomBytes(32);
const TEO_ENC_RECV = waEncrypt(TEO_RECV, TEO_KEY_RECV);
const botCodes = [];
function writeTeoPhone(file) {
  const k = (x) => x.toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    favorites: [{ hash: b64sha(TEO_FAV), mediaKey: k(TEO_KEY_FAV), directPath: '/teo/fav', encSha: k(encShaOf(TEO_ENC_FAV)), ts: 5000 }],
    messages: [
      { hash: b64sha(TEO_MINE), mediaKey: k(TEO_KEY_MINE), directPath: '/msg/expirada', fromMe: true, ts: 1700000000, id: 'TEOMSG1', remoteJid: '5511977776666@s.whatsapp.net' },
      { hash: b64sha(TEO_RECV), mediaKey: k(TEO_KEY_RECV), directPath: '/teo/recv', fromMe: false, ts: 1700000100, id: 'TEOMSG2', remoteJid: '5511977776666@s.whatsapp.net' },
      { hash: b64sha(TEO_FAV), mediaKey: k(TEO_KEY_FAV), directPath: '/teo/fav', fromMe: true, ts: 1700000200, id: 'TEOMSG3', remoteJid: '5511977776666@s.whatsapp.net' },
    ],
    reupload: { TEOMSG1: '/teo/reenviada' },
  }));
}

function pbVarint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
function pbField(no, value) {
  if (typeof value === 'number' || typeof value === 'bigint') return Buffer.concat([pbVarint((no << 3) | 0), pbVarint(value)]);
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([pbVarint((no << 3) | 2), pbVarint(buf.length), buf]);
}

// ZMEDIAKEY como o WhatsApp do Mac grava: { 1: chave, 2: sha256 do cifrado, 3: data }.
const mediaKeyBlob = (key, enc) => Buffer.concat([pbField(1, key), pbField(2, encShaOf(enc)), pbField(3, 1700000000)]).toString('hex');

// Contêiner falso do WhatsApp do Mac: 3 favoritas valendo (uma com arquivo
// no disco, uma só no servidor de mídia, uma perdida) e uma desfavoritada.
function makeFakeWhatsApp(mediaOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wa-'));
  fs.mkdirSync(path.join(dir, 'AppState', 'ABC-123'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stickers', 'no-sticker-pack'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stickers', 'no-sticker-pack', 'red.webp'), WEBP_RED);
  const fav = (hash, { key, encSha, directPath, isFavorite = 1, ts }) => {
    const action = Buffer.concat([
      pbField(1, `${mediaOrigin}/expirado${directPath}`),
      encSha ? pbField(2, encSha) : Buffer.alloc(0),
      pbField(3, key || crypto.randomBytes(32)),
      pbField(4, 'image/webp'),
      pbField(7, directPath),
      pbField(9, isFavorite),
    ]);
    const value = Buffer.concat([pbField(1, ts), pbField(33, action)]);
    const index = JSON.stringify(['favoriteSticker', hash]).replace(/'/g, "''");
    return `insert into ZAPPSTATECONFIRMEDMUTATIONENTITY (ZVERSION, ZACTIONNAME, ZINDEX, ZVALUE) values (7, 'favoriteSticker', '${index}', X'${value.toString('hex')}');`;
  };
  const appSql = [
    'create table ZAPPSTATECONFIRMEDMUTATIONENTITY (Z_PK integer primary key, ZVERSION integer, ZACTIONNAME varchar, ZINDEX blob, ZVALUE blob);',
    fav(b64sha(WEBP_RED), { directPath: '/v/red', ts: 3000 }),
    fav(b64sha(WEBP_BLUE), { key: WA_KEY_BLUE, encSha: crypto.createHash('sha256').update(WA_ENC_BLUE).digest(), directPath: '/v/blue', ts: 2000 }),
    fav(b64sha(WA_SUMIU), { directPath: '/v/sumiu', ts: 1000 }),
    fav(b64sha(Buffer.from('desfavoritada')), { directPath: '/v/x', ts: 500, isFavorite: 0 }),
    "insert into ZAPPSTATECONFIRMEDMUTATIONENTITY (ZVERSION, ZACTIONNAME, ZINDEX, ZVALUE) values (1, 'star', 'x', X'00');",
  ].join('\n');
  execFileSync('sqlite3', [path.join(dir, 'AppState', 'ABC-123', 'AppState.sqlite')], { input: appSql });
  execFileSync('sqlite3', [path.join(dir, 'Sticker.sqlite')], {
    input: `create table ZWACDSTICKER (Z_PK integer primary key, ZFILEHASH varchar, ZRELATIVEIMAGEPATH varchar);
insert into ZWACDSTICKER (ZFILEHASH, ZRELATIVEIMAGEPATH) values ('${b64sha(WEBP_RED)}', 'no-sticker-pack/red.webp');`,
  });
  // Conversas: a vermelha já passou por uma (arquivo apagado, link morto).
  execFileSync('sqlite3', [path.join(dir, 'ChatStorage.sqlite')], {
    input: `create table ZWAMESSAGE (Z_PK integer primary key, ZMESSAGETYPE integer, ZISFROMME integer, ZMESSAGEDATE timestamp, ZCHATSESSION integer, ZGROUPMEMBER integer, ZSTANZAID varchar);
create table ZWACHATSESSION (Z_PK integer primary key, ZCONTACTJID varchar);
create table ZWAGROUPMEMBER (Z_PK integer primary key, ZMEMBERJID varchar);
insert into ZWACHATSESSION values (1, '120363000000000000@g.us');
insert into ZWAGROUPMEMBER values (1, '5583900000000@s.whatsapp.net');
create table ZWAMEDIAITEM (Z_PK integer primary key, ZMESSAGE integer, ZVCARDNAME varchar, ZMEDIALOCALPATH varchar, ZMEDIAURL varchar, ZMEDIAKEY blob, ZMEDIAURLDATE timestamp);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (1, 15, 0, 100);
insert into ZWAMEDIAITEM values (1, 1, '${b64sha(WEBP_RED)}', 'Media/x/apagado.webp', '${mediaOrigin}/wa/morto', X'${crypto.randomBytes(32).toString('hex')}', 10);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (2, 0, 0, 110);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (4, 15, 1, 250);
insert into ZWAMEDIAITEM values (4, 4, '${b64sha(WEBP_CRIADA)}', null, '${mediaOrigin}/wa/msg/criada', X'${mediaKeyBlob(WA_KEY_CRIADA, WA_ENC_CRIADA)}', 250);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (5, 15, 0, 200);
insert into ZWAMEDIAITEM values (5, 5, '${b64sha(WA_RECEBIDA)}', null, '${mediaOrigin}/wa/msg/recebida', X'${mediaKeyBlob(WA_KEY_RECEBIDA, WA_ENC_RECEBIDA)}', 200);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (6, 15, 1, 260);
insert into ZWAMEDIAITEM values (6, 6, '${b64sha(Buffer.from('antiga'))}', null, 'https://a.whatsapp.net', X'${mediaKeyBlob(crypto.randomBytes(32), Buffer.from('x'))}', 260);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (7, 15, 0, 190);
insert into ZWAMEDIAITEM values (7, 7, '${b64sha(Buffer.from('expirada'))}', null, '${mediaOrigin}/wa/msg/expirada', X'${mediaKeyBlob(crypto.randomBytes(32), Buffer.from('x'))}', 190);
insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (8, 15, 0, 180);
insert into ZWAMEDIAITEM values (8, 8, '${b64sha(WA_LOTTIE)}', null, '${mediaOrigin}/wa/msg/lottie', X'${mediaKeyBlob(WA_KEY_LOTTIE, WA_ENC_LOTTIE)}', 180);`,
  });
  return dir;
}

// Uma favorita antiga cujo link expirou e que só aparece numa mensagem velha
// de grupo (link de mentira do WhatsApp), mais uma mandada que o celular
// já apagou.
function waAddOldStickers(dir, mediaOrigin) {
  const action = Buffer.concat([pbField(1, `${mediaOrigin}/expirado/v/velha`), pbField(3, crypto.randomBytes(32)),
    pbField(4, 'image/webp'), pbField(7, '/v/velha'), pbField(9, 1)]);
  const value = Buffer.concat([pbField(1, 900), pbField(33, action)]);
  const index = JSON.stringify(['favoriteSticker', b64sha(WEBP_VELHA)]);
  execFileSync('sqlite3', [path.join(dir, 'AppState', 'ABC-123', 'AppState.sqlite')], {
    input: `insert into ZAPPSTATECONFIRMEDMUTATIONENTITY (ZVERSION, ZACTIONNAME, ZINDEX, ZVALUE) values (8, 'favoriteSticker', '${index}', X'${value.toString('hex')}');`,
  });
  execFileSync('sqlite3', [path.join(dir, 'ChatStorage.sqlite')], {
    input: `insert into ZWAMESSAGE values (9, 15, 0, 50, 1, 1, 'VELHA1');
insert into ZWAMEDIAITEM values (9, 9, '${b64sha(WEBP_VELHA)}', null, 'https://a.whatsapp.net', X'${mediaKeyBlob(WA_KEY_VELHA, WA_ENC_VELHA)}', 50);
insert into ZWAMESSAGE values (10, 15, 1, 40, 1, null, 'NAOTEM1');
insert into ZWAMEDIAITEM values (10, 10, '${b64sha(Buffer.from('apagada'))}', null, '${mediaOrigin}/wa/msg/expirada', X'${mediaKeyBlob(crypto.randomBytes(32), Buffer.from('x'))}', 40);`,
  });
}

// Simula o Juan mandando a figurinha "perdida" do celular pra uma conversa.
function waReceiveFromPhone(dir, mediaOrigin) {
  execFileSync('sqlite3', [path.join(dir, 'ChatStorage.sqlite')], {
    input: `insert into ZWAMESSAGE (Z_PK, ZMESSAGETYPE, ZISFROMME, ZMESSAGEDATE) values (3, 15, 1, 300);
insert into ZWAMEDIAITEM values (2, 3, '${b64sha(WA_SUMIU)}', null, '${mediaOrigin}/wa/msg/sumiu', X'${mediaKeyBlob(WA_KEY_MSG, WA_ENC_MSG)}', 20);`,
  });
}

// JPEG de verdade (ffmpeg) com "Orientation = 6" (girar 90°) enfiado logo
// depois do SOI: é assim que chega foto de iPhone tirada em pé.
function rotatedJpeg(w, h) {
  const tmp = path.join(os.tmpdir(), `pc-rot-${process.pid}.jpg`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}`, '-frames:v', '1', tmp]);
  const jpg = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

function realAudio(fmt) {
  const tmp = path.join(os.tmpdir(), `pc-audio-${process.pid}.${fmt}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:a', 'libopus', tmp]);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}

function hasBin(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Servidor falso do GIPHY: responde a busca e serve a "mídia" dos resultados.
function startFakeGiphy() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${srv.address().port}`;
      if (req.url.startsWith('/v1/gifs/') || req.url.startsWith('/v1/stickers/')) {
        const rendition = { url: `${origin}/media/cat.gif`, width: '120', height: '90' };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          data: [
            { id: 'abc', title: 'gato', images: { fixed_width_small: rendition, downsized: rendition } },
            { id: 'bad', title: 'fora', images: { fixed_width_small: { url: 'https://evil.example/x.gif' }, downsized: { url: 'https://evil.example/x.gif' } } },
          ],
          pagination: { total_count: 1, count: 1, offset: 0 },
        }));
      } else if (req.url === '/media/cat.gif') {
        res.setHeader('Content-Type', 'image/gif');
        res.end(GIF);
      } else if (req.url.startsWith('/fx/')) {
        // fxtwitter falso: post 111 tem GIF, post 222 só texto.
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/status/111')) {
          res.end(JSON.stringify({ tweet: { media: { all: [{ type: 'gif', url: `${origin}/media/cat.gif` }] } } }));
        } else if (req.url.endsWith('/status/333')) {
          res.end(JSON.stringify({ tweet: { media: { all: [{ type: 'photo', url: 'http://127.0.0.1:1/interno.png' }] } } }));
        } else {
          res.end(JSON.stringify({ tweet: { text: 'só texto' } }));
        }
      } else if (req.url === '/wa/v/blue') {
        res.end(WA_ENC_BLUE);
      } else if (req.url === '/wa/msg/sumiu') {
        res.end(WA_ENC_MSG);
      } else if (req.url === '/bot/reenviar' && req.method === 'POST') {
        // Bot de Figurinhas falso: o celular "manda de novo" a VELHA1.
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          const b = JSON.parse(body || '{}');
          botCalls.push(b);
          res.setHeader('Content-Type', 'application/json');
          if (req.headers['x-token'] !== 'token-do-bot') {
            res.statusCode = 401;
            res.end('{}');
          } else if (b.id === 'VELHA1' && b.remoteJid === '120363000000000000@g.us' && b.participant === '5583900000000@s.whatsapp.net'
            && Buffer.from(b.mediaKey, 'base64').equals(WA_KEY_VELHA)) {
            res.end(JSON.stringify({ ok: true, url: `${origin}/wa/msg/reenviada`, directPath: '/msg/reenviada' }));
          } else {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: 'Media re-upload failed by device (NOT_FOUND)', status: 404 }));
          }
        });
        return;
      } else if (req.url === '/bot/eu' && req.headers['x-token'] === 'token-do-bot') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, numero: '558390001111' }));
      } else if (req.url === '/bot/mandar-codigo' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.headers['x-token'] !== 'token-do-bot') { res.statusCode = 401; res.end('{}'); return; }
          botCodes.push(JSON.parse(body || '{}').codigo);
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      } else if (req.url === '/wa/teo/fav') {
        res.end(TEO_ENC_FAV);
      } else if (req.url === '/wa/teo/recv') {
        res.end(TEO_ENC_RECV);
      } else if (req.url === '/wa/teo/reenviada') {
        res.end(TEO_ENC_MINE);
      } else if (req.url === '/wa/msg/reenviada') {
        res.end(WA_ENC_VELHA);
      } else if (req.url === '/wa/msg/criada') {
        res.end(WA_ENC_CRIADA);
      } else if (req.url === '/wa/msg/recebida') {
        res.end(WA_ENC_RECEBIDA);
      } else if (req.url === '/wa/msg/lottie') {
        res.end(WA_ENC_LOTTIE);
      } else if (req.url === '/wa/msg/expirada') {
        res.statusCode = 403;
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function makeClient() {
  let cookie = '';
  return async function call(method, p, body, opts) {
    const headers = { ...(opts && opts.headers) };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    const type = res.headers.get('content-type') || '';
    if (opts && opts.raw) return { res, buf: Buffer.from(await res.arrayBuffer()) };
    if (type.includes('json')) json = await res.json();
    return { res, json };
  };
}

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v && v.buffer) f.append(k, new Blob([v.buffer], { type: v.type }), v.name);
    else f.append(k, String(v));
  }
  return f;
}

async function main() {
  const giphy = await startFakeGiphy();
  const fakeOrigin = `http://127.0.0.1:${giphy.address().port}`;
  const canWa = hasBin('sqlite3');
  const waDir = canWa ? makeFakeWhatsApp(fakeOrigin) : null;
  const teoPhone = path.join(DATA_DIR, '..', `pc-teo-${PORT}.json`);
  writeTeoPhone(teoPhone);
  const changelogFile = path.join(DATA_DIR, '..', `pc-changelog-${PORT}.json`);
  const writeChangelog = (versions) => fs.writeFileSync(changelogFile, JSON.stringify(versions.map((v) => ({
    version: v, date: '2026-11-24', title: `Novidades ${v}`, items: [`item de ${v}`],
  }))));
  writeChangelog(['t1']);
  const env = {
    ...process.env,
    PORT: String(PORT),
    ROOM_SLUG: SLUG,
    DATA_DIR,
    COOKIE_INSECURE: '1',
    EPHEMERAL_TTL_MS: '300',
    ALT_CODE: 'codigo-alternativo',
    HERMES_TRIGGER: 'abre-te-sesamo',
    HERMES_CODE: 'entrada-do-hermes-teste',
    HERMES_BIN: '/bin/echo', // "agente" de mentira: devolve o próprio prompt
    GIPHY_API_KEY: 'chave-de-teste',
    GIPHY_API_BASE: fakeOrigin,
    FXTWITTER_API_BASE: `${fakeOrigin}/fx`,
    WHATSAPP_MEDIA_BASE: `${fakeOrigin}/wa`,
    WHATSAPP_REUPLOAD_URL: `${fakeOrigin}/bot/reenviar`,
    WHATSAPP_REUPLOAD_TOKEN: 'token-do-bot',
    WHATSAPP_REUPLOAD_GAP_MS: '0',
    ...(waDir ? { WHATSAPP_IMPORT: '1', WHATSAPP_CONTAINER: waDir } : {}),
    VAULT_OWNER: 'Juan',
    WHATSAPP_BAILEYS_MODULE: path.join(__dirname, 'fake-baileys.mjs'),
    WHATSAPP_FAKE_DATA: teoPhone,
    PRESENCE_STALE_MS: '1500',
    EXPORT_PART_MB: '0.00005', // ~50 bytes: cada mídia vira uma parte
    CHANGELOG_JSON: changelogFile,
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('rodando')) resolve(); });
    server.on('exit', (c) => reject(new Error(`server saiu (${c}): ${serverErr}`)));
    setTimeout(() => reject(new Error('server não subiu')), 8000);
  });

  try {
    const juan = makeClient();
    const teo = makeClient();
    const anon = makeClient();

    console.log('\n# cabeçalhos e estáticos');
    let r = await anon('GET', '/', undefined, { raw: true });
    check('página carrega', r.res.status === 200 && r.buf.toString().includes('<title>conversa</title>'));
    const csp = r.res.headers.get('content-security-policy') || '';
    check('CSP na página', csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), csp);
    check('Referrer-Policy no-referrer', r.res.headers.get('referrer-policy') === 'no-referrer');
    check('nosniff', r.res.headers.get('x-content-type-options') === 'nosniff');
    check('X-Frame-Options', r.res.headers.get('x-frame-options') === 'DENY');
    r = await fetch(`${BASE}/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    check('app.js sai em gzip', r.headers.get('content-encoding') === 'gzip');
    const etag = r.headers.get('etag');
    r = await fetch(`${BASE}/app.js`, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag } });
    check('ETag devolve 304', r.status === 304);
    r = await new Promise((resolve) => {
      http.get(`${BASE}/app.js`, { headers: { 'Accept-Encoding': 'br' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ enc: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
    });
    check('app.js sai em brotli e descomprime igual ao arquivo', r.enc === 'br'
      && zlib.brotliDecompressSync(r.body).equals(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'))));
    r = await fetch(`http://127.0.0.1:${PORT}/c/slug-errado/`);
    check('slug errado = 404', r.status === 404);
    r = await fetch(`${BASE}/..%2fserver.js`);
    check('sem travessia de pasta', r.status === 404);
    check('segredos fora do app.js', !fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').includes(env.HERMES_TRIGGER));

    console.log('\n# login');
    r = await anon('GET', '/api/messages');
    check('sem sessão = 401', r.res.status === 401);
    r = await anon('POST', '/api/login', { code: env.ALT_CODE });
    check('ALT_CODE devolve só o aviso', r.json && r.json.notice === true);
    r = await anon('GET', '/api/messages');
    check('…e não cria sessão', r.res.status === 401);
    r = await juan('POST', '/api/login', { code: CODE });
    check('primeiro login define o código', r.res.status === 200 && r.json.ok && !r.json.notice);
    r = await teo('POST', '/api/login', { code: 'errado-errado' });
    check('código errado = 401', r.res.status === 401);
    r = await teo('POST', '/api/login', { code: CODE });
    check('segundo login com o código certo', r.res.status === 200);
    r = await juan('GET', '/api/messages');
    check('API responde no-store', r.res.headers.get('cache-control') === 'no-store');
    check('conversa nova não ganha cartão de changelog', r.json.messages.length === 0);

    console.log('\n# boot / preferências');
    r = await juan('GET', '/api/boot?name=Juan');
    check('boot traz atalhos padrão', r.json.quickReactions.length === 6 && r.json.quickReactions[0] === '❤️');
    check('boot: giphy ligado, hermes com hash e sem a frase',
      r.json.giphy === true && r.json.hermes && /^[0-9a-f]{64}$/.test(r.json.hermes.hash)
      && !JSON.stringify(r.json).includes(env.HERMES_TRIGGER));
    const custom = ['🥰', '👍', '😂', '🫶', '😢', '🇧🇷'];
    r = await juan('POST', '/api/prefs', { requesterName: 'Juan', quickReactions: custom });
    check('salva atalhos', r.res.status === 200);
    r = await juan('GET', '/api/boot?name=JUAN');
    check('atalhos voltam (nome sem diferenciar maiúsculas)', JSON.stringify(r.json.quickReactions) === JSON.stringify(custom));
    r = await teo('GET', '/api/boot?name=Teo');
    check('atalhos são por pessoa', r.json.quickReactions[0] === '❤️');
    r = await juan('POST', '/api/prefs', { requesterName: 'Juan', quickReactions: ['a', 'b', 'c', 'd', 'e', 'f'] });
    check('atalho que não é emoji = 400', r.res.status === 400);
    r = await juan('POST', '/api/prefs', { requesterName: 'Juan', quickReactions: ['❤️', '❤️', '😂', '😮', '😢', '🔥'] });
    check('atalho repetido = 400', r.res.status === 400);

    console.log('\n# mensagens, reações livres, favoritas');
    r = await juan('POST', '/api/messages', { sender: 'Juan', text: 'oi **amor** ~~não~~' });
    const m1 = r.json.message;
    check('texto guarda os marcadores crus', m1.text === 'oi **amor** ~~não~~');
    r = await teo('POST', '/api/messages', { sender: 'Teo', text: 'segunda' });
    const m2 = r.json.message;
    r = await teo('POST', `/api/messages/${m1.id}/react`, { requesterName: 'Teo', emoji: '🫶' });
    check('reage com emoji fora da lista antiga', r.res.status === 200 && r.json.message.reactions[0].emoji === '🫶');
    r = await teo('POST', `/api/messages/${m1.id}/react`, { requesterName: 'Teo', emoji: '👨‍👩‍👧‍👦' });
    check('emoji composto (ZWJ) vale', r.res.status === 200 && r.json.message.reactions[0].emoji === '👨‍👩‍👧‍👦');
    for (const bad of ['oi', '❤️❤️', '<b>', '', 'a❤️', '1']) {
      r = await teo('POST', `/api/messages/${m1.id}/react`, { requesterName: 'Teo', emoji: bad });
      check(`reação inválida ${JSON.stringify(bad)} = 400`, r.res.status === 400);
    }
    r = await teo('POST', `/api/messages/${m1.id}/react`, { requesterName: 'Teo', emoji: '1️⃣' });
    check('keycap vale', r.res.status === 200);

    r = await juan('POST', `/api/messages/${m1.id}/star`, { requesterName: 'Juan' });
    check('favorita', r.res.status === 200 && r.json.starredBy.length === 1);
    r = await juan('POST', `/api/messages/${m2.id}/star`, { requesterName: 'juan', starred: true });
    r = await juan('GET', '/api/starred?name=Juan');
    check('lista de favoritas: 2, mais nova primeiro', r.json.items.length === 2 && r.json.items[0].id === m2.id);
    r = await teo('GET', '/api/starred?name=Teo');
    check('favoritas são por pessoa', r.json.items.length === 0);
    r = await juan('POST', `/api/messages/${m1.id}/star`, { requesterName: 'Juan', starred: false });
    r = await juan('GET', '/api/starred?name=Juan');
    check('desfavorita', r.json.items.length === 1);
    r = await juan('POST', `/api/messages/${m2.id}/delete`, { requesterName: 'Juan' });
    r = await juan('GET', '/api/starred?name=Juan');
    check('apagar tira das favoritas', r.json.items.length === 0);
    r = await juan('POST', `/api/messages/${m2.id}/star`, { requesterName: 'Juan' });
    check('não favorita mensagem apagada', r.res.status === 400);

    console.log('\n# mídia e sandbox de arquivo');
    r = await juan('POST', '/api/media', form({ sender: 'Juan', width: 1, height: 1, file: { buffer: PNG, type: 'image/png', name: 'foto.png' }, thumb: { buffer: PNG, type: 'image/jpeg', name: 't.jpg' } }));
    const photo = r.json.message;
    check('foto enviada com miniatura', photo.type === 'image' && !!photo.thumbId);
    r = await juan('GET', `/api/media/${photo.mediaId}`, undefined, { raw: true });
    check('foto baixa igual', r.buf.equals(PNG) && r.res.headers.get('content-type') === 'image/png');
    check('mídia com CSP sandbox', (r.res.headers.get('content-security-policy') || '').includes('sandbox'));
    check('foto abre inline', (r.res.headers.get('content-disposition') || '').startsWith('inline'));
    r = await juan('GET', `/api/media/${photo.thumbId}`, undefined, { raw: true });
    check('miniatura sai como jpeg', r.res.headers.get('content-type') === 'image/jpeg');
    await juan('POST', `/api/messages/${photo.id}/star`, { requesterName: 'Juan', starred: true });
    r = await juan('GET', '/api/media-list');
    check('aba Mídia informa o que está favoritado', r.json.items.find((it) => it.id === photo.id).starredBy[0] === 'Juan');
    await juan('POST', `/api/messages/${photo.id}/star`, { requesterName: 'Juan', starred: false });
    r = await juan('GET', `/api/media/${photo.mediaId}`, undefined, { raw: true, headers: { Range: 'bytes=0-1' } });
    check('Range continua funcionando', r.res.status === 206 && r.buf.length === 2);
    r = await juan('POST', '/api/media', form({ sender: 'Juan', file: { buffer: Buffer.from('<script>alert(1)</script>'), type: 'text/html', name: 'x.html' } }));
    const html = r.json.message;
    r = await juan('GET', `/api/media/${html.mediaId}`, undefined, { raw: true });
    check('html enviado vira download, nunca página', (r.res.headers.get('content-disposition') || '').startsWith('attachment')
      && (r.res.headers.get('content-security-policy') || '').includes('sandbox'));
    r = await juan('POST', '/api/media', form({ sender: 'Juan', file: { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), type: 'image/svg+xml', name: 'x.svg' } }));
    r = await juan('GET', `/api/media/${r.json.message.mediaId}`, undefined, { raw: true });
    check('svg enviado vira download', (r.res.headers.get('content-disposition') || '').startsWith('attachment'));
    if (hasBin('ffmpeg')) {
      // Áudio gravado no Chrome (WebM/Opus) não toca no Safari do iPhone.
      r = await juan('POST', '/api/media', form({ sender: 'Juan', file: { buffer: realAudio('webm'), type: 'audio/webm;codecs=opus', name: 'voz.webm' } }));
      const voice = r.json.message;
      check('áudio WebM vira .m4a (toca no iPhone)', voice.type === 'audio' && voice.mimeType === 'audio/mp4' && /\.m4a$/.test(voice.filename), voice);
      r = await teo('GET', `/api/media/${voice.mediaId}`, undefined, { raw: true, headers: { Range: 'bytes=0-11' } });
      check('…e o outro lado recebe um MP4 de verdade', r.res.status === 206 && r.buf.toString('latin1', 4, 8) === 'ftyp'
        && r.res.headers.get('content-type') === 'audio/mp4');
    }
    // Áudio que não dá pra converter: vai o original mesmo, sem quebrar nada.
    r = await juan('POST', '/api/media', form({ sender: 'Juan', file: { buffer: Buffer.from('OggS-nao-e-audio'), type: 'audio/ogg', name: 'x.opus' } }));
    check('áudio que não converte entra do jeito que veio', r.res.status === 200 && r.json.message.mimeType === 'audio/ogg');
    r = await teo('GET', `/api/media/${r.json.message.mediaId}`, undefined, { raw: true });
    check('…e continua abrindo', r.res.status === 200 && r.buf.toString() === 'OggS-nao-e-audio');
    r = await juan('GET', '/api/media/naoexiste', undefined, { raw: true });
    check('id de mídia inválido = 404', r.res.status === 404);
    r = await anon('GET', `/api/media/${photo.mediaId}`, undefined, { raw: true });
    check('mídia sem sessão = 401', r.res.status === 401);

    console.log('\n# coleção de figurinhas e GIFs');
    r = await juan('POST', '/api/stickers', form({ sender: 'Juan', kind: 'sticker', width: 1, height: 1, file: { buffer: PNG, type: 'image/png', name: 'f.png' } }));
    const st = r.json.sticker;
    check('cria figurinha', r.res.status === 200 && st.kind === 'sticker');
    r = await teo('POST', '/api/stickers', form({ sender: 'Teo', kind: 'sticker', file: { buffer: PNG, type: 'image/png', name: 'f.png' } }));
    check('mesmo arquivo não duplica', r.json.duplicate === true && r.json.sticker.id === st.id);
    r = await juan('POST', '/api/stickers', form({ sender: 'Juan', kind: 'sticker', file: { buffer: Buffer.from('nao sou imagem'), type: 'text/plain', name: 'a.txt' } }));
    check('só imagem entra na coleção', r.res.status === 400);
    r = await teo('GET', '/api/stickers');
    check('coleção é compartilhada', r.json.stickers.length === 1);
    r = await teo('POST', `/api/stickers/${st.id}/send`, { sender: 'Teo' });
    const stMsg = r.json.message;
    check('manda figurinha (aponta pro mesmo arquivo)', stMsg.type === 'sticker' && stMsg.mediaId === st.mediaId);
    r = await teo('POST', `/api/stickers/${st.id}/send`, { sender: 'Teo', replyToId: m1.id });
    const stMsg2 = r.json.message;
    check('figurinha como resposta', !!stMsg2.replyTo);
    r = await juan('POST', `/api/messages/${stMsg.id}/delete`, { requesterName: 'Juan' });
    r = await juan('GET', `/api/media/${st.mediaId}`, undefined, { raw: true });
    check('apagar UMA mensagem não apaga o arquivo da figurinha', r.res.status === 200 && r.buf.equals(PNG));
    r = await juan('POST', `/api/stickers/${st.id}/delete`);
    r = await juan('GET', `/api/media/${st.mediaId}`, undefined, { raw: true });
    check('remover da coleção não quebra mensagem já enviada', r.res.status === 200);
    r = await juan('POST', '/api/stickers/from-message', { requesterName: 'Juan', messageId: stMsg2.id });
    check('figurinha recebida volta pra coleção', r.res.status === 200 && r.json.sticker.mediaId === st.mediaId);
    const st2 = r.json.sticker;
    r = await juan('POST', `/api/stickers/${st2.id}/delete`);
    r = await juan('POST', `/api/messages/${stMsg2.id}/delete`, { requesterName: 'Juan' });
    r = await juan('GET', `/api/media/${st.mediaId}`, undefined, { raw: true });
    check('sem mais ninguém apontando, o arquivo sai do disco', r.res.status === 404);

    r = await juan('POST', '/api/media', form({ sender: 'Juan', file: { buffer: GIF, type: 'image/gif', name: 'a.gif' } }));
    const gifMsg = r.json.message;
    check('gif enviado ganha a marca', gifMsg.gif === true);
    r = await teo('POST', '/api/stickers/from-message', { requesterName: 'Teo', messageId: gifMsg.id });
    const savedGif = r.json.sticker;
    check('salva gif da conversa nos GIFs', savedGif.kind === 'gif' && savedGif.mediaId === gifMsg.mediaId);
    r = await teo('POST', '/api/stickers/from-message', { requesterName: 'Teo', messageId: photo.id });
    check('foto comum não vai pros GIFs por esse caminho', r.res.status === 400);
    r = await juan('POST', `/api/messages/${gifMsg.id}/delete`, { requesterName: 'Juan' });
    r = await teo('POST', `/api/stickers/${savedGif.id}/send`, { sender: 'Teo' });
    check('gif salvo sobrevive à mensagem original apagada', r.res.status === 200 && r.json.message.gif === true && r.json.message.type === 'image');

    console.log('\n# busca de GIF (GIPHY falso)');
    r = await juan('GET', '/api/gifs/search?q=gato');
    check('busca devolve só resultado de host permitido', r.res.status === 200 && r.json.items.length === 1 && r.json.items[0].id === 'abc');
    const hit = r.json.items[0];
    r = await juan('GET', `/api/gifs/preview?u=${encodeURIComponent(hit.preview)}`, undefined, { raw: true });
    check('prévia repassada pelo servidor', r.res.status === 200 && r.buf.equals(GIF));
    r = await juan('GET', `/api/gifs/preview?u=${encodeURIComponent('http://127.0.0.1:1/x')}`, undefined, { raw: true });
    check('prévia recusa host de fora', r.res.status === 400);
    r = await juan('GET', `/api/gifs/preview?u=${encodeURIComponent('https://giphy.com.evil.example/x.gif')}`, undefined, { raw: true });
    check('prévia recusa domínio parecido', r.res.status === 400);
    r = await juan('POST', '/api/gifs/send', { sender: 'Juan', url: hit.url, width: hit.width, height: hit.height });
    check('manda gif da busca (guardado no servidor)', r.res.status === 200 && r.json.message.gif && r.json.message.width === 120);
    const giphyMsg = r.json.message;
    r = await teo('GET', `/api/media/${giphyMsg.mediaId}`, undefined, { raw: true });
    check('gif da busca baixa do próprio servidor', r.buf.equals(GIF));
    r = await juan('POST', '/api/gifs/send', { sender: 'Juan', url: 'https://evil.example/x.gif' });
    check('send recusa url de fora', r.res.status === 400);
    r = await anon('GET', '/api/gifs/search?q=gato');
    check('busca exige sessão', r.res.status === 401);

    console.log('\n# visualização única continua fechada');
    r = await juan('POST', '/api/media', form({ sender: 'Juan', ephemeral: '1', file: { buffer: PNG, type: 'image/png', name: 'e.png' } }));
    const eph = r.json.message;
    check('efêmera não vaza mediaId', !eph.mediaId && eph.ephemeral === true);
    r = await teo('POST', `/api/messages/${eph.id}/star`, { requesterName: 'Teo' });
    check('efêmera não pode ser favoritada', r.res.status === 400);
    r = await teo('POST', '/api/stickers/from-message', { requesterName: 'Teo', messageId: eph.id });
    check('efêmera não entra na coleção', r.res.status === 400);
    r = await teo('POST', `/api/messages/${eph.id}/view`, { requesterName: 'Teo' });
    const ephMediaId = r.json.message.mediaId;
    check('destinatário abre', r.res.status === 200 && !!ephMediaId);
    await new Promise((res) => setTimeout(res, 600));
    r = await teo('GET', `/api/media/${ephMediaId}`, undefined, { raw: true });
    check('efêmera some depois do prazo', r.res.status === 404);

    console.log('\n# v54: editar mensagem');
    r = await juan('POST', '/api/messages', { sender: 'Juan', text: 'oi tudo bem' });
    const ed = r.json.message;
    r = await teo('POST', `/api/messages/${ed.id}/edit`, { requesterName: 'Teo', text: 'hackeado' });
    check('só quem mandou edita', r.res.status === 403);
    r = await juan('POST', `/api/messages/${ed.id}/edit`, { requesterName: 'juan', text: '   ' });
    check('edição vazia = 400', r.res.status === 400);
    r = await juan('POST', `/api/messages/${ed.id}/edit`, { requesterName: 'juan', text: 'oi, tudo bem? https://example.invalid/x' });
    check('edita (nome sem diferenciar maiúsculas)', r.res.status === 200 && r.json.message.text.startsWith('oi, tudo bem?') && !!r.json.message.editedAt);
    check('versão anterior guardada', r.json.message.edits.length === 1 && r.json.message.edits[0].text === 'oi tudo bem' && r.json.message.edits[0].ts === ed.ts);
    r = await juan('POST', `/api/messages/${ed.id}/edit`, { requesterName: 'Juan', text: 'oi, tudo bem? https://example.invalid/x' });
    check('mesmo texto não cria versão nova', r.json.message.edits.length === 1);
    r = await juan('POST', `/api/messages/${ed.id}/edit`, { requesterName: 'Juan', text: 'oi, tudo bem com você?' });
    r = await teo('GET', '/api/messages');
    const edSeen = r.json.messages.find((x) => x.id === ed.id);
    check('o outro vê a edição e o histórico', edSeen.text === 'oi, tudo bem com você?' && edSeen.edits.length === 2);
    r = await juan('POST', `/api/messages/${photo.id}/edit`, { requesterName: 'Juan', text: 'x' });
    check('mídia não edita', r.res.status === 400 || r.res.status === 410);

    console.log('\n# v54: presença');
    r = await teo('POST', '/api/presence', { cid: 'x', name: 'Teo', state: 'active' });
    check('cid inválido = 400', r.res.status === 400);
    r = await teo('POST', '/api/presence', { cid: 'teo-tab-0001', name: 'Teo', state: 'active', device: 'iPhone' });
    let pTeo = r.json.presence.people.find((x) => x.name === 'Teo');
    check('aba na tela = online', r.res.status === 200 && r.json.presence.online.includes('Teo') && pTeo.devices[0].device === 'iPhone');
    r = await juan('POST', '/api/presence', { cid: 'juan-tab-0001', name: 'Juan', state: 'hidden', device: 'Mac' });
    let pJuan = r.json.presence.people.find((x) => x.name === 'Juan');
    check('aba em segundo plano não conta como online', pJuan.state === 'offline' && !r.json.presence.online.includes('Juan'));
    r = await teo('POST', '/api/presence', { cid: 'teo-tab-0001', name: 'Teo', state: 'idle' });
    pTeo = r.json.presence.people.find((x) => x.name === 'Teo');
    check('parada na tela = ausente, com horário', pTeo.state === 'away' && typeof pTeo.lastSeen === 'number');
    r = await teo('POST', '/api/presence', { cid: 'teo-tab-0001', name: 'Teo', state: 'active' });
    await new Promise((res) => setTimeout(res, 3300));
    r = await juan('POST', '/api/presence', { cid: 'juan-tab-0001', name: 'Juan', state: 'active' });
    pTeo = r.json.presence.people.find((x) => x.name === 'Teo');
    check('aba que parou de bater cai sozinha (visto por último)', pTeo && pTeo.state === 'offline' && typeof pTeo.lastSeen === 'number', pTeo);
    check('quem bate continua online', r.json.presence.online.includes('Juan'));

    console.log('\n# v54: visualização única de vídeo');
    const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), crypto.randomBytes(64)]);
    r = await juan('POST', '/api/media', form({ sender: 'Juan', ephemeral: '1', duration: '120.4', file: { buffer: FAKE_MP4, type: 'video/mp4', name: 'v.mp4' } }));
    const ephV = r.json.message;
    check('duração não vaza antes de abrir', ephV.duration === undefined && !ephV.mediaId);
    r = await teo('POST', `/api/messages/${ephV.id}/view`, { requesterName: 'Teo' });
    const ephVMedia = r.json.message.mediaId;
    check('vídeo: janela cobre o vídeo inteiro', r.json.closesOnEnd === true && r.json.remainingMs > 120000, r.json.remainingMs);
    await new Promise((res) => setTimeout(res, 600));
    r = await teo('GET', `/api/media/${ephVMedia}`, undefined, { raw: true, headers: { Range: 'bytes=0-9' } });
    check('vídeo longo continua tocando depois dos segundos da foto', r.res.status === 206);
    r = await juan('POST', `/api/messages/${ephV.id}/view-done`, { requesterName: 'Juan' });
    check('quem mandou não encerra', r.res.status === 403);
    r = await teo('POST', `/api/messages/${ephV.id}/view-done`, { requesterName: 'Teo' });
    check('terminou de ver: encerra', r.res.status === 200);
    r = await teo('GET', `/api/media/${ephVMedia}`, undefined, { raw: true });
    check('vídeo some ao terminar', r.res.status === 404);
    r = await juan('POST', '/api/media', form({ sender: 'Juan', ephemeral: '1', file: { buffer: FAKE_MP4, type: 'video/mp4', name: 'v2.mp4' } }));
    r = await teo('POST', `/api/messages/${r.json.message.id}/view`, { requesterName: 'Teo' });
    check('vídeo sem duração: teto longo (fecha pelo view-done)', r.json.remainingMs > 60000);

    console.log('\n# v54: changelog no chat');
    writeChangelog(['t2', 't1']);
    r = await juan('GET', '/api/messages');
    let sys = r.json.messages.filter((x) => x.type === 'system');
    check('versão nova vira cartão na conversa', sys.length === 1 && sys[0].version === 't2' && sys[0].items[0] === 'item de t2');
    r = await teo('GET', '/api/messages');
    check('cartão aparece uma vez só', r.json.messages.filter((x) => x.type === 'system').length === 1);
    writeChangelog(['t4', 't3', 't2', 't1']);
    r = await teo('GET', '/api/boot?name=Teo');
    r = await juan('GET', '/api/messages');
    sys = r.json.messages.filter((x) => x.type === 'system').map((x) => x.version);
    check('pulou versões: anuncia as que faltam, em ordem', JSON.stringify(sys) === JSON.stringify(['t2', 't3', 't4']), sys);

    console.log('\n# v54: backup');
    r = await juan('GET', '/api/export/plan');
    const plan = r.json;
    check('plano do backup', r.res.status === 200 && plan.files >= 1 && plan.parts.length === plan.files && plan.bytes > 0, plan);
    const listZip = (buf) => {
      const f = path.join(DATA_DIR, '..', `pc-zip-${PORT}.zip`);
      fs.writeFileSync(f, buf);
      try {
        return execFileSync('unzip', ['-Z1', f]).toString().trim().split('\n');
      } finally {
        fs.rmSync(f, { force: true });
      }
    };
    const readZip = (buf, name) => {
      const f = path.join(DATA_DIR, '..', `pc-zip-${PORT}.zip`);
      fs.writeFileSync(f, buf);
      try {
        return execFileSync('unzip', ['-p', f, name]).toString();
      } finally {
        fs.rmSync(f, { force: true });
      }
    };
    r = await juan('GET', '/api/export?only=text', undefined, { raw: true });
    check('só mensagens: zip na hora', r.res.status === 200 && r.buf.slice(0, 2).toString() === 'PK' && /so-mensagens/.test(r.res.headers.get('content-disposition')));
    if (hasBin('unzip')) {
      check('só mensagens: só o texto', JSON.stringify(listZip(r.buf).sort()) === JSON.stringify(['conversa.json', 'conversa.txt']));
      const txt = readZip(r.buf, 'conversa.txt');
      check('texto do backup marca a edição e guarda a versão anterior', txt.includes('(editada)') && txt.includes('versão anterior') && txt.includes('oi tudo bem'));
      check('texto do backup traz o changelog', txt.includes('Atualização do sistema (t4)'));
      r = await juan('GET', '/api/export?part=1', undefined, { raw: true });
      const names = listZip(r.buf);
      check('parte 1: conversa + 1 mídia', r.res.status === 200 && names.includes('conversa.txt') && names.filter((n) => !n.startsWith('conversa.')).length === 1, names);
      r = await juan('GET', '/api/export', undefined, { raw: true });
      const all = listZip(r.buf).filter((n) => !n.startsWith('conversa.'));
      check('completo: todas as mídias', all.length === plan.files, { all: all.length, files: plan.files });
      check('visualização única fora do backup', !all.some((n) => n.includes('v.mp4') || n.includes('v2.mp4')));
    }
    r = await juan('GET', '/api/export?part=999', undefined, { raw: true });
    check('parte que não existe = 404', r.res.status === 404);

    console.log('\n# exportar e limpar');
    r = await juan('GET', '/api/export', undefined, { raw: true });
    check('export gera zip', r.res.status === 200 && r.buf.slice(0, 2).toString() === 'PK');
    r = await juan('POST', '/api/clear');
    check('limpa conversa', r.res.status === 200);
    r = await juan('GET', '/api/messages');
    check('conversa vazia', r.json.messages.length === 0);
    r = await juan('GET', '/api/boot?name=Juan');
    check('limpar mantém coleção e atalhos', r.json.stickers.length === 1 && JSON.stringify(r.json.quickReactions) === JSON.stringify(custom));
    r = await juan('GET', `/api/media/${savedGif.mediaId}`, undefined, { raw: true });
    check('arquivo da coleção sobrevive ao limpar', r.res.status === 200 && r.buf.equals(GIF));
    r = await juan('GET', `/api/media/${photo.mediaId}`, undefined, { raw: true });
    check('mídia da conversa foi apagada', r.res.status === 404);
    const left = fs.readdirSync(path.join(DATA_DIR, 'media'));
    check('sobrou no disco só o arquivo da coleção', left.length === 1, left);

    console.log('\n# figurinha feita no servidor (galeria, link, GIPHY)');
    r = await juan('GET', '/api/boot?name=Juan');
    const tools = r.json.stickerTools === true;
    check('boot informa conversor e importação do WhatsApp', typeof r.json.stickerTools === 'boolean' && r.json.waImport === !!waDir, r.json);
    console.log(`      (conversor ${tools ? 'ligado' : 'desligado'} nesta máquina)`);
    const before = (await juan('GET', '/api/stickers')).json.stickers.length;
    r = await juan('POST', '/api/stickers/convert', form({ sender: 'Juan', file: { buffer: GIF, type: 'image/gif', name: 'a.gif' } }));
    check('GIF da galeria vira figurinha', r.res.status === 200 && r.json.sticker.kind === 'sticker'
      && r.json.sticker.mimeType === (tools ? 'image/webp' : 'image/gif'), r.json);
    const fromGallery = r.json.sticker;
    r = await juan('GET', `/api/media/${fromGallery.mediaId}`, undefined, { raw: true });
    check('figurinha convertida abre', r.res.status === 200 && (tools ? r.buf.toString('ascii', 8, 12) === 'WEBP' : r.buf.equals(GIF)));
    r = await juan('POST', '/api/stickers/convert', form({ sender: 'Juan', file: { buffer: Buffer.from('oi'), type: 'text/plain', name: 'a.txt' } }));
    check('texto não vira figurinha', r.res.status === 400);
    r = await juan('POST', '/api/stickers/convert', form({ sender: 'Juan', file: { buffer: Buffer.from('não é vídeo nenhum'), type: 'video/mp4', name: 'v.mp4' } }));
    check('vídeo quebrado responde com erro legível', [422, 501].includes(r.res.status) && /figurinha|arquivo|ferramentas/i.test(r.json.message), r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: `${fakeOrigin}/media/cat.gif` });
    check('resultado do GIPHY vira figurinha (mesmo arquivo = não duplica)', r.res.status === 200 && r.json.duplicate === true && r.json.sticker.id === fromGallery.id, r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: 'olha esse https://x.com/fulano/status/111?s=20 kkk' });
    check('link do X (no meio do texto) vira figurinha', r.res.status === 200 && r.json.sticker.id === fromGallery.id, r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: 'https://twitter.com/fulano/status/222' });
    check('post do X sem mídia avisa', r.res.status === 422 && /não tem foto/.test(r.json.message), r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: 'https://x.com/fulano/status/333' });
    check('mídia do X fora do twimg é recusada', r.res.status === 422, r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: 'http://127.0.0.1:1/x.gif' });
    check('link de outro lugar é recusado', r.res.status === 422 && /X\/Twitter e do GIPHY/.test(r.json.message), r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan', url: 'https://giphy.com.evil.example/media/x.gif' });
    check('domínio parecido com GIPHY é recusado', r.res.status === 422, r.json);
    r = await juan('POST', '/api/stickers/from-link', { sender: 'Juan' });
    check('link vazio = 400', r.res.status === 400);
    r = await juan('GET', '/api/stickers/giphy-search?q=gato');
    check('busca de figurinhas no GIPHY', r.res.status === 200 && r.json.items.length === 1 && r.json.items[0].id === 'abc');
    r = await anon('POST', '/api/stickers/from-link', { sender: 'x', url: `${fakeOrigin}/media/cat.gif` });
    check('criar por link exige sessão', r.res.status === 401);
    r = await juan('GET', '/api/stickers');
    check('coleção ganhou só 1 item (o resto era o mesmo arquivo)', r.json.stickers.length === before + 1, r.json.stickers.length);

    if (waDir) {
      console.log('\n# figurinhas do WhatsApp (contêiner falso)');
      const redKey = crypto.createHash('sha256').update(WEBP_RED).digest('hex');
      const blueKey = crypto.createHash('sha256').update(WEBP_BLUE).digest('hex');
      const criadaKey = crypto.createHash('sha256').update(WEBP_CRIADA).digest('hex');
      const recebidaKey = crypto.createHash('sha256').update(WA_RECEBIDA).digest('hex');
      const favItems = (j) => j.items.filter((it) => it.group === 'fav');
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      check('sem conectar o WhatsApp a lista não abre (409)', r.res.status === 409 && r.json.error === 'not_linked', r.json);
      r = await juan('GET', '/api/whatsapp/status?name=Juan');
      check('status: ainda não conectado', r.res.status === 200 && r.json.linked === false, r.json);
      r = await juan('POST', '/api/whatsapp/link', { sender: 'Juan', number: '(83) 9 9000-1111' });
      check('número do Mac (com o 9 a mais) -> código pela conversa "Você"', r.res.status === 200 && r.json.method === 'code'
        && botCodes.length === 1 && /^\d{6}$/.test(botCodes[0]), r.json);
      r = await juan('POST', '/api/whatsapp/verify', { sender: 'Juan', code: botCodes[0] === '000000' ? '111111' : '000000' });
      check('código errado = 400', r.res.status === 400 && /errado/i.test(r.json.message), r.json);
      r = await teo('POST', '/api/whatsapp/verify', { sender: 'Teo', code: botCodes[0] });
      check('o código do Juan não conecta o Teo', r.res.status === 400, r.json);
      r = await juan('POST', '/api/whatsapp/verify', { sender: 'JUAN', code: botCodes[0] });
      check('código certo conecta o WhatsApp do Mac pro Juan', r.res.status === 200 && r.json.ok, r.json);
      r = await juan('GET', '/api/whatsapp/status?name=juan');
      check('status: conectado, fonte do Mac, número mascarado', r.json.linked === true && r.json.kind === 'mac'
        && r.json.number === '+55 83 •••••-1111', r.json);
      check('o índice das conexões fica cifrado no disco', fs.existsSync(path.join(DATA_DIR, 'wa-links', 'index.enc'))
        && !fs.readFileSync(path.join(DATA_DIR, 'wa-links', 'index.enc')).toString('latin1').includes('558390001111'));
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      check('favoritas: 2 com arquivo (local e baixada), 1 perdida', r.res.status === 200 && r.json.groups.fav.total === 3
        && r.json.groups.fav.missing === 1 && favItems(r.json).length === 2 && r.json.items[0].key === redKey && r.json.items[1].key === blueKey, r.json);
      check('as que ele mandou (criadas) vêm das conversas, com a chave no formato do ChatStorage', r.json.groups.mine.total === 2
        && r.json.groups.mine.missing === 1 && r.json.items[2].key === criadaKey && r.json.items[2].group === 'mine', r.json);
      check('as recebidas vêm por último; link expirado e Lottie ficam de fora', r.json.groups.chat.total === 3
        && r.json.groups.chat.missing === 2 && r.json.items.length === 4 && r.json.items[3].key === recebidaKey && r.json.items[3].group === 'chat', r.json);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${criadaKey}?name=Juan`, undefined, { raw: true });
      check('prévia da criada (baixada da conversa) chega igual', r.res.status === 200 && r.buf.equals(WEBP_CRIADA));
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [criadaKey] });
      check('importa figurinha que só passou por conversa', r.res.status === 200 && r.json.added === 1, r.json);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${blueKey}?name=Juan`, undefined, { raw: true });
      check('prévia da favorita (baixada e decifrada) chega igual', r.res.status === 200 && r.buf.equals(WEBP_BLUE)
        && r.res.headers.get('content-type') === 'image/webp' && (r.res.headers.get('content-security-policy') || '').includes('sandbox'));
      r = await juan('GET', '/api/stickers/whatsapp-favorites/nao-e-hash', undefined, { raw: true });
      check('prévia com chave inválida = 404', r.res.status === 404);
      r = await anon('GET', `/api/stickers/whatsapp-favorites/${redKey}?name=Juan`, undefined, { raw: true });
      check('prévia exige sessão', r.res.status === 401);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: 'tudo' });
      check('importar sem lista de escolhidas = 400', r.res.status === 400);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [blueKey, 'f'.repeat(64)] });
      check('importa só a escolhida', r.res.status === 200 && r.json.added === 1 && r.json.missing === 1, r.json);
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      check('lista marca a que já entrou', r.json.items.find((it) => it.key === blueKey).inLibrary === true
        && r.json.items.find((it) => it.key === redKey).inLibrary === false, r.json);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [blueKey] });
      check('importar de novo a mesma conta como repetida', r.res.status === 200 && r.json.added === 0 && r.json.duplicates === 1, r.json);
      r = await juan('GET', '/api/stickers');
      check('só a escolhida entrou; botão continua', r.json.waImport === true
        && r.json.stickers.filter((st) => st.width === 2).length === 2, r.json.waImport);
      r = await teo('GET', '/api/boot?name=Teo');
      check('…pros dois', r.json.waImport === true);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${redKey}?name=Juan`, undefined, { raw: true });
      check('prévia da que falta continua aberta', r.res.status === 200 && r.buf.equals(WEBP_RED));
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [redKey] });
      check('dá pra voltar e importar outra depois', r.res.status === 200 && r.json.added === 1, r.json);
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      check('…e as duas aparecem como já na coleção', favItems(r.json).every((it) => it.inLibrary === true) && r.json.groups.fav.missing === 1, r.json);
      waReceiveFromPhone(waDir, fakeOrigin);
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      const sumiuKey = crypto.createHash('sha256').update(WA_SUMIU).digest('hex');
      check('a perdida aparece depois de chegar numa conversa (link da mensagem)', r.json.groups.fav.missing === 0
        && favItems(r.json).length === 3 && r.json.items[2].key === sumiuKey && r.json.items[2].inLibrary === false, r.json);
      check('…e continua no grupo das favoritas, não repete nas mandadas', r.json.items.filter((it) => it.key === sumiuKey).length === 1
        && r.json.groups.mine.total === 2, r.json.groups);
      waAddOldStickers(waDir, fakeOrigin);
      const velhaKey = crypto.createHash('sha256').update(WEBP_VELHA).digest('hex');
      for (let i = 0; i < 25; i++) {
        r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
        if (r.json.items.some((it) => it.key === velhaKey) && !r.json.recovering) break;
        await new Promise((ok) => setTimeout(ok, 150));
      }
      const velha = r.json.items.find((it) => it.key === velhaKey);
      check('favorita de link expirado volta pelo celular (pedido ao Bot de Figurinhas)', velha && velha.group === 'fav'
        && r.json.recovering === 0 && r.json.groups.fav.missing === 0, r.json);
      check('…e o arquivo fica guardado em data/wa-cache', fs.existsSync(path.join(DATA_DIR, 'wa-cache', `${velhaKey}.webp`)));
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${velhaKey}?name=Juan`, undefined, { raw: true });
      check('prévia da que voltou do celular chega igual', r.res.status === 200 && r.buf.equals(WEBP_VELHA));
      const askedNao = botCalls.filter((b) => b.id === 'NAOTEM1').length;
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      await new Promise((ok) => setTimeout(ok, 300));
      check('mandada que o celular não tem mais: pede uma vez só e conta como faltando', askedNao === 1
        && botCalls.filter((b) => b.id === 'NAOTEM1').length === 1 && r.json.groups.mine.missing === 2, { askedNao, groups: r.json.groups });
      check('recebidas antigas não são pedidas ao celular', !botCalls.some((b) => b.remoteJid !== '120363000000000000@g.us'), botCalls.map((b) => b.id));
      r = await anon('POST', '/api/stickers/import-whatsapp', { sender: 'x', keys: [] });
      check('importar exige sessão', r.res.status === 401);

      console.log('\n# cada um conecta o próprio WhatsApp (v51)');
      r = await teo('GET', '/api/stickers/whatsapp-favorites?name=Teo');
      check('o Teo não vê as figurinhas do WhatsApp do Juan', r.res.status === 409, r.json);
      r = await teo('GET', `/api/stickers/whatsapp-favorites/${redKey}?name=Teo`, undefined, { raw: true });
      check('nem a prévia', r.res.status === 404);
      r = await teo('POST', '/api/stickers/import-whatsapp', { sender: 'Teo', keys: [redKey] });
      check('nem importa do WhatsApp do Juan', r.res.status === 409, r.json);
      r = await teo('POST', '/api/whatsapp/link', { sender: 'Teo', number: '12' });
      check('número curto = 400', r.res.status === 400, r.json);
      r = await teo('POST', '/api/whatsapp/link', { sender: 'Teo', number: '11 98888-7777' });
      check('outro número -> código de pareamento pro celular', r.res.status === 200 && r.json.method === 'pairing' && r.json.code === 'ABCD-1234', r.json);
      let st = null;
      for (let i = 0; i < 40; i++) {
        r = await teo('GET', '/api/whatsapp/status?name=Teo');
        st = r.json;
        if (st.linked && st.state === 'ready') break;
        await new Promise((ok) => setTimeout(ok, 100));
      }
      check('depois de digitar no celular: conectado como aparelho', st && st.linked && st.kind === 'device'
        && st.state === 'ready' && st.number === '+55 11 •••••-7777', st);
      const teoFavKey = crypto.createHash('sha256').update(TEO_FAV).digest('hex');
      const teoMineKey = crypto.createHash('sha256').update(TEO_MINE).digest('hex');
      const teoRecvKey = crypto.createHash('sha256').update(TEO_RECV).digest('hex');
      for (let i = 0; i < 30; i++) {
        r = await teo('GET', '/api/stickers/whatsapp-favorites?name=Teo');
        if (r.json.items && r.json.items.length === 3 && !r.json.recovering) break;
        await new Promise((ok) => setTimeout(ok, 100));
      }
      const keysOf = (j) => (j.items || []).map((it) => `${it.group}:${it.key}`).join(' ');
      check('Teo vê só as dele: favorita (da sincronização), mandada (voltou pelo celular) e recebida', r.res.status === 200
        && r.json.source === 'device' && keysOf(r.json) === `fav:${teoFavKey} mine:${teoMineKey} chat:${teoRecvKey}`
        && r.json.groups.fav.total === 1 && r.json.groups.mine.missing === 0, r.json);
      check('…e nada do Juan', !r.json.items.some((it) => [redKey, blueKey, criadaKey].includes(it.key)));
      r = await teo('GET', `/api/stickers/whatsapp-favorites/${teoMineKey}?name=Teo`, undefined, { raw: true });
      check('prévia da que voltou do celular do Teo chega igual', r.res.status === 200 && r.buf.equals(TEO_MINE));
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${teoFavKey}?name=Juan`, undefined, { raw: true });
      check('o Juan não abre as do Teo', r.res.status === 404);
      const linkFiles = fs.readdirSync(path.join(DATA_DIR, 'wa-links'));
      const blob = linkFiles.find((f) => f.endsWith('.enc') && f !== 'index.enc');
      check('conexão do Teo guardada cifrada (sem o número em claro)', blob
        && !fs.readFileSync(path.join(DATA_DIR, 'wa-links', blob)).toString('latin1').includes('5511988887777'), linkFiles);
      const libList = (await juan('GET', '/api/stickers')).json.stickers;
      const libBefore = libList.length;
      const teoBefore = libList.filter((x) => x.addedBy === 'Teo').length;
      r = await teo('POST', '/api/stickers/import-whatsapp', { sender: 'Teo', keys: [teoFavKey, teoMineKey] });
      check('Teo importa as dele', r.res.status === 200 && r.json.added === 2, r.json);
      r = await juan('GET', '/api/stickers');
      check('…e elas entram na coleção dos dois', r.json.stickers.length === libBefore + 2
        && r.json.stickers.filter((x) => x.addedBy === 'Teo').length === teoBefore + 2, { libBefore, n: r.json.stickers.length });
      r = await teo('GET', '/api/stickers/whatsapp-favorites?name=Teo');
      check('a lista do Teo marca as importadas', r.json.items.filter((it) => it.inLibrary).length === 2, r.json.items);
      r = await juan('GET', '/api/stickers/whatsapp-favorites?name=Juan');
      check('o Juan continua vendo só as do Mac', r.res.status === 200 && r.json.source === 'mac'
        && !r.json.items.some((it) => [teoFavKey, teoMineKey, teoRecvKey].includes(it.key)), r.json.source);
      r = await teo('POST', '/api/whatsapp/link', { sender: 'Teo', number: '11 98888-7777' });
      check('conectar de novo sem desconectar = 400', r.res.status === 400, r.json);
      r = await teo('POST', '/api/whatsapp/unlink', { sender: 'Teo' });
      check('Teo desconecta (sai do celular também)', r.res.status === 200 && r.json.removedFromPhone === true, r.json);
      r = await teo('GET', '/api/whatsapp/status?name=Teo');
      check('…status volta a não conectado e os arquivos somem', r.json.linked === false
        && !fs.readdirSync(path.join(DATA_DIR, 'wa-links')).some((f) => f.startsWith(blob.replace('.enc', ''))), r.json);
      r = await juan('GET', '/api/stickers');
      check('…e as figurinhas que ele importou continuam na coleção', r.json.stickers.filter((x) => x.addedBy === 'Teo').length === teoBefore + 2);
      r = await juan('GET', '/api/whatsapp/status?name=Juan');
      check('a conexão do Juan não mudou', r.json.linked === true && r.json.kind === 'mac');
      await juan('POST', '/api/clear');
      r = await juan('GET', '/api/boot?name=Juan');
      check('limpar a conversa mantém a coleção e o botão', r.json.waImport === true && r.json.stickers.length > 0);
    } else {
      console.log('      (sem sqlite3: pulando as favoritas do WhatsApp)');
    }

    if (process.platform === 'darwin') {
      console.log('\n# cofre do Juan (v52)');
      const archiver = require('archiver');
      const zipOf = (files) => new Promise((resolve, reject) => {
        const a = archiver('zip');
        const parts = [];
        a.on('data', (d) => parts.push(d));
        a.on('end', () => resolve(Buffer.concat(parts)));
        a.on('error', reject);
        for (const [name, buf] of files) a.append(buf, { name });
        a.finalize();
      });
      const withFfmpeg = hasBin('ffmpeg');
      const AUDIO = withFfmpeg ? realAudio('opus') : Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(200)]);
      const ROT = withFfmpeg ? rotatedJpeg(64, 32) : null; // gravada 64x32, aparece 32x64
      const inner = await zipOf([['00000001-STICKER-2025-03-01-12-34-56.webp', TEO_RECV], ['00000002-AUDIO-2025-03-02-10-00-00.opus', AUDIO], ['_chat.txt', Buffer.from('conversa secreta')]]);
      const outerFiles = [['Pasta/IMG_0001.PNG', PNG], ['Pasta/copia.png', PNG], ['__MACOSX/Pasta/._IMG_0001.PNG', Buffer.from('lixo')], ['Pasta/WhatsApp Chat - X.zip', inner]];
      if (ROT) outerFiles.push(['Pasta/IMG_0002.JPG', ROT]);
      const outer = await zipOf(outerFiles);
      fs.mkdirSync(path.join(DATA_DIR, 'vault', 'inbox'), { recursive: true });
      const inboxZip = path.join(DATA_DIR, 'vault', 'inbox', 'pacote.zip');
      fs.writeFileSync(inboxZip, outer);
      r = await teo('GET', '/api/vault/status?name=Teo');
      check('cofre não existe pra quem não é o dono', r.res.status === 404);
      r = await teo('GET', '/api/boot?name=Teo');
      check('boot: sem botão do cofre pro Teo', r.json.vault === false);
      r = await juan('GET', '/api/boot?name=Juan');
      check('boot: botão do cofre pro Juan', r.json.vault === true);
      r = await juan('GET', '/api/vault/status?name=Juan');
      check('status: cofre por criar, um zip esperando', r.res.status === 200 && r.json.exists === false && r.json.inbox === 1, r.json);
      r = await juan('POST', '/api/vault/setup', { sender: 'Juan', code: '123' });
      check('código curto = 400', r.res.status === 400, r.json);
      r = await teo('POST', '/api/vault/setup', { sender: 'Teo', code: 'segredo-do-teo' });
      check('o Teo não cria o cofre', r.res.status === 404);
      r = await juan('POST', '/api/vault/setup', { sender: 'Juan', code: 'cofre-do-juan' });
      check('Juan cria o cofre', r.res.status === 200 && r.json.ok, r.json);
      for (let i = 0; i < 100; i++) {
        r = await juan('GET', '/api/vault/status?name=Juan');
        if (!r.json.job && r.json.inbox === 0) break;
        await new Promise((ok) => setTimeout(ok, 150));
      }
      check('importação termina e o zip em claro some', r.json.unlocked && !r.json.job && r.json.inbox === 0 && !fs.existsSync(inboxZip), r.json);
      check('contagem: 1 foto (cópia repetida fica de fora), 1 figurinha, 1 áudio do export', r.json.counts.image === (ROT ? 2 : 1)
        && r.json.counts.sticker === 1 && r.json.counts.audio === 1 && !r.json.counts.video, r.json.counts);
      const vaultFiles = [];
      (function walk(d) { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else vaultFiles.push(full); } })(path.join(DATA_DIR, 'vault'));
      const leaks = vaultFiles.filter((f) => { const b = fs.readFileSync(f); return b.includes(PNG.subarray(0, 16)) || b.includes(Buffer.from('RIFF')) || b.includes(Buffer.from('conversa secreta')) || b.includes(Buffer.from('PK\x03\x04')); });
      check('nada em claro na pasta do cofre (nem foto, nem figurinha, nem o zip)', leaks.length === 0 && vaultFiles.some((f) => f.includes(`${path.sep}zips${path.sep}`)), leaks);
      check('nenhum arquivo com extensão de imagem', !vaultFiles.some((f) => /\.(png|jpe?g|webp|heic|mp4|mov|zip)$/i.test(f)));
      r = await juan('GET', '/api/vault/items?name=Juan');
      const vItems = r.json.items || [];
      const vPng = vItems.find((it) => it.kind === 'image' && it.mime === 'image/png');
      const vRot = vItems.find((it) => it.kind === 'image' && it.mime === 'image/jpeg');
      const vSticker = vItems.find((it) => it.kind === 'sticker');
      const vAudio = vItems.find((it) => it.kind === 'audio');
      check('itens: data do export do WhatsApp vira a data do item', vSticker && vSticker.from === 'whatsapp'
        && new Date(vSticker.ts).getFullYear() === 2025 && vPng && vPng.from === 'pasta' && vPng.thumb === true, vItems);
      r = await juan('GET', `/api/vault/file/${vPng.id}`, undefined, { raw: true });
      check('foto volta igual', r.res.status === 200 && r.buf.equals(PNG) && (r.res.headers.get('content-security-policy') || '').includes('sandbox'));
      r = await juan('GET', `/api/vault/thumb/${vPng.id}`, undefined, { raw: true });
      check('miniatura em JPEG', r.res.status === 200 && r.buf[0] === 0xff && r.buf[1] === 0xd8);
      r = await juan('GET', `/api/vault/file/${vAudio.id}`, undefined, { raw: true, headers: { Range: 'bytes=0-3' } });
      check('áudio aceita Range (Safari)', r.res.status === 206 && r.buf.toString() === 'OggS');
      if (ROT) {
        check('foto girada (EXIF) medida em pé no cofre', vRot && vRot.w === 32 && vRot.h === 64, vRot);
        r = await juan('POST', '/api/vault/send', { sender: 'Juan', ids: [vRot.id, vAudio.id] });
        check('manda foto girada + áudio do cofre', r.res.status === 200 && r.json.sent === 2, r.json);
        r = await teo('GET', '/api/messages');
        const [mRot, mAud] = r.json.messages.slice(-2);
        check('…foto chega com a proporção certa (em pé)', mRot.type === 'image' && mRot.width === 32 && mRot.height === 64, mRot);
        check('…áudio .opus do WhatsApp chega como .m4a', mAud.type === 'audio' && mAud.mimeType === 'audio/mp4' && /\.m4a$/.test(mAud.filename), mAud);
        r = await teo('GET', `/api/media/${mAud.mediaId}`, undefined, { raw: true, headers: { Range: 'bytes=0-11' } });
        check('…e o Teo recebe MP4', r.res.status === 206 && r.buf.toString('latin1', 4, 8) === 'ftyp');
      }
      r = await teo('GET', `/api/vault/file/${vPng.id}`, undefined, { raw: true });
      check('o Teo não abre o arquivo do cofre', r.res.status === 404);
      r = await teo('POST', '/api/vault/unlock', { sender: 'Teo', code: 'cofre-do-juan' });
      check('nem com o código certo, usando outro nome', r.res.status === 404);
      const before = (await juan('GET', '/api/messages')).json.messages.length;
      r = await juan('POST', '/api/vault/send', { sender: 'Juan', ids: [vPng.id, vSticker.id] });
      check('manda do cofre pra conversa', r.res.status === 200 && r.json.sent === 2, r.json);
      r = await teo('GET', '/api/messages');
      const last2 = r.json.messages.slice(-2);
      check('…e chegam como foto (com miniatura) e figurinha', r.json.messages.length === before + 2 && last2[0].type === 'image'
        && last2[0].thumbId && last2[1].type === 'sticker', last2);
      r = await teo('GET', `/api/media/${last2[0].mediaId}`, undefined, { raw: true });
      check('o outro lado abre a foto mandada', r.res.status === 200 && r.buf.equals(PNG));
      console.log('\n# v54: fotos novas no cofre e o coração');
      r = await juan('POST', '/api/vault/upload', form({ name: 'Juan', files: { buffer: GIF, type: 'image/gif', name: 'nova.gif' } }));
      check('manda foto pro cofre', r.res.status === 200 && r.json.added === 1, r.json);
      r = await juan('POST', '/api/vault/upload', form({ name: 'Juan', files: { buffer: GIF, type: 'image/gif', name: 'outra.gif' } }));
      check('a mesma foto de novo não duplica', r.json.duplicates === 1 && r.json.added === 0);
      r = await juan('POST', '/api/vault/upload', form({ name: 'Juan', files: { buffer: Buffer.from('oi'), type: 'text/plain', name: 'a.txt' } }));
      check('texto não entra no cofre', r.json.added === 0 && r.json.failed.length === 1);
      r = await teo('POST', '/api/vault/upload', form({ name: 'Teo', files: { buffer: GIF, type: 'image/gif', name: 'x.gif' } }));
      check('Teo não manda pro cofre', r.res.status === 404);
      r = await teo('POST', '/api/heart-photo', form({ name: 'Teo', photo: { buffer: PNG, type: 'image/png', name: 'c.png' } }));
      check('Teo não define a foto do coração', r.res.status === 404);
      r = await juan('POST', '/api/heart-photo', form({ name: 'Juan', crop: JSON.stringify({ itemId: vPng.id, x: 0.1, y: -0.2, zoom: 2 }), photo: { buffer: PNG, type: 'image/png', name: 'c.png' } }));
      check('Juan define a foto do coração', r.res.status === 200 && !!r.json.photo);
      r = await juan('GET', '/api/heart-photo?name=Juan', undefined, { raw: true });
      check('foto do coração volta pro dono', r.res.status === 200 && r.buf.equals(PNG));
      r = await teo('GET', '/api/heart-photo?name=Teo', undefined, { raw: true });
      check('Teo também recebe a foto do coração (vê quando desenha)', r.res.status === 200 && r.buf.equals(PNG));
      r = await teo('GET', '/api/boot?name=Teo');
      check('boot do Teo liga o coração com a foto', r.json.heart && r.json.heart.photo && typeof r.json.heart.photo.v === 'number');
      r = await teo('GET', '/api/heart-photo/crop?name=Teo');
      check('enquadramento continua só do dono', r.res.status === 404);
      r = await teo('POST', '/api/heart-photo/remove', { name: 'Teo' });
      check('Teo não tira a foto do coração', r.res.status === 404);
      r = await juan('GET', '/api/boot?name=Juan');
      check('boot do Juan liga o coração', r.json.heart && r.json.heart.photo && typeof r.json.heart.photo.v === 'number');
      r = await juan('GET', '/api/heart-photo/crop?name=Juan');
      check('enquadramento guardado', r.json.crop && r.json.crop.itemId === vPng.id && r.json.crop.zoom === 2);
      r = await juan('POST', '/api/vault/lock', {});
      r = await juan('GET', '/api/heart-photo?name=Juan', undefined, { raw: true });
      check('animação funciona com o cofre trancado', r.res.status === 200);
      r = await juan('POST', '/api/heart-photo/remove', { name: 'Juan' });
      check('tirar a foto exige cofre aberto', r.res.status === 401);
      r = await juan('POST', '/api/vault/unlock', { sender: 'Juan', code: 'cofre-do-juan' });
      r = await juan('POST', '/api/heart-photo/remove', { name: 'Juan' });
      r = await juan('GET', '/api/heart-photo?name=Juan', undefined, { raw: true });
      check('tira a foto do coração', r.res.status === 404);

      r = await juan('POST', '/api/vault/lock', {});
      r = await juan('GET', '/api/vault/items?name=Juan');
      check('trancado: lista = 401', r.res.status === 401);
      r = await juan('GET', `/api/vault/thumb/${vPng.id}`, undefined, { raw: true });
      check('trancado: miniatura não abre', r.res.status === 404);
      r = await juan('POST', '/api/vault/unlock', { sender: 'Juan', code: 'errado-errado' });
      check('código do cofre errado = 401', r.res.status === 401, r.json);
      r = await juan('POST', '/api/vault/unlock', { sender: 'Juan', code: 'cofre-do-juan' });
      check('código certo abre de novo', r.res.status === 200);
      const recovered = path.join(DATA_DIR, '..', `pc-recuperado-${PORT}.zip`);
      try {
        execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cofre-zip-original.js'), recovered], { env: { ...process.env, DATA_DIR, VAULT_CODE: 'cofre-do-juan' }, stdio: 'ignore' });
      } catch (e) { /* conferido abaixo */ }
      check('script recupera o zip original igualzinho', fs.existsSync(recovered) && fs.readFileSync(recovered).equals(outer));
      fs.rmSync(recovered, { force: true });
    } else {
      console.log('      (fora do macOS: pulando o cofre, que usa o sips)');
    }

    console.log('\n# entrada direta do Hermes');
    const guest = makeClient();
    r = await anon('POST', '/api/hermes', { text: 'oi' });
    check('Hermes sem sessão nenhuma = 401', r.res.status === 401);
    r = await guest('POST', '/api/login', { code: env.HERMES_CODE });
    check('código do Hermes na entrada abre só o Hermes', r.res.status === 200 && r.json.hermes === true && !r.json.notice);
    r = await guest('GET', '/api/me');
    check('…sem autenticar no chat', r.json.authenticated === false && r.json.hermes === true);
    for (const [method, route] of [['GET', '/api/messages'], ['GET', '/api/boot?name=x'], ['GET', '/api/stickers'],
      ['GET', '/api/starred?name=x'], ['GET', '/api/media-list'], ['GET', '/api/export'], ['GET', '/api/stream'],
      ['GET', '/api/gifs/search?q=a'], ['POST', '/api/typing'], ['POST', '/api/clear'], ['POST', '/api/messages'],
      ['POST', '/api/stickers/from-link'], ['POST', '/api/stickers/convert'], ['POST', '/api/stickers/import-whatsapp'],
      ['GET', '/api/whatsapp/status?name=x'], ['GET', '/api/vault/status?name=Juan'], ['POST', '/api/vault/unlock'], ['GET', '/api/vault/items?name=Juan'], ['POST', '/api/whatsapp/link'], ['POST', '/api/whatsapp/verify'], ['POST', '/api/whatsapp/unlink'],
      ['GET', '/api/stickers/giphy-search?q=a']]) {
      r = await guest(method, route, method === 'POST' ? { sender: 'x', text: 'x', name: 'x' } : undefined, { raw: true });
      check(`sessão do Hermes não abre ${method} ${route}`, r.res.status === 401, r.res.status);
    }
    r = await guest('POST', '/api/hermes', { text: 'oi hermes', history: [] });
    check('conversa com o Hermes responde', r.res.status === 200 && r.json.ok && r.json.reply.includes('oi hermes'), r.json);
    r = await juan('POST', '/api/hermes', { text: 'de dentro do chat' });
    check('caminho antigo (dentro do chat) continua valendo', r.res.status === 200 && r.json.ok);
    r = await guest('POST', '/api/logout');
    r = await guest('POST', '/api/hermes', { text: 'oi' });
    check('sair encerra a sessão do Hermes', r.res.status === 401);

    // Por último de propósito: isto bloqueia o IP de teste por 10 minutos.
    const brute = makeClient();
    for (let i = 0; i < 5; i++) await brute('POST', '/api/login', { code: `errado-${i}` });
    r = await brute('POST', '/api/login', { code: env.HERMES_CODE });
    check('código do Hermes ainda entra antes do bloqueio', r.json && r.json.hermes === true);
    r = await brute('POST', '/api/login', { code: 'errado-6' });
    r = await brute('POST', '/api/login', { code: CODE });
    check('entrar no Hermes não zera o contador de erros do chat', r.res.status === 429, r.res.status);
    r = await brute('POST', '/api/login', { code: env.HERMES_CODE });
    check('com o IP bloqueado, o código do Hermes também não entra', r.res.status === 429);

    check('servidor sem erro no stderr', serverErr.trim() === '', serverErr.slice(0, 400));
  } finally {
    server.kill();
    giphy.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (waDir) fs.rmSync(waDir, { recursive: true, force: true });
    fs.rmSync(teoPhone, { force: true });
    fs.rmSync(changelogFile, { force: true });
  }

  console.log(`\n${passed} ok, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
