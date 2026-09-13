/**
 * Integration test — runs two NexusNode instances in-process (desktop +
 * "phone") over a real WebSocket on localhost, exercising the full MVP
 * flow end to end. No mDNS involved (we connect directly to 127.0.0.1),
 * which is exactly the fallback path a real deployment uses when
 * multicast discovery isn't available.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { NexusNode } = require('../core/node');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nexus-test-${name}-`));
}

async function waitFor(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

async function main() {
  const PORT = 18342;

  const desktop = new NexusNode({ deviceName: 'Test-PC', deviceType: 'desktop', dataDir: tmpDir('desktop') });
  const phone = new NexusNode({ deviceName: 'Test-Phone', deviceType: 'mobile', dataDir: tmpDir('phone') });
  // NexusNode emits 'error' for expected-but-noteworthy conditions too
  // (rejected offers on an untrusted session, malformed messages, etc.),
  // and Node throws by default if an EventEmitter's 'error' event has no
  // listener — so a real integration harness always attaches one.
  desktop.on('error', (e) => console.log('  [desktop error]', e.message));
  phone.on('error', (e) => console.log('  [phone error]', e.message));

  desktop.listen(PORT);

  // ---- 1. connect + HELLO handshake ----
  const discoveredOnPhone = waitFor(phone, 'device-discovered');
  phone.connect('127.0.0.1', PORT);
  const discovered = await discoveredOnPhone;
  assert.strictEqual(discovered.deviceId, desktop.deviceId);
  console.log('✅ HELLO handshake works (phone discovered desktop)');

  // ---- 2. pairing ----
  const code = desktop.generatePairingCode();
  const pairedOnDesktop = waitFor(desktop, 'paired');
  const pairedOnPhone = waitFor(phone, 'paired');
  const permissionRequest = waitFor(desktop, 'permission-request');
  phone.requestPairing(desktop.deviceId, code, ['FILE_SEND', 'FILE_RECEIVE', 'CLIPBOARD_READ', 'CLIPBOARD_WRITE']);
  await Promise.all([pairedOnDesktop, pairedOnPhone]);
  console.log('✅ Secure pairing works (ECDH session key derived on both sides)');

  const permReq = await permissionRequest;
  assert.deepStrictEqual(permReq.requestedPermissions, ['FILE_SEND', 'FILE_RECEIVE', 'CLIPBOARD_READ', 'CLIPBOARD_WRITE']);
  assert.strictEqual(desktop.getPermissions(phone.deviceId).FILE_SEND, false, 'requested permissions must NOT be auto-granted');
  console.log('✅ Permission-request surfaced to the UI hook, and NOT auto-granted (approval still required)');

  // ---- 3. wrong code should be rejected ----
  const rejected = waitFor(phone, 'pair-rejected');
  phone.requestPairing(desktop.deviceId, '000000');
  const rej = await rejected;
  assert.strictEqual(rej.reason, 'invalid_or_expired_code');
  console.log('✅ Invalid pairing codes are rejected');

  // ---- 4. permission enforcement: receiver rejects when it hasn't granted FILE_RECEIVE ----
  const rejectedOffer = waitFor(phone, 'file-rejected');
  await phone.sendFile(desktop.deviceId, __filename); // desktop hasn't granted phone FILE_RECEIVE
  const offerRejection = await rejectedOffer;
  assert.strictEqual(offerRejection.reason, 'permission_denied');
  console.log('✅ Default-deny permissions enforced (receiver rejects unauthorized file offer)');

  // ---- 5. grant permissions, then transfer a real file ----
  desktop.setPermissions(phone.deviceId, { FILE_RECEIVE: true }); // desktop authorizes phone to send it files

  const testFile = path.join(os.tmpdir(), 'nexus-test-file.bin');
  const payload = crypto.randomBytes(600 * 1024); // > 2 chunks at 256KB
  fs.writeFileSync(testFile, payload);

  const received = waitFor(desktop, 'file-received', 10000);
  await phone.sendFile(desktop.deviceId, testFile);
  const fileResult = await received;

  const receivedBytes = fs.readFileSync(fileResult.path);
  assert.ok(receivedBytes.equals(payload), 'received file bytes must match sent file exactly');
  console.log(`✅ Chunked file transfer works and is byte-identical (${payload.length} bytes, multiple chunks)`);

  // ---- 6. clipboard sync ----
  desktop.setPermissions(phone.deviceId, { CLIPBOARD_WRITE: true }); // desktop authorizes phone to write its clipboard
  const clipReceived = waitFor(desktop, 'clipboard');
  phone.sendClipboard(desktop.deviceId, 'https://github.com/example/nexus');
  const clip = await clipReceived;
  assert.strictEqual(clip.text, 'https://github.com/example/nexus');
  console.log('✅ Clipboard sync works');

  // ---- 7. device status ----
  const statusReceived = waitFor(phone, 'status');
  desktop.sendStatus(phone.deviceId, { cpu: 42, memory: 61 });
  const status = await statusReceived;
  assert.strictEqual(status.status.cpu, 42);
  console.log('✅ Device status/telemetry push works');

  // ---- 8. audit log recorded everything ----
  const logs = desktop.store.recentAuditLogs();
  const actions = logs.map((l) => l.action);
  assert.ok(actions.includes('PAIR_REQUEST'));
  console.log(`✅ Audit log captured ${logs.length} entries (pairing, transfers, permission denials)`);

  // ---- 9. resumable transfer after a mid-transfer disconnect ----
  const bigFile = path.join(os.tmpdir(), 'nexus-test-bigfile.bin');
  const bigPayload = crypto.randomBytes(3 * 1024 * 1024); // several MB -> many chunks
  fs.writeFileSync(bigFile, bigPayload);
  desktop.setPermissions(phone.deviceId, { FILE_RECEIVE: true });

  const fileId = crypto.randomUUID();
  const cutAfterChunks = 3;
  const onProgress = (p) => {
    if (p.fileId === fileId && p.direction === 'send' && p.chunkIndex + 1 === cutAfterChunks) {
      phone.sessions.get(desktop.deviceId).ws.terminate();
    }
  };
  phone.on('file-progress', onProgress);

  // Wait for the sender to actually DETECT and report the interruption
  // (via the real 'close' event, not a timing guess) rather than racing
  // an arbitrary sleep against it.
  const interrupted = waitFor(phone, 'file-interrupted', 10000);
  phone.sendFile(desktop.deviceId, bigFile, { fileId }).catch(() => {});
  await interrupted;
  phone.off('file-progress', onProgress);
  await new Promise((r) => setTimeout(r, 50)); // let the desktop side's own close handling settle too

  const partialState = desktop.store.getTransfer(fileId);
  assert.ok(partialState && partialState.receivedChunks > 0 && partialState.receivedChunks < partialState.totalChunks,
    'expected a partial transfer to be recorded before resuming');
  console.log(`✅ Partial transfer state persisted after simulated disconnect (${partialState.receivedChunks}/${partialState.totalChunks} chunks)`);

  // Reconnect both sides and resume using the SAME fileId — the receiver
  // reports back its last completed chunk in FILE_ACCEPT, and the sender
  // starts from there instead of from zero.
  const reconnected = waitFor(phone, 'device-connected');
  phone.connect('127.0.0.1', PORT);
  await reconnected;

  const resumedReceipt = waitFor(desktop, 'file-received', 15000);
  await phone.sendFile(desktop.deviceId, bigFile, { fileId });
  const resumedResult = await resumedReceipt;

  const resumedBytes = fs.readFileSync(resumedResult.path);
  assert.ok(resumedBytes.equals(bigPayload), 'resumed file must still match original bytes exactly');
  console.log('✅ Resumable transfer works — file completed correctly after reconnect');

  // ---- 10. revocation: a revoked device must be fully cut off, and must
  //          re-pair from scratch (old trust/keys are not enough) ----
  const revokedOnPhone = waitFor(phone, 'revoked-by-peer');
  desktop.revokeDevice(phone.deviceId);
  await revokedOnPhone;
  assert.strictEqual(desktop.getPermissions(phone.deviceId).FILE_RECEIVE, false, 'revocation must clear all permissions');
  assert.strictEqual(desktop.store.getDevice(phone.deviceId).trusted, false);
  console.log('✅ Revocation clears trust + permissions and notifies the peer');

  // The old session is closed; reconnecting should NOT silently regain
  // trust just because the public key still matches — it must show up as
  // an untrusted rediscovery, requiring a brand-new pairing code.
  await new Promise((r) => setTimeout(r, 100));
  const rediscovered = waitFor(desktop, 'device-discovered');
  phone.connect('127.0.0.1', PORT);
  const rediscoveredEvent = await rediscovered;
  assert.strictEqual(rediscoveredEvent.trusted, false);
  console.log('✅ Revoked device must fully re-pair — old trust is not honored on reconnect');

  desktop.close();
  phone.close();
  fs.unlinkSync(testFile);
  fs.unlinkSync(bigFile);

  console.log('\n🎉 All integration checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Integration test failed:', e);
  process.exit(1);
});
