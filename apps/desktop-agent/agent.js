/**
 * NEXUS Desktop Agent
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { NexusNode } = require('../../core/node');
const { Discovery } = require('../../core/discovery');

const DEFAULT_PORT = 8342;

/**
 * The default folder where received files land. We deliberately put it on
 * the Desktop (not in ~/.nexus) so users can actually find it.
 * Windows: C:\Users\<name>\Desktop\NEXUS Received
 * macOS:   ~/Desktop/NEXUS Received
 * Linux:   ~/Desktop/NEXUS Received (falls back to ~ if no Desktop)
 */
function defaultReceivedFolder() {
  const home = os.homedir();
  const desktopCandidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
  ];
  for (const d of desktopCandidates) {
    try {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        return path.join(d, 'NEXUS Received');
      }
    } catch (_) {}
  }
  return path.join(home, 'NEXUS Received');
}

class DesktopAgent {
  constructor({ dataDir, deviceName, port = DEFAULT_PORT, receivedFolder } = {}) {
    this.port = port;
    this.receivedFolder = receivedFolder || defaultReceivedFolder();
    try { fs.mkdirSync(this.receivedFolder, { recursive: true }); } catch (_) {}

    this.node = new NexusNode({
      deviceName: deviceName || os.hostname(),
      deviceType: 'desktop',
      dataDir: dataDir || path.join(os.homedir(), '.nexus', 'desktop'),
      // The desktop UI shows a modal and calls acceptFileOffer / rejectFileOffer.
      autoAcceptFiles: false,
    });

    this.discovery = new Discovery({
      deviceId: this.node.deviceId,
      deviceName: this.node.deviceName,
      deviceType: 'desktop',
      port: this.port,
    });

    this._wireEvents();
  }

  _wireEvents() {
    this.node.on('log', (m) => console.log('[nexus]', m));
    this.node.on('error', (e) => console.error('[nexus:error]', e.message));
    this.node.on('device-discovered', (d) => console.log(`[nexus] New device wants to connect: ${d.name} (${d.deviceId})`));
    this.node.on('paired', (d) => console.log(`[nexus] Paired with ${d.name} (${d.deviceId})`));
    this.node.on('permission-request', (d) => console.log(`[nexus] ${d.name} is requesting: ${(d.requestedPermissions || []).join(', ') || '(nothing specific)'} — use the Electron UI or node.setPermissions() to approve`));
    this.node.on('device-revoked', (d) => console.log(`[nexus] Revoked device ${d.deviceId}`));
    this.node.on('revoked-by-peer', (d) => console.log(`[nexus] ⚠️ Trust revoked by ${d.deviceId} — it must re-pair`));
    this.node.on('file-offer-pending', (f) => console.log(`[nexus] Incoming file from ${f.fromName}: ${f.fileName} (${f.fileSize} bytes) — awaiting approval in the UI`));
    this.node.on('file-offer-rejected', (f) => console.log(`[nexus] File offer rejected (${f.reason || 'unknown'}) from ${f.from}`));
    this.node.on('file-received', (f) => console.log(`[nexus] File received: ${f.fileName} -> ${f.path}`));
    // These two used to fail silently — a per-chunk or whole-file
    // checksum mismatch would just stop the transfer with no log line
    // anywhere, which is exactly what made the NexusClient.js base64
    // bug so hard to spot. Surface both loudly from now on.
    this.node.on('file-chunk-corrupt', (c) => console.error(`[nexus] ⚠️ Chunk ${c.chunkIndex} of transfer ${c.fileId.slice(0, 8)} failed its checksum — corrupted in transit`));
    this.node.on('file-error', (e) => console.error(`[nexus] ⚠️ File transfer ${e.fileId ? e.fileId.slice(0, 8) : ''} failed: ${e.reason}`));
    this.node.on('file-progress', (p) => {
      const pct = Math.round(((p.chunkIndex + 1) / p.totalChunks) * 100);
      process.stdout.write(`\r[nexus] transfer ${p.fileId.slice(0, 8)} ${p.direction} ${pct}%   `);
      if (pct === 100) process.stdout.write('\n');
    });
    this.node.on('clipboard', (c) => console.log(`[nexus] Clipboard update from ${c.from}: ${c.text.slice(0, 60)}`));

    this.discovery.on('warning', (w) => console.warn('[nexus:discovery]', w));
    this.discovery.on('found', (d) => this.node.emit('device-found-on-lan', d));
  }

  start() {
    this.node.listen(this.port);
    this.discovery.advertise();
    this.discovery.browse();
    this._startTelemetry();
    console.log(`[nexus] Desktop agent "${this.node.deviceName}" (${this.node.deviceId}) ready on port ${this.port}`);
    console.log(`[nexus] Received files will land in: ${this.receivedFolder}`);
    return this;
  }

  _startTelemetry() {
    this._telemetryTimer = setInterval(() => {
      this.node.broadcastStatus(getSystemStatus());
    }, 5000);
  }

  generatePairingCode() {
    return this.node.generatePairingCode();
  }

  stop() {
    clearInterval(this._telemetryTimer);
    this.discovery.stop();
    this.node.close();
  }
}

function getSystemStatus() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  const cpuLoadPct = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  return {
    cpu: cpuLoadPct,
    memory: Math.round(100 * (1 - freeMem / totalMem)),
    uptime: os.uptime(),
    platform: os.platform(),
    hostname: os.hostname(),
  };
}

module.exports = { DesktopAgent, getSystemStatus, DEFAULT_PORT, defaultReceivedFolder };

if (require.main === module) {
  const readline = require('readline');
  const agent = new DesktopAgent({
    dataDir: process.env.NEXUS_DATA_DIR || undefined,
    port: process.env.NEXUS_PORT ? Number(process.env.NEXUS_PORT) : undefined,
  });
  agent.start();
  console.log('Type a pairing code request from a phone/simulator to connect.');
  console.log('Pairing code (share this with the connecting device):', agent.generatePairingCode());

  // Headless mode: auto-accept incoming files. There is no UI to click.
  agent.node.autoAcceptFiles = true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const confirmationQueue = [];
  rl.on('line', (answer) => {
    const pending = confirmationQueue.shift();
    if (!pending) { console.log('[nexus] No command is waiting for confirmation.'); return; }
    const approved = /^y(es)?$/i.test(answer.trim());
    agent.node.confirmCommand(pending.commandId, approved);
    console.log(`[nexus] ${pending.command} ${approved ? 'approved' : 'denied'}.`);
    showNextConfirmation();
  });
  function showNextConfirmation() {
    if (confirmationQueue.length === 0) return;
    const pending = confirmationQueue[0];
    const device = agent.node.store.getDevice(pending.from);
    console.log(`\n${device ? device.name : pending.from} wants to run ${pending.command}.`);
    process.stdout.write('Allow? [y/N] ');
  }
  agent.node.on('command-confirmation-required', ({ commandId, command, from }) => {
    const wasEmpty = confirmationQueue.length === 0;
    confirmationQueue.push({ commandId, command, from });
    if (wasEmpty) showNextConfirmation();
  });
  process.on('SIGINT', () => { rl.close(); agent.stop(); process.exit(0); });
}