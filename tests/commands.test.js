/**
 * Unit tests for core/commands.js's resolveShellCommand — pure, no
 * side effects, so these run anywhere without touching the real OS
 * (useful since this sandbox has no desktop session, audio server, or
 * admin rights to actually lock/sleep/change volume).
 */

const assert = require('assert');
const { resolveShellCommand } = require('../core/commands');
const { ALLOWED_COMMANDS } = require('../packages/protocol');

function main() {
  const platforms = ['win32', 'darwin', 'linux'];

  // Every allowed command should resolve to SOMETHING on every major
  // desktop platform — if one doesn't, that's a gap to fix, not a
  // silent no-op waiting to confuse someone in production.
  for (const command of ALLOWED_COMMANDS) {
    for (const platform of platforms) {
      const result = resolveShellCommand(command, {}, platform);
      assert.ok(typeof result === 'string' && result.length > 0,
        `${command} has no shell command for platform "${platform}"`);
    }
  }
  console.log(`✅ Every one of ${ALLOWED_COMMANDS.length} allowed commands resolves on win32/darwin/linux`);

  // Unsupported platform -> null, not a crash or a garbage string.
  assert.strictEqual(resolveShellCommand('LOCK_PC', {}, 'freebsd'), null);
  console.log('✅ Unsupported platform returns null rather than guessing');

  // Unknown command -> null on every platform, never falls through to
  // running something unintended.
  for (const platform of platforms) {
    assert.strictEqual(resolveShellCommand('DELETE_EVERYTHING', {}, platform), null);
  }
  console.log('✅ Unknown/unlisted command returns null on every platform');

  // VOLUME_SET clamps out-of-range levels instead of passing them through.
  const over = resolveShellCommand('VOLUME_SET', { level: 500 }, 'linux');
  const under = resolveShellCommand('VOLUME_SET', { level: -50 }, 'linux');
  assert.ok(over.includes('100%'), `expected clamped-to-100 in: ${over}`);
  assert.ok(under.includes('0%'), `expected clamped-to-0 in: ${under}`);
  console.log('✅ VOLUME_SET clamps out-of-range levels to 0-100');


    // Windows must not depend on nircmd.exe — the Windows implementations
  // use project-owned PowerShell helpers under core/windows-helpers/.
  const windowsCommands = ['VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_SET', 'MEDIA_PLAY', 'MEDIA_PAUSE', 'MEDIA_NEXT', 'MEDIA_PREVIOUS'];
  for (const command of windowsCommands) {
    const resolved = resolveShellCommand(command, { level: 50 }, 'win32');
    assert.ok(resolved, `${command} should resolve on win32`);
    assert.ok(!/nircmd/i.test(resolved), `${command} must NOT reference nircmd.exe. Got: ${resolved}`);
    assert.ok(resolved.startsWith('powershell '), `${command} on win32 should use powershell. Got: ${resolved}`);
    assert.ok(/core[\\/]windows-helpers[\\/]/.test(resolved), `${command} on win32 should reference core/windows-helpers/. Got: ${resolved}`);
    assert.ok(resolved.includes('-NoProfile'), `${command} on win32 should pass -NoProfile to powershell. Got: ${resolved}`);
    assert.ok(resolved.includes('-File'), `${command} on win32 should pass -File to powershell. Got: ${resolved}`);
  }
  console.log('✅ No Windows command depends on nircmd.exe');

  // LOCK_PC and SLEEP_PC must remain Windows-native (rundll32) — those
  // already worked without any external dependency and must not regress.
  for (const command of ['LOCK_PC', 'SLEEP_PC']) {
    const resolved = resolveShellCommand(command, {}, 'win32');
    assert.ok(/rundll32/.test(resolved), `${command} on win32 should still use rundll32. Got: ${resolved}`);
  }
  console.log('✅ LOCK_PC and SLEEP_PC remain rundll32-based on Windows');

  // VOLUME_SET clamps on Windows too (same clamp as Linux/ macOS path).
  const over = resolveShellCommand('VOLUME_SET', { level: 500 }, 'win32');
  const under = resolveShellCommand('VOLUME_SET', { level: -50 }, 'win32');
  assert.ok(over.includes('set 100'), `expected clamped-to-100 in: ${over}`);
  assert.ok(under.includes('set 0'), `expected clamped-to-0 in: ${under}`);
  console.log('✅ VOLUME_SET clamps to 0-100 on Windows too');

  console.log('\n🎉 All command-resolution checks passed.');
}

main();
