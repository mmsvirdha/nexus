/**
 * NEXUS Crypto
 * ------------
 * Uses only Node's built-in `crypto` module — no hand-rolled ciphers.
 *
 * - Device identity: X25519 keypair (used for both signing-free auth via
 *   ECDH-derived session keys, kept simple on purpose for the MVP).
 * - Session encryption: ECDH shared secret -> HKDF -> AES-256-GCM.
 */

const crypto = require('crypto');

/** Generate a long-term device identity keypair (X25519). */
function generateDeviceKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function loadPublicKey(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}
function loadPrivateKey(b64) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
}

/**
 * Derive a symmetric session key from our private key + their public key.
 * Both sides compute the same 32-byte key without ever transmitting it.
 */
function deriveSessionKey(myPrivateKeyB64, theirPublicKeyB64, contextInfo = 'nexus-session') {
  const priv = loadPrivateKey(myPrivateKeyB64);
  const pub = loadPublicKey(theirPublicKeyB64);
  const sharedSecret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  // HKDF-SHA256 to turn the raw ECDH output into a uniform AES-256 key.
  const key = crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from(contextInfo), 32);
  return Buffer.from(key);
}

/** Encrypt payload (Buffer or string) with AES-256-GCM under sessionKey. */
function encrypt(sessionKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt the structure produced by encrypt(). Returns a Buffer. */
function decrypt(sessionKey, { iv, authTag, ciphertext }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
}

/** Generate a short human-verifiable pairing code (for QR / manual entry). */
function generatePairingCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Stable device ID derived from the public key, so it doesn't need separate storage logic. */
function deriveDeviceId(publicKeyB64) {
  return 'nexus-' + crypto.createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  generateDeviceKeyPair,
  deriveSessionKey,
  encrypt,
  decrypt,
  generatePairingCode,
  deriveDeviceId,
  sha256Hex,
};
