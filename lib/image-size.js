'use strict';
// Tamanho de uma imagem lido direto dos bytes, JÁ COM A ROTAÇÃO DO EXIF
// aplicada - que é como o navegador mostra a foto. O `sips -g pixelWidth`
// devolve o tamanho cru gravado no arquivo: foto de iPhone tirada em pé vem
// 4032x3024 com "Orientation = 6" (girar 90°), e aí a bolha da conversa
// reservava uma caixa deitada pra uma foto em pé (proporção errada).
// Só lê cabeçalhos; nada é gravado em disco.

function exifOrientation(buf, start, end) {
  // start aponta pro começo do "Exif\0\0".
  if (buf.toString('latin1', start, start + 4) !== 'Exif') return 1;
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const order = buf.toString('latin1', tiff, tiff + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function jpegSize(buf) {
  let o = 2;
  let orientation = 1;
  let size = null;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1];
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // fim / começo dos dados
    const len = buf.readUInt16BE(o + 2);
    if (len < 2) break;
    const segEnd = Math.min(buf.length, o + 2 + len);
    if (marker === 0xe1 && orientation === 1) {
      try { orientation = exifOrientation(buf, o + 4, segEnd); } catch (e) { /* EXIF torto: ignora */ }
    }
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF && o + 9 <= buf.length) {
      size = { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      break; // o EXIF (APP1) sempre vem antes do SOF
    }
    o += 2 + len;
  }
  if (!size || !size.w || !size.h) return null;
  return orientation >= 5 ? { w: size.h, h: size.w } : size;
}

function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
    if (buf.toString('latin1', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.toString('latin1', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
    }
  } catch (e) { /* cabeçalho cortado */ }
  return null;
}

module.exports = { imageSize };
