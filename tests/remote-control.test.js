/**
 * Integration test for the remote-control command flow (Phase 8) and
 * notification forwarding (Phase 7), run over a real WebSocket like
 * tests/integration.test.js — but with a MOCK command executor injected
 * so the test can assert on exactly which commands were "run" without
 * actually locking, sleeping, or changing the volume of the machine
 * running the test suite.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  const PORT = 18343;

  // The mock executor records every call instead of touching the real OS.
  const executedCommands = [];
  const mockExecutor = async (command, args) => {
    executedCommands.push({ command, args });
    return { ok: true, message: `mock-executed ${command}` };
  };

  const desktop = new NexusNode({ deviceName: 'Test-PC', deviceType: 'desktop', dataDir: tmpDir('desktop-rc'), commandExecutor: mockExecutor });
  const phone = new NexusNode({ deviceName: 'Test-Phone', deviceType: 'mobile', dataDir: tmpDir('phone-rc') });
  desktop.on('error', (e) => console.log('  [desktop error]', e.message));
  phone.on('error', (e) => console.log('  [phone error]', e.message));

  desktop.listen(PORT);
  const discovered = waitFor(phone, 'device-discovered');
  phone.connect('127.0.0.1', PORT);
  await discovered;

  const code = desktop.generatePairingCode();
  const paired = Promise.all([waitFor(desktop, 'paired'), waitFor(phone, 'paired')]);
  phone.requestPairing(desktop.deviceId, code, ['REMOTE_CONTROL']);
  await paired;

  // ---- 1. no permission yet -> command is rejected ----
  const resultDenied = await phone.sendCommand(desktop.deviceId, 'VOLUME_UP');
  assert.strictEqual(resultDenied.ok, false);
  assert.strictEqual(executedCommands.length, 0, 'a denied command must never reach the executor');
  console.log('✅ Remote control blocked before REMOTE_CONTROL permission is granted');

  desktop.setPermissions(phone.deviceId, { REMOTE_CONTROL: true });

  // ---- 2. an unknown/unlisted command is rejected even with permission ----
  const resultUnknown = await phone.sendCommand(desktop.deviceId, 'REBOOT_PC').catch((e) => ({ ok: false, message: e.message }));
  assert.strictEqual(resultUnknown.ok, false);
  console.log('✅ Commands outside the fixed allow-list are rejected even with REMOTE_CONTROL granted');

  // ---- 3. a non-destructive command (VOLUME_UP) executes immediately, no confirmation ----
  const noConfirmNeeded = waitFor(desktop, 'command-confirmation-required', 500).then(
    () => { throw new Error('VOLUME_UP should not require confirmation'); },
    () => 'no-confirmation-event-fired-as-expected'
  );
  const resultVolume = await phone.sendCommand(desktop.deviceId, 'VOLUME_UP');
  await noConfirmNeeded;
  assert.strictEqual(resultVolume.ok, true);
  assert.deepStrictEqual(executedCommands[0], { command: 'VOLUME_UP', args: {} });
  console.log('✅ Non-destructive command (VOLUME_UP) executes immediately without confirmation');

  // ---- 4. a destructive command (SLEEP_PC) requires confirmation, and is
  //          NOT executed until the desktop's user approves it ----
  const confirmationRequired = waitFor(desktop, 'command-confirmation-required');
  const sleepPromise = phone.sendCommand(desktop.deviceId, 'SLEEP_PC');
  const confirmReq = await confirmationRequired;
  assert.strictEqual(confirmReq.command, 'SLEEP_PC');
  assert.strictEqual(executedCommands.filter((c) => c.command === 'SLEEP_PC').length, 0,
    'SLEEP_PC must not execute before confirmation, even with permission granted');
  console.log('✅ SLEEP_PC pauses for confirmation instead of executing on receipt');

  desktop.confirmCommand(confirmReq.commandId, true);
  const sleepResult = await sleepPromise;
  assert.strictEqual(sleepResult.ok, true);
  assert.ok(executedCommands.some((c) => c.command === 'SLEEP_PC'), 'SLEEP_PC should execute once confirmed');
  console.log('✅ SLEEP_PC executes once explicitly confirmed on the desktop');

  // ---- 5. if the user DENIES the confirmation, it never executes ----
  const confirmationRequired2 = waitFor(desktop, 'command-confirmation-required');
  const sleepPromise2 = phone.sendCommand(desktop.deviceId, 'SLEEP_PC');
  const confirmReq2 = await confirmationRequired2;
  const countBefore = executedCommands.filter((c) => c.command === 'SLEEP_PC').length;
  desktop.confirmCommand(confirmReq2.commandId, false);
  const sleepResult2 = await sleepPromise2;
  assert.strictEqual(sleepResult2.ok, false);
  assert.strictEqual(executedCommands.filter((c) => c.command === 'SLEEP_PC').length, countBefore,
    'denying confirmation must not execute the command');
  console.log('✅ Denying the confirmation prevents execution entirely');

  // ---- 6. notifications: blocked by default, work once granted ----
  const notifBlocked = waitFor(desktop, 'notification', 300).then(
    () => { throw new Error('notification should have been blocked'); },
    () => 'blocked-as-expected'
  );
  phone.sendNotification(desktop.deviceId, { app: 'Gmail', title: 'New email', body: 'Hi there' });
  await notifBlocked;
  console.log('✅ Notifications blocked by default (NOTIFICATIONS permission not yet granted)');

  desktop.setPermissions(phone.deviceId, { NOTIFICATIONS: true });
  const notifReceived = waitFor(desktop, 'notification');
  phone.sendNotification(desktop.deviceId, { app: 'Gmail', title: 'New email', body: 'Hi again' });
  const notif = await notifReceived;
  assert.strictEqual(notif.notification.title, 'New email');
  console.log('✅ Notification forwarded once NOTIFICATIONS permission is granted');

  // ---- 7. revoking REMOTE_CONTROL blocks further commands immediately ----
  desktop.setPermissions(phone.deviceId, { REMOTE_CONTROL: false });
  const resultAfterRevoke = await phone.sendCommand(desktop.deviceId, 'VOLUME_DOWN');
  assert.strictEqual(resultAfterRevoke.ok, false);
  console.log('✅ Revoking REMOTE_CONTROL blocks further commands immediately');

  desktop.close();
  phone.close();

  console.log('\n🎉 All remote-control / notification checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Remote-control test failed:', e);
  process.exit(1);
});
