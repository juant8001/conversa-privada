#!/usr/bin/env python3
# Cofre (v52): lê um .zip - e os .zip dentro dele, como o export de conversa
# do WhatsApp - e manda cada arquivo de MÍDIA pro servidor pela saída padrão,
# sem gravar nada no disco. Quem cifra e guarda é o servidor (lib/vault.js).
#
# Uso: python3 -I vault-extract.py <arquivo.zip> [lista-de-ja-feitos.txt]
# Saída: quadros [4 bytes big-endian: tamanho do cabeçalho][cabeçalho JSON]
# [bytes]. Cabeçalhos: {"expect": n} (quantas mídias vêm deste zip),
# {"path", "size", "mtime"} (seguido dos bytes) e {"end": true}.
#
# Os membros são lidos na ordem em que estão gravados no zip: assim o zip de
# dentro (comprimido) é percorrido só pra frente, sem reler do começo.
import json
import os
import struct
import sys
import time
import zipfile

MEDIA = {
    '.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp',
    '.mov', '.mp4', '.m4v', '.3gp',
    '.opus', '.ogg', '.m4a', '.mp3', '.aac', '.wav',
}
MAX_BYTES = 1500 * 1024 * 1024

out = sys.stdout.buffer
skip = set()
if len(sys.argv) > 2 and os.path.exists(sys.argv[2]):
    with open(sys.argv[2], encoding='utf-8') as f:
        skip = {line.rstrip('\n') for line in f if line.strip()}


def frame(header, data=b''):
    h = json.dumps(header, ensure_ascii=False).encode('utf-8')
    out.write(struct.pack('>I', len(h)))
    out.write(h)
    if data:
        out.write(data)
    out.flush()


def mtime_of(info):
    try:
        return time.mktime(info.date_time + (0, 0, -1))
    except Exception:
        return 0


def hidden(name):
    base = os.path.basename(name)
    return name.startswith('__MACOSX/') or '/__MACOSX/' in name or base.startswith('._') or base.startswith('.')


def walk(zf, prefix, depth):
    infos = sorted((i for i in zf.infolist() if not i.is_dir() and not hidden(i.filename)), key=lambda i: i.header_offset)
    medias = [i for i in infos if os.path.splitext(i.filename)[1].lower() in MEDIA and i.file_size <= MAX_BYTES]
    frame({'expect': len(medias)})
    for i in infos:
        full = prefix + i.filename
        ext = os.path.splitext(i.filename)[1].lower()
        if ext == '.zip' and depth < 2:
            with zf.open(i) as f:
                walk(zipfile.ZipFile(f), full + '!/', depth + 1)
            continue
        if ext not in MEDIA or i.file_size > MAX_BYTES:
            continue
        if full in skip:
            frame({'skip': full})
            continue
        frame({'path': full, 'size': i.file_size, 'mtime': mtime_of(i)}, zf.read(i))


walk(zipfile.ZipFile(sys.argv[1]), '', 0)
frame({'end': True})
