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

// Servidor falso do GIPHY: responde a busca e serve a "mídia" dos resultados.
function startFakeGiphy() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${srv.address().port}`;
      if (req.url.startsWith('/v1/gifs/')) {
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
  const env = {
    ...process.env,
    PORT: String(PORT),
    ROOM_SLUG: SLUG,
    DATA_DIR,
    COOKIE_INSECURE: '1',
    EPHEMERAL_TTL_MS: '300',
    ALT_CODE: 'codigo-alternativo',
    HERMES_TRIGGER: 'abre-te-sesamo',
    GIPHY_API_KEY: 'chave-de-teste',
    GIPHY_API_BASE: `http://127.0.0.1:${giphy.address().port}`,
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

    check('servidor sem erro no stderr', serverErr.trim() === '', serverErr.slice(0, 400));
  } finally {
    server.kill();
    giphy.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} ok, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
