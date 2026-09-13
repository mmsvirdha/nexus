#!/usr/bin/env node
/**
 * NEXUS Mobile Simulator
 * -----------------------
 * A terminal "phone" so you can exercise the entire NEXUS protocol
 * (discovery fallback, pairing, encrypted channel, resumable file
 * transfer, clipboard sync, status updates) using two terminals on one
 * machine — before you've set up an Android build environment.
 *
 * Usage:
 *   node simulator.js                          interactive mode
 *   node simulator.js connect <host> <port>    connect straight away
 *
 * Interactive commands once running:
 *   connect <host> <port>
 *   pair <deviceId> <code>
 *   allow <deviceId> <PERMISSION>              (run on the desktop, not here — see note below)
 *   send <deviceId> <filePath>
 *   clip <deviceId> <text...>
 *   devices
 *   status
 *   quit
 */

const os = require('os');
const path = require('path');
const readline = require('readline');
const { NexusNode } = require('../../core/node');
const { PERMISSIONS } = require('../../packages/protocol');

const dataDir = path.join(os.homedir(), '.nexus', 'mobile-simulator');
const node = new NexusNode({ deviceName: 'Simulated Phone', deviceType: 'mobile', dataDir });

console.log(`[sim] Identity: ${node.deviceName} (${node.deviceId})`);
console.log(`[sim] Data dir: ${dataDir}`);

node.on('log', (m) => console.log('[nexus]', m));
node.on('error', (e) => console.error('[nexus:error]', e.message));
node.on('device-discovered', (d) => console.log(`[sim] Connected to ${d.name} (${d.deviceId}) — not yet paired. Run: pair ${d.deviceId} <code-shown-on-other-device>`));
node.on('paired', (d) => console.log(`[sim] ✅ Paired with ${d.name} (${d.deviceId}). Ask the desktop's owner to approve permissions.`));
node.on('pair-rejected', (r) => console.log(`[sim] ❌ Pairing rejected: ${r.reason}`));
node.on('file-progress', (p) => {
  const pct = Math.round(((p.chunkIndex + 1) / p.totalChunks) * 100);
  process.stdout.write(`\r[sim] transfer ${p.direction} ${pct}%   `);
  if (pct === 100) process.stdout.write('\n');
});
node.on('file-received', (f) => console.log(`\n[sim] 📁 File received: ${f.fileName} -> ${f.path}`));
node.on('file-sent', (f) => console.log(`\n[sim] 📁 File sent (${f.fileId.slice(0, 8)})`));
node.on('file-error', (e) => console.log(`[sim] ⚠️ File error: ${e.reason}`));
node.on('clipboard', (c) => console.log(`[sim] 📋 Clipboard from ${c.from}: ${c.text}`));
node.on('status', (s) => console.log(`[sim] 📊 Status from ${s.from}: CPU ${s.status.cpu}% RAM ${s.status.memory}%`));
node.on('device-disconnected', (id) => console.log(`[sim] Disconnected: ${id}`));
node.on('device-revoked', (d) => console.log(`[sim] Revoked ${d.deviceId}`));
node.on('revoked-by-peer', (d) => console.log(`[sim] ⚠️ ${d.deviceId} revoked this device's trust — you'll need to re-pair.`));
node.on('file-offer-rejected', (f) => console.log(`[sim] Blocked incoming file "${f.fileName}" from ${f.from} — no FILE_RECEIVE permission granted`));
node.on('notification', (n) => console.log(`[sim] 🔔 ${n.notification.app}: ${n.notification.title} — ${n.notification.body}`));
node.on('command-confirmation-required', ({ commandId, command, from }) => {
  console.log(`[sim] ${from} wants to run ${command} on this device. Run: confirm ${commandId} yes|no`);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'nexus> ' });

function help() {
  console.log(`
Commands:
  connect <host> <port>        connect to a NEXUS device (e.g. connect 127.0.0.1 8342)
  pair <deviceId> <code> [PERMS...]   complete pairing; optionally list requested perms
                                (e.g. pair nexus-abc123 483920 FILE_SEND FILE_RECEIVE)
  send <deviceId> <filePath>   send a file (must be paired + granted FILE_SEND on the receiver)
  clip <deviceId> <text...>    send clipboard text (must be granted CLIPBOARD_READ)
  cmd <deviceId> <COMMAND>     send a remote-control command (needs REMOTE_CONTROL; e.g. cmd nexus-abc VOLUME_UP)
                                Commands: LOCK_PC, SLEEP_PC, VOLUME_UP, VOLUME_DOWN,
                                MEDIA_PLAY, MEDIA_PAUSE, MEDIA_NEXT, MEDIA_PREVIOUS
  notify <deviceId> <app> <title> <body...>   forward a simulated notification (needs NOTIFICATIONS)
  devices                      list known devices
  perms <deviceId>             show granted permissions for a device
  revoke <deviceId>            revoke trust with a device
  help                         show this again
  quit                         exit
`);
}
help();
rl.prompt();

rl.on('line', async (line) => {
  const [cmd, ...args] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case 'connect': {
        const [host, port] = args;
        node.connect(host, Number(port));
        break;
      }
      case 'pair': {
        const [deviceId, code, ...requested] = args;
        // Default to the common MVP set if the user doesn't specify which
        // permissions to ask for — purely a UI hint for the desktop's
        // approval dialog; it decides what to actually grant either way.
        const requestedPermissions = requested.length ? requested : ['FILE_SEND', 'FILE_RECEIVE', 'CLIPBOARD_READ', 'CLIPBOARD_WRITE'];
        node.requestPairing(deviceId, code, requestedPermissions);
        break;
      }
      case 'send': {
        const [deviceId, filePath] = args;
        await node.sendFile(deviceId, filePath);
        break;
      }
      case 'clip': {
        const [deviceId, ...text] = args;
        node.sendClipboard(deviceId, text.join(' '));
        break;
      }
      case 'cmd': {
        const [deviceId, command] = args;
        console.log(`[sim] Sending ${command} to ${deviceId}...`);
        const result = await node.sendCommand(deviceId, command);
        console.log(`[sim] Response: ${result.ok ? '✅' : '❌'} ${result.message}`);
        break;
      }
      case 'notify': {
        const [deviceId, app, title, ...body] = args;
        node.sendNotification(deviceId, { app, title, body: body.join(' ') });
        break;
      }
      case 'devices': {
        console.table(node.store.listDevices());
        break;
      }
      case 'perms': {
        console.log(node.store.getPermissions(args[0]));
        break;
      }
      case 'revoke': {
        node.revokeDevice(args[0]);
        break;
      }
      case 'confirm': {
        const [commandId, answer] = args;
        node.confirmCommand(commandId, /^y(es)?$/i.test(answer));
        break;
      }
      case 'help':
        help();
        break;
      case 'quit':
      case 'exit':
        node.close();
        process.exit(0);
        break;
      case '':
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type "help".`);
    }
  } catch (e) {
    console.error('[sim] Error:', e.message);
  }
  rl.prompt();
});

// Allow `node simulator.js connect <host> <port>` as a shortcut.
if (process.argv[2] === 'connect') {
  node.connect(process.argv[3], Number(process.argv[4]));
}
