/**
 * NEXUS Crypto — React Native port.
 *
 * Byte-for-byte compatible with packages/crypto/index.js. That module
 * uses Node's `crypto` (X25519, SPKI/PKCS8 DER, HKDF-SHA256, AES-256-GCM);
 * Expo Go has none of those, so we reproduce them on @noble/*. The test
 * apps/mobile/__tests__/rn-crypto.test.js asserts equality against the
 * real Node module on identical inputs; if this file and the Node module
 * ever drift, that test fails before anything else runs.
 *
 * Key formats match packages/crypto/index.js exactly:
 *   - public key: SPKI DER, base64
 *   - private key: PKCS8 DER, base64
 *   - session key: 32 raw bytes, HKDF-SHA256(shared, salt=empty, info='nexus-session')
 *   - AES-GCM: 12-byte random IV, 16-byte tag, {iv, authTag, ciphertext} all base64
 *   - deviceId: 'nexus-' + sha256(publicKeyB64).hex.slice(0,16)
 */

// MUST be the first import: it installs global.crypto.getRandomValues,
// which @noble/* requires for key generation. Importing @noble/* before
// this would throw "crypto.getRandomValues must be defined" on first run.
import 'react-native-get-random-values';

import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

// ---- base64 helpers (RN's global atob/btoa are unreliable across versions) ----
// ---- base64 helpers ----
// We do not use RN's global atob/btoa because they are inconsistent across
// RN versions, and Node's Buffer is not available. These are standard
// base64 with '=' padding, matching Node's Buffer.toString('base64') and
// Buffer.from(str, 'base64') byte-for-byte. The previous versions of these
// functions stripped '=' from the input before decoding, which corrupted
// the last 1-2 bytes of every 32-byte key.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64ToBytes(str) {
  const clean = str.replace(/\s+/g, '');
  const len = clean.length;
  if (len % 4 !== 0) throw new Error('Invalid base64 length');
  // Number of output bytes: for each full 4-char group, 3 bytes; padding
  // '=' at the end removes 1 or 2 bytes.
  let outLen = (len / 4) * 3;
  if (clean[len - 1] === '=') outLen--;
  if (clean[len - 2] === '=') outLen--;
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_ALPHABET.indexOf(clean[i]);
    const c1 = B64_ALPHABET.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0 || (clean[i + 2] !== '=' && c2 < 0) || (clean[i + 3] !== '=' && c3 < 0)) {
      throw new Error('Invalid base64 character');
    }
    if (p < outLen) out[p++] = (c0 << 2) | (c1 >> 4);
    if (p < outLen) out[p++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (p < outLen) out[p++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}

// ---- fixed-shape X25519 SPKI / PKCS8 DER wrappers ----
// X25519 SPKI is always: 302a300506032b656e032100 || 32-byte public key
// X25519 PKCS8 is always: 302e020100300506032b656e04220420 || 32-byte private key
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function publicKeyToSpkiB64(raw32) {
  const der = new Uint8Array(SPKI_PREFIX.length + 32);
  der.set(SPKI_PREFIX, 0);
  der.set(raw32, SPKI_PREFIX.length);
  return bytesToBase64(der);
}
function spkiB64ToPublicKey(b64) {
  const der = base64ToBytes(b64);
  if (der.length !== SPKI_PREFIX.length + 32) {
    throw new Error('Unexpected SPKI length for X25519 public key');
  }
  for (let i = 0; i < SPKI_PREFIX.length; i++) {
    if (der[i] !== SPKI_PREFIX[i]) throw new Error('Unexpected SPKI prefix for X25519 public key');
  }
  return der.slice(SPKI_PREFIX.length);
}
function privateKeyToPkcs8B64(raw32) {
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX, 0);
  der.set(raw32, PKCS8_PREFIX.length);
  return bytesToBase64(der);
}
function pkcs8B64ToPrivateKey(b64) {
  const der = base64ToBytes(b64);
  if (der.length !== PKCS8_PREFIX.length + 32) {
    throw new Error('Unexpected PKCS8 length for X25519 private key');
  }
  for (let i = 0; i < PKCS8_PREFIX.length; i++) {
    if (der[i] !== PKCS8_PREFIX[i]) throw new Error('Unexpected PKCS8 prefix for X25519 private key');
  }
  return der.slice(PKCS8_PREFIX.length);
}

// ---- public API, identical to packages/crypto/index.js ----

export function generateDeviceKeyPair() {
  const priv = x25519.utils.randomPrivateKey();

  // RFC 7748 §5 clamping. @noble/curves' randomPrivateKey() returns an
  // UNCLAMPED 32-byte scalar, and its own getSharedSecret/getPublicKey
  // clamp internally — but Node's crypto.diffieHellman, which is what
  // the desktop side uses, does NOT clamp: it expects the PKCS8 bytes
  // to already be a valid X25519 scalar. Without this explicit clamp,
  // the two sides derive different shared secrets from the same
  // keypair (which is exactly the bug that broke AES-GCM tags).
  const clamped = new Uint8Array(priv);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  const pub = x25519.getPublicKey(clamped);
  return {
    publicKey: publicKeyToSpkiB64(pub),
    privateKey: privateKeyToPkcs8B64(clamped),
  };
}

export function deriveSessionKey(myPrivateKeyB64, theirPublicKeyB64, contextInfo = 'nexus-session') {
  const priv = pkcs8B64ToPrivateKey(myPrivateKeyB64);
  const pub = spkiB64ToPublicKey(theirPublicKeyB64);


  const shared = x25519.getSharedSecret(priv, pub);

  const info = new TextEncoder().encode(contextInfo);
  const key = hkdf(sha256, shared, new Uint8Array(0), info, 32);
  return new Uint8Array(key);
}

export function encrypt(sessionKey, plaintext) {
  const iv = randomBytes(12);
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const aes = gcm(sessionKey, iv);
  const ct = aes.encrypt(pt);
  // @noble/ciphers appends the 16-byte tag to the ciphertext; split it out
  // so the return shape matches Node's createCipheriv output.
  const ciphertext = ct.slice(0, ct.length - 16);
  const authTag = ct.slice(ct.length - 16);
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export function decrypt(sessionKey, { iv, authTag, ciphertext }) {
  const ivB = base64ToBytes(iv);
  const tagB = base64ToBytes(authTag);
  const ctB = base64ToBytes(ciphertext);
  const combined = new Uint8Array(ctB.length + tagB.length);
  combined.set(ctB, 0);
  combined.set(tagB, ctB.length);
  const aes = gcm(sessionKey, ivB);
  // Returns Uint8Array; caller decides whether to .toString() it.
  return aes.decrypt(combined);
}

export function generatePairingCode() {
  // Mirrors crypto.randomInt(0, 1_000_000).toString().padStart(6,'0').
  // React Native has no crypto.randomInt, and the code is verified by the
  // DESKTOP, not by the phone — this path only exists so the phone can
  // generate a code if it ever needs to (it doesn't in this flow).
  const buf = randomBytes(4);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

export function deriveDeviceId(publicKeyB64) {
  const h = sha256(new TextEncoder().encode(publicKeyB64));
  const hex = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return 'nexus-' + hex.slice(0, 16);
}

export function sha256Hex(buffer) {
  const h = sha256(buffer);
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Node-ism re-export: existing Node callers expect a Buffer from decrypt().
// RN code will call a small helper `bufferToUtf8` instead.
export function bufferToUtf8(u8) {
  return new TextDecoder('utf-8').decode(u8);
}