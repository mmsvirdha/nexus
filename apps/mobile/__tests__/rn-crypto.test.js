/**
 * Proves that the React Native port of NEXUS crypto produces the SAME
 * bytes as the Node implementation used by core/node.js, on the same
 * inputs. Runs under jest in Node (@noble works there), using the real
 * packages/crypto/index.js as the reference.
 */

const assert = require('assert');
const nodeCrypto = require('../../../packages/crypto');
const rnCrypto = require('../src/rn-crypto');

describe('rn-crypto', () => {
  test('generateDeviceKeyPair output round-trips through the Node module', () => {
    const kp = rnCrypto.generateDeviceKeyPair();
    assert.ok(kp.publicKey && kp.privateKey);
    const nodeKp = nodeCrypto.generateDeviceKeyPair();
    const mySession = rnCrypto.deriveSessionKey(kp.privateKey, nodeKp.publicKey);
    const theirSession = nodeCrypto.deriveSessionKey(nodeKp.privateKey, kp.publicKey);
    assert.deepStrictEqual(Array.from(mySession), Array.from(theirSession));
  });

  test('AES-GCM ciphertext from rn-crypto is decryptable by Node', () => {
    const a = rnCrypto.generateDeviceKeyPair();
    const b = nodeCrypto.generateDeviceKeyPair();
    const key = rnCrypto.deriveSessionKey(a.privateKey, b.publicKey);
    const ct = rnCrypto.encrypt(key, 'hello nexus');
    const pt = nodeCrypto.decrypt(Buffer.from(key), ct).toString('utf8');
    assert.strictEqual(pt, 'hello nexus');
  });

  test('AES-GCM ciphertext from Node is decryptable by rn-crypto', () => {
    const a = nodeCrypto.generateDeviceKeyPair();
    const b = rnCrypto.generateDeviceKeyPair();
    const nodeKey = nodeCrypto.deriveSessionKey(a.privateKey, b.publicKey);
    const ct = nodeCrypto.encrypt(nodeKey, 'the reverse direction');
    const rnKey = rnCrypto.deriveSessionKey(b.privateKey, a.publicKey);
    const pt = Buffer.from(rnCrypto.decrypt(rnKey, ct)).toString('utf8');
    assert.strictEqual(pt, 'the reverse direction');
  });

  test('deriveDeviceId matches Node', () => {
    const kp = rnCrypto.generateDeviceKeyPair();
    assert.strictEqual(rnCrypto.deriveDeviceId(kp.publicKey), nodeCrypto.deriveDeviceId(kp.publicKey));
  });
});