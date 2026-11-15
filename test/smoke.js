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
    input: `create table ZWAMESSAGE (Z_PK integer primary key, ZMESSAGETYPE integer, ZISFROMME integer, ZMESSAGEDATE timestamp);
create table ZWAMEDIAITEM (Z_PK integer primary key, ZMESSAGE integer, ZVCARDNAME varchar, ZMEDIALOCALPATH varchar, ZMEDIAURL varchar, ZMEDIAKEY blob, ZMEDIAURLDATE timestamp);
insert into ZWAMESSAGE values (1, 15, 0, 100);
insert into ZWAMEDIAITEM values (1, 1, '${b64sha(WEBP_RED)}', 'Media/x/apagado.webp', '${mediaOrigin}/wa/morto', X'${crypto.randomBytes(32).toString('hex')}', 10);
insert into ZWAMESSAGE values (2, 0, 0, 110);
insert into ZWAMESSAGE values (4, 15, 1, 250);
insert into ZWAMEDIAITEM values (4, 4, '${b64sha(WEBP_CRIADA)}', null, '${mediaOrigin}/wa/msg/criada', X'${mediaKeyBlob(WA_KEY_CRIADA, WA_ENC_CRIADA)}', 250);
insert into ZWAMESSAGE values (5, 15, 0, 200);
insert into ZWAMEDIAITEM values (5, 5, '${b64sha(WA_RECEBIDA)}', null, '${mediaOrigin}/wa/msg/recebida', X'${mediaKeyBlob(WA_KEY_RECEBIDA, WA_ENC_RECEBIDA)}', 200);
insert into ZWAMESSAGE values (6, 15, 1, 260);
insert into ZWAMEDIAITEM values (6, 6, '${b64sha(Buffer.from('antiga'))}', null, 'https://a.whatsapp.net', X'${mediaKeyBlob(crypto.randomBytes(32), Buffer.from('x'))}', 260);
insert into ZWAMESSAGE values (7, 15, 0, 190);
insert into ZWAMEDIAITEM values (7, 7, '${b64sha(Buffer.from('expirada'))}', null, '${mediaOrigin}/wa/msg/expirada', X'${mediaKeyBlob(crypto.randomBytes(32), Buffer.from('x'))}', 190);
insert into ZWAMESSAGE values (8, 15, 0, 180);
insert into ZWAMEDIAITEM values (8, 8, '${b64sha(WA_LOTTIE)}', null, '${mediaOrigin}/wa/msg/lottie', X'${mediaKeyBlob(WA_KEY_LOTTIE, WA_ENC_LOTTIE)}', 180);`,
  });
  return dir;
}

// Simula o Juan mandando a figurinha "perdida" do celular pra uma conversa.
function waReceiveFromPhone(dir, mediaOrigin) {
  execFileSync('sqlite3', [path.join(dir, 'ChatStorage.sqlite')], {
    input: `insert into ZWAMESSAGE values (3, 15, 1, 300);
insert into ZWAMEDIAITEM values (2, 3, '${b64sha(WA_SUMIU)}', null, '${mediaOrigin}/wa/msg/sumiu', X'${mediaKeyBlob(WA_KEY_MSG, WA_ENC_MSG)}', 20);`,
  });
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
    ...(waDir ? { WHATSAPP_IMPORT: '1', WHATSAPP_CONTAINER: waDir } : {}),
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
      r = await juan('GET', '/api/stickers/whatsapp-favorites');
      check('favoritas: 2 com arquivo (local e baixada), 1 perdida', r.res.status === 200 && r.json.groups.fav.total === 3
        && r.json.groups.fav.missing === 1 && favItems(r.json).length === 2 && r.json.items[0].key === redKey && r.json.items[1].key === blueKey, r.json);
      check('as que ele mandou (criadas) vêm das conversas, com a chave no formato do ChatStorage', r.json.groups.mine.total === 2
        && r.json.groups.mine.missing === 1 && r.json.items[2].key === criadaKey && r.json.items[2].group === 'mine', r.json);
      check('as recebidas vêm por último; link expirado e Lottie ficam de fora', r.json.groups.chat.total === 3
        && r.json.groups.chat.missing === 2 && r.json.items.length === 4 && r.json.items[3].key === recebidaKey && r.json.items[3].group === 'chat', r.json);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${criadaKey}`, undefined, { raw: true });
      check('prévia da criada (baixada da conversa) chega igual', r.res.status === 200 && r.buf.equals(WEBP_CRIADA));
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [criadaKey] });
      check('importa figurinha que só passou por conversa', r.res.status === 200 && r.json.added === 1, r.json);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${blueKey}`, undefined, { raw: true });
      check('prévia da favorita (baixada e decifrada) chega igual', r.res.status === 200 && r.buf.equals(WEBP_BLUE)
        && r.res.headers.get('content-type') === 'image/webp' && (r.res.headers.get('content-security-policy') || '').includes('sandbox'));
      r = await juan('GET', '/api/stickers/whatsapp-favorites/nao-e-hash', undefined, { raw: true });
      check('prévia com chave inválida = 404', r.res.status === 404);
      r = await anon('GET', `/api/stickers/whatsapp-favorites/${redKey}`, undefined, { raw: true });
      check('prévia exige sessão', r.res.status === 401);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: 'tudo' });
      check('importar sem lista de escolhidas = 400', r.res.status === 400);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [blueKey, 'f'.repeat(64)] });
      check('importa só a escolhida', r.res.status === 200 && r.json.added === 1 && r.json.missing === 1, r.json);
      r = await juan('GET', '/api/stickers/whatsapp-favorites');
      check('lista marca a que já entrou', r.json.items.find((it) => it.key === blueKey).inLibrary === true
        && r.json.items.find((it) => it.key === redKey).inLibrary === false, r.json);
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [blueKey] });
      check('importar de novo a mesma conta como repetida', r.res.status === 200 && r.json.added === 0 && r.json.duplicates === 1, r.json);
      r = await juan('GET', '/api/stickers');
      check('só a escolhida entrou; botão continua', r.json.waImport === true
        && r.json.stickers.filter((st) => st.width === 2).length === 2, r.json.waImport);
      r = await teo('GET', '/api/boot?name=Teo');
      check('…pros dois', r.json.waImport === true);
      r = await juan('GET', `/api/stickers/whatsapp-favorites/${redKey}`, undefined, { raw: true });
      check('prévia da que falta continua aberta', r.res.status === 200 && r.buf.equals(WEBP_RED));
      r = await juan('POST', '/api/stickers/import-whatsapp', { sender: 'Juan', keys: [redKey] });
      check('dá pra voltar e importar outra depois', r.res.status === 200 && r.json.added === 1, r.json);
      r = await juan('GET', '/api/stickers/whatsapp-favorites');
      check('…e as duas aparecem como já na coleção', favItems(r.json).every((it) => it.inLibrary === true) && r.json.groups.fav.missing === 1, r.json);
      waReceiveFromPhone(waDir, fakeOrigin);
      r = await juan('GET', '/api/stickers/whatsapp-favorites');
      const sumiuKey = crypto.createHash('sha256').update(WA_SUMIU).digest('hex');
      check('a perdida aparece depois de chegar numa conversa (link da mensagem)', r.json.groups.fav.missing === 0
        && favItems(r.json).length === 3 && r.json.items[2].key === sumiuKey && r.json.items[2].inLibrary === false, r.json);
      check('…e continua no grupo das favoritas, não repete nas mandadas', r.json.items.filter((it) => it.key === sumiuKey).length === 1
        && r.json.groups.mine.total === 2, r.json.groups);
      r = await anon('POST', '/api/stickers/import-whatsapp', { sender: 'x', keys: [] });
      check('importar exige sessão', r.res.status === 401);
      await juan('POST', '/api/clear');
      r = await juan('GET', '/api/boot?name=Juan');
      check('limpar a conversa mantém a coleção e o botão', r.json.waImport === true && r.json.stickers.length > 0);
    } else {
      console.log('      (sem sqlite3: pulando as favoritas do WhatsApp)');
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
  }

  console.log(`\n${passed} ok, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
