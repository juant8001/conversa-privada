// Baileys de mentira pros testes (WHATSAPP_BAILEYS_MODULE): imita só o que
// lib/whatsapp-links.js usa. O "celular" lê o que vai mandar de
// WHATSAPP_FAKE_DATA (JSON): favoritas, mensagens com figurinha e quais
// mensagens ele aceita subir de novo.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

function data() {
  return JSON.parse(readFileSync(process.env.WHATSAPP_FAKE_DATA, 'utf8'));
}
const b = (s) => (s ? Buffer.from(s, 'base64') : undefined);
const closeWith = (statusCode) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });

export const DisconnectReason = { loggedOut: 401, restartRequired: 515 };
export const ALL_WA_PATCH_NAMES = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular', 'regular_low'];
export const Browsers = { macOS: (x) => ['Mac OS', x, '14.4.1'] };
export const proto = { Message: { AppStateSyncKeyData: { fromObject: (x) => x } } };
export const initAuthCreds = () => ({ registered: false, noiseKey: { public: Buffer.from('chave') } });
export const normalizeMessageContent = (m) => m;
export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
export const BufferJSON = {
  replacer: (k, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || (value && value.type === 'Buffer')) {
      return { type: 'Buffer', data: Buffer.from((value && value.data) || value).toString('base64') };
    }
    return value;
  },
  reviver: (_, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer') {
      return typeof value.data === 'string' ? Buffer.from(value.data, 'base64') : Buffer.from(value.data || []);
    }
    return value;
  },
};

export function makeWASocket(config) {
  const ev = new EventEmitter();
  const creds = config.auth.creds;
  const set = (upd) => {
    Object.assign(creds, upd);
    ev.emit('creds.update', upd);
  };
  let number = '';
  const sock = {
    ev,
    requestPairingCode: async (n) => {
      number = n;
      set({ me: { id: `${n}@s.whatsapp.net` } });
      // "a pessoa digita o código no celular" logo depois
      setTimeout(() => {
        set({ account: { details: 'ok' }, me: { id: `${n}:7@s.whatsapp.net`, name: 'Teo' } });
        ev.emit('connection.update', { isNewLogin: true, qr: undefined });
        setTimeout(() => ev.emit('connection.update', closeWith(515)), 30);
      }, data().pairDelayMs || 150);
      return 'ABCD1234';
    },
    resyncAppState: async () => {
      for (const f of data().favorites) {
        config.logger.debug({
          syncAction: {
            index: ['favoriteSticker', f.hash],
            syncAction: { value: { timestamp: f.ts, stickerAction: { mediaKey: b(f.mediaKey), directPath: f.directPath, fileEncSha256: b(f.encSha), mimetype: 'image/webp', url: '' } } },
          },
        }, 'unprocessable update');
      }
    },
    updateMediaMessage: async (msg) => {
      const np = (data().reupload || {})[msg.key.id];
      if (!np) {
        const e = new Error('Media re-upload failed by device (NOT_FOUND)');
        e.output = { statusCode: 404 };
        throw e;
      }
      return { ...msg, message: { stickerMessage: { ...msg.message.stickerMessage, directPath: np, url: '' } } };
    },
    logout: async () => {
      process.stdout.write('fake-baileys: logout\n');
      ev.emit('connection.update', closeWith(401));
    },
    end: () => setImmediate(() => ev.emit('connection.update', closeWith(428))),
  };
  setImmediate(() => {
    ev.emit('connection.update', { connection: 'connecting' });
    if (!creds.account) {
      ev.emit('connection.update', { qr: 'qr-de-mentira' });
      return;
    }
    ev.emit('connection.update', { connection: 'open' });
    if (!creds.accountSyncCounter) {
      const msgs = data().messages.map((m) => ({
        key: { remoteJid: m.remoteJid, id: m.id, fromMe: !!m.fromMe },
        messageTimestamp: m.ts,
        message: { stickerMessage: { fileSha256: b(m.hash), mediaKey: b(m.mediaKey), directPath: m.directPath, fileEncSha256: b(m.encSha), mimetype: 'image/webp', url: '' } },
      }));
      ev.emit('messaging-history.set', { messages: msgs, isLatest: true });
      set({ myAppStateKeyId: 'chave-1' });
      set({ accountSyncCounter: 1 });
    }
  });
  void number;
  return sock;
}
export default makeWASocket;
