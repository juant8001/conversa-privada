'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;

/**
 * Derives a 256-bit key from the access code and a (public) salt.
 * The access code itself is never stored anywhere.
 */
async function deriveKey(code, salt) {
  return scryptAsync(String(code), salt, KEY_LEN, SCRYPT_OPTS);
}

/**
 * AES-256-GCM encrypt. Output layout: [iv(12)][authTag(16)][ciphertext...]
 */
function encryptBuffer(key, plaintextBuf) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Reverses encryptBuffer. Throws if the key is wrong or the data was tampered with
 * (GCM authentication failure) — this is also how we verify the access code is correct.
 */
function decryptBuffer(key, blob) {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('corrupt_blob');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { deriveKey, encryptBuffer, decryptBuffer, randomId, KEY_LEN };
