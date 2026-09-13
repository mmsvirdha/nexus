/**
 * Interop proof: this runs the REAL NexusClient against a REAL NexusNode
 * desktop (core/node.js), over real WebSockets. If this passes, the phone
 * client speaks the same protocol as the desktop.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// `ws` is a direct devDependency of apps/mobile, so this require must be
// resolved from here (not from core/node.js, which lives at the monorepo
// root and has no node_modules of its own). jest.config.js has
// modulePaths: ['<rootDir>/node_modules'] which makes that work.
const { WebSocket } = require('ws');

const { NexusNode } = require('../../../core/node');
const { NexusClient } = require('../src/NexusClient');
const rnCrypto = require('../src/rn-crypto');

global.WebSocket = WebSocket;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nexus-mobile-test-${name}-`));
}
function waitFor(emitter, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
    emitter.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

describe('NexusClient ↔ NexusNode interop', () => {
  const PORT = 19342;

  test('pairs, respects default-deny, and revokes', async () => {
    const desktop = new NexusNode({ deviceName: 'Test-PC', deviceType: 'desktop', dataDir: tmpDir('desktop') });
    desktop.on('error', (e) => console.log('[desktop error]', e.message));
    desktop.listen(PORT);

    const kp = rnCrypto.generateDeviceKeyPair();
    const identity = { deviceId: rnCrypto.deriveDeviceId(kp.publicKey), ...kp };

    const phone = new NexusClient({ identity, deviceName: 'Test-Phone' });
    phone.on('error', (e) => console.log('[phone error]', e.message));

    const code = desktop.generatePairingCode();

    const discovered = waitFor(phone, 'device-discovered');
    phone.connect('127.0.0.1', PORT);
    await discovered;

    const pairedDesktop = waitFor(desktop, 'paired');
    const pairedPhone = waitFor(phone, 'paired');
    phone.requestPairing(desktop.deviceId, code, ['FILE_SEND', 'REMOTE_CONTROL']);
    await pairedDesktop;
    await pairedPhone;

    assert.strictEqual(desktop.getPermissions(identity.deviceId).REMOTE_CONTROL, false);

    desktop.setPermissions(identity.deviceId, { REMOTE_CONTROL: true });
    const result = await phone.sendCommand(desktop.deviceId, 'VOLUME_UP');
    assert.ok(!/permission denied/i.test(result.message || ''));

    const kp2 = rnCrypto.generateDeviceKeyPair();
    const identity2 = { deviceId: rnCrypto.deriveDeviceId(kp2.publicKey), ...kp2 };
    const phone2 = new NexusClient({ identity: identity2, deviceName: 'Test-Phone-2' });
    phone2.on('error', () => {});
    const disc2 = waitFor(phone2, 'device-discovered');
    phone2.connect('127.0.0.1', PORT);
    await disc2;
    const rejected = waitFor(phone2, 'pair-rejected');
    phone2.requestPairing(desktop.deviceId, '000000');
    const r = await rejected;
    assert.strictEqual(r.reason, 'invalid_or_expired_code');
    phone2.close();

    const revoked = waitFor(phone, 'revoked-by-peer');
    desktop.revokeDevice(identity.deviceId);
    await revoked;

    phone.close();
    desktop.close();
  }, 20000);
});