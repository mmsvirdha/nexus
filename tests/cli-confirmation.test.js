/**
 * Test the headless desktop agent's terminal confirmation prompt (added
 * in apps/desktop-agent/agent.js for COMMANDS_REQUIRING_CONFIRMATION)
 * by actually spawning it as a child process and driving its real
 * stdin/stdout — not by shell tricks like writing into /proc/<pid>/fd/0,
 * which produced confusing, unrelated-looking errors when tried manually
 * (overlapping desktop processes from a botched manual test, not a
 * protocol bug — this test exists to get a clean, trustworthy answer).
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { NexusNode } = require('../core/node');

async function waitForOutput(child, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`Timed out waiting for /${pattern}/ in output. Got:\n${buf}`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      if (pattern.test(buf)) {
        clearTimeout(t);
        child.stdout.off('data', onData);
        resolve(buf);
      }
    };
    child.stdout.on('data', onData);
  });
}

async function main() {
  const desktopDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-test-desktop-'));
  const PORT = 18500 + Math.floor(Math.random() * 1000);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'desktop-agent', 'agent.js')], {
    env: { ...process.env, NEXUS_DATA_DIR: desktopDataDir, NEXUS_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[agent stderr] ${d}`));

  try {
    const startupOutput = await waitForOutput(child, /Pairing code.*: (\d+)/);
    const code = startupOutput.match(/Pairing code.*: (\d+)/)[1];
    const idMatch = startupOutput.match(/Desktop agent "[^"]+" \(([^)]+)\)/);
    const desktopId = idMatch[1];

    // Drive a phone via a real NexusNode in this same process (no need to
    // spawn a second child for this half).
    const phoneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-test-phone-'));
    const phone = new NexusNode({ deviceName: 'CLI-Test-Phone', deviceType: 'mobile', dataDir: phoneDataDir });
    phone.on('error', () => {}); // not under test here

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('phone never discovered desktop')), 5000);
      phone.once('device-discovered', () => { clearTimeout(t); resolve(); });
      phone.connect('127.0.0.1', Number(PORT));
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pairing never completed')), 5000);
      phone.once('paired', () => { clearTimeout(t); resolve(); });
      phone.requestPairing(desktopId, code);
    });
    console.log('✅ CLI agent: real child process pairs correctly with a phone NexusNode');

    // Grant REMOTE_CONTROL by writing directly into the SAME store file the
    // running child process reads from disk on startup — but since it's
    // already running with an in-memory copy, we instead exploit the fact
    // that the test can act as a *second* privileged local client: for
    // this test we just reach into the child's data dir store file
    // directly and then ask the child to reload... actually simplest and
    // most honest: the running agent won't see it. So instead, restart it.
    child.kill();
    await new Promise((r) => setTimeout(r, 300));

    const grantNode = new NexusNode({ deviceName: 'grant', deviceType: 'desktop', dataDir: desktopDataDir });
    grantNode.setPermissions(phone.deviceId, { REMOTE_CONTROL: true });

        const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'desktop-agent', 'agent.js')], {
      env: {
        ...process.env,
        NEXUS_DATA_DIR: desktopDataDir,
        NEXUS_PORT: String(PORT),
        // In test runs, do not actually suspend the machine — replace
        // the real rundll32 sleep with a no-op that reports success.
        // The confirmation PROMPT behavior is what this test verifies;
        // actually sleeping the host OS is out of scope.
        NEXUS_FAKE_SLEEP: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child2.stderr.on('data', (d) => process.stderr.write(`[agent2 stderr] ${d}`));
    await waitForOutput(child2, /Pairing code/);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('reconnect never completed')), 5000);
      phone.once('device-connected', () => { clearTimeout(t); resolve(); });
      phone.connect('127.0.0.1', Number(PORT));
    });

    // Now send SLEEP_PC (requires confirmation) and watch for the prompt,
    // then answer "y" through the child's REAL stdin — the correct way to
    // drive an interactive CLI, unlike writing into /proc/<pid>/fd/0.
    const commandPromise = phone.sendCommand(desktopId, 'SLEEP_PC');
   await waitForOutput(
  child2,
  /wants to run SLEEP_PC/
);
    console.log('✅ CLI agent: confirmation prompt appears on the real terminal for a disruptive command');
    child2.stdin.write('y\n');

    const result = await commandPromise;
    // On this Linux sandbox there's no real systemd session, so the
    // underlying `systemctl suspend` will itself fail — that's fine and
    // expected (see core/commands.js's own graceful-failure test). What
    // matters here is that it got approved and attempted at all, i.e.
    // result.ok can be either value, but result.message must NOT be the
    // generic "Permission denied" or "Denied by user" — it must reflect
    // an actual execution attempt.
    assert.ok(!/^Permission denied$/.test(result.message));
    assert.ok(!/^Denied by user$/.test(result.message));
    console.log(`✅ CLI agent: approved command was actually attempted (result: ${JSON.stringify(result)})`);

    phone.close();
    child2.kill();
    console.log('\n🎉 CLI confirmation-prompt flow verified via a real child process.');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ CLI test failed:', e);
    child.kill();
    process.exit(1);
  }
}

main();
