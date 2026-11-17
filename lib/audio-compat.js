'use strict';
// Áudio que toca em qualquer aparelho. Os áudios do WhatsApp (.opus = Ogg
// Opus, os do cofre) e os gravados no Chrome (audio/webm) não tocam no
// Safari do iPhone: o player aparece, mas fica sem som / com erro. AAC num
// .m4a (audio/mp4) toca em todo navegador, então é isso que vai pra
// conversa. O original entra pelo stdin do ffmpeg; só o resultado passa
// por uma pasta temporária privada (0700), apagada logo depois.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SAFE = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave']);

function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function needsConversion(mime) {
  const m = baseMime(mime);
  return m.startsWith('audio/') && !SAFE.has(m);
}

function m4aName(name) {
  const base = String(name || 'audio').replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${base || 'audio'}.m4a`;
}

function toM4a(buf, { ffmpeg, tmpDir }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return reject(new Error('sem ffmpeg'));
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const work = fs.mkdtempSync(path.join(tmpDir, 'a-'));
    const out = path.join(work, 'out.m4a');
    const done = (err, res) => {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* nada */ }
      if (err) reject(err); else resolve(res);
    };
    const child = execFile(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'pipe:0',
      '-vn', '-map_metadata', '-1',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      out,
    ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        err.message = `ffmpeg: ${String(stderr || err.message).slice(0, 300)}`;
        return done(err);
      }
      try {
        const res = fs.readFileSync(out);
        if (!res.length) return done(new Error('ffmpeg: saída vazia'));
        done(null, res);
      } catch (e) {
        done(e);
      }
    });
    child.stdin.on('error', () => { /* ffmpeg fechou antes: o callback acima trata */ });
    child.stdin.end(buf);
  });
}

module.exports = { needsConversion, toM4a, m4aName, baseMime };
