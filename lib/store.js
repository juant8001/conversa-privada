'use strict';

const fs = require('fs');
const path = require('path');
const { deriveKey, encryptBuffer, decryptBuffer } = require('./crypto');

class WrongCodeError extends Error {
  constructor() {
    super('wrong_code');
    this.code = 'WRONG_CODE';
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.saltPath = path.join(dataDir, 'salt.bin');
    this.storePath = path.join(dataDir, 'store.enc');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  _getOrCreateSalt() {
    if (fs.existsSync(this.saltPath)) {
      return fs.readFileSync(this.saltPath);
    }
    const salt = require('crypto').randomBytes(16);
    fs.writeFileSync(this.saltPath, salt, { mode: 0o600 });
    return salt;
  }

  _atomicWrite(filePath, buf) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  /**
   * Attempts to unlock the store with the given access code.
   * First ever call (no store.enc on disk yet) bootstraps a new, empty
   * conversation encrypted under whatever code is provided — i.e. the
   * first person to open the link picks the access code.
   * Throws WrongCodeError if a store already exists and the code doesn't match.
   */
  async unlock(code) {
    const salt = this._getOrCreateSalt();
    const key = await deriveKey(code, salt);

    if (!fs.existsSync(this.storePath)) {
      const initial = { messages: [] };
      this._atomicWrite(this.storePath, encryptBuffer(key, Buffer.from(JSON.stringify(initial))));
      return { key, data: initial };
    }

    const blob = fs.readFileSync(this.storePath);
    let plaintext;
    try {
      plaintext = decryptBuffer(key, blob);
    } catch (e) {
      throw new WrongCodeError();
    }
    let data;
    try {
      data = JSON.parse(plaintext.toString('utf8'));
    } catch (e) {
      throw new Error('corrupt_store');
    }
    return { key, data };
  }

  persist(key, data) {
    this._atomicWrite(this.storePath, encryptBuffer(key, Buffer.from(JSON.stringify(data))));
  }

  saveMedia(key, mediaId, buffer) {
    const p = path.join(this.mediaDir, `${mediaId}.enc`);
    this._atomicWrite(p, encryptBuffer(key, buffer));
  }

  loadMedia(key, mediaId) {
    const p = path.join(this.mediaDir, `${mediaId}.enc`);
    const blob = fs.readFileSync(p);
    return decryptBuffer(key, blob);
  }

  mediaExists(mediaId) {
    return fs.existsSync(path.join(this.mediaDir, `${mediaId}.enc`));
  }

  deleteMediaFile(mediaId) {
    const p = path.join(this.mediaDir, `${mediaId}.enc`);
    try {
      fs.unlinkSync(p);
    } catch (e) {
      // already gone — fine
    }
  }

  /**
   * Wipes every message and permanently deletes every media file on disk,
   * then persists an empty, still-encrypted store under the same key.
   */
  clearAll(key) {
    const files = fs.readdirSync(this.mediaDir);
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.mediaDir, f));
      } catch (e) {
        // best-effort; continue clearing the rest
      }
    }
    const empty = { messages: [] };
    this.persist(key, empty);
    return empty;
  }
}

module.exports = { Store, WrongCodeError };
