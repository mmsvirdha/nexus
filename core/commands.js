/**
 * NEXUS Commands
 * --------------
 * Resolves a NEXUS command name (LOCK_PC, VOLUME_UP, ...) to an actual
 * shell command per platform, and runs it.
 *
 * Split into two pieces on purpose:
 *   - resolveShellCommand(): a PURE function, no side effects. Given a
 *     command + platform, returns the shell string (or null if
 *     unsupported on that platform). Fully unit-testable without a real
 *     desktop session, audio server, or admin rights — which is exactly
 *     what a CI box or this sandbox doesn't have.
 *   - realCommandExecutor(): actually runs it via child_process. This is
 *     the only part that touches the real OS, and it's the part you
 *     inject a mock for in tests (see NexusNode's `commandExecutor`
 *     constructor option).
 *
 * Windows notes:
 *   LOCK_PC / SLEEP_PC use rundll32.exe — Windows builtins, no dependency.
 *   VOLUME_* and MEDIA_* use inline PowerShell that calls the real
 *   Windows audio / keyboard APIs (via Add-Type + P/Invoke). No
 *   nircmd.exe, no external download, nothing to install.
 *
 *   The PowerShell script is passed as a base64 blob via -EncodedCommand,
 *   NOT as a quoted -Command "..." string, because the inline C# uses
 *   double quotes and those break when cmd.exe re-parses the command
 *   line. -EncodedCommand sidesteps all quoting problems.
 */

const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Windows helper: build a `powershell -EncodedCommand <base64>` invocation
// for the given PowerShell source. Encoded as UTF-16LE, which is what
// powershell.exe expects.
// ---------------------------------------------------------------------------
function psEncoded(psSource) {
  const buf = Buffer.from(psSource, 'utf16le');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${buf.toString('base64')}`;
}

// PowerShell that changes master volume. Appended with a specific action.
// Uses the Core Audio COM interface via IAudioEndpointVolume. This is the
// same mechanism the hardware volume keys use.
function psVolumeScript(action, level) {
  return `
$ErrorActionPreference = 'Stop'
$cs = @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g();
  int GetChannelCount(out uint pnChannelCount);
  int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int GetMasterVolumeLevel(out float pfLevelDB);
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
  int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
  int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
  int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int f();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public class Audio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
    var epvid = typeof(IAudioEndpointVolume).GUID;
    object aev;
    dev.Activate(ref epvid, 23, IntPtr.Zero, out aev);
    return aev as IAudioEndpointVolume;
  }
  public static float Get() { float level; Vol().GetMasterVolumeLevelScalar(out level); return level; }
  public static void Set(float level) {
    if (level < 0f) level = 0f;
    if (level > 1f) level = 1f;
    Vol().SetMasterVolumeLevelScalar(level, Guid.Empty);
  }
}
'@
Add-Type -TypeDefinition $cs
$current = [Audio]::Get()
${action === 'up' ? '[Audio]::Set($current + 0.05)' : ''}
${action === 'down' ? '[Audio]::Set($current - 0.05)' : ''}
${action === 'set' ? `[Audio]::Set(${Number(level) / 100.0})` : ''}
exit 0
`;
}

// PowerShell that sends a media key. Uses keybd_event from user32.dll
// with the same VK codes the hardware media keys send.
function psMediaScript(action) {
  // https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
  const vk = {
    play:     0xB3,  // VK_MEDIA_PLAY_PAUSE
    pause:    0xB3,
    next:     0xB0,  // VK_MEDIA_NEXT_TRACK
    previous: 0xB1,  // VK_MEDIA_PREV_TRACK
  }[action];
  return `
$ErrorActionPreference = 'Stop'
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class Media {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Press(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
'@
Add-Type -TypeDefinition $cs
[Media]::Press(${vk})
exit 0
`;
}

/**
 * @param {string} command - one of ALLOWED_COMMANDS (see packages/protocol)
 * @param {object} args - command-specific args, e.g. { level: 50 } for VOLUME_SET
 * @param {NodeJS.Platform} platform - defaults to the real process.platform
 * @returns {string|null} the shell command to run, or null if this
 *   command isn't supported on this platform.
 */
function resolveShellCommand(command, args = {}, platform = process.platform) {
  switch (command) {
    case 'LOCK_PC':
      if (platform === 'win32') return 'rundll32.exe user32.dll,LockWorkStation';
      if (platform === 'darwin') return '/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend';
      if (platform === 'linux') return 'loginctl lock-session || xdg-screensaver lock';
      return null;

    case 'SLEEP_PC':
      if (platform === 'win32') return 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0';
      if (platform === 'darwin') return 'pmset sleepnow';
      if (platform === 'linux') return 'systemctl suspend';
      return null;

    case 'VOLUME_UP':
      if (platform === 'win32') return psEncoded(psVolumeScript('up'));
      if (platform === 'darwin') return 'osascript -e "set volume output volume (output volume of (get volume settings) + 5)"';
      if (platform === 'linux') return 'amixer -q sset Master 5%+ || pactl set-sink-volume @DEFAULT_SINK@ +5%';
      return null;

    case 'VOLUME_DOWN':
      if (platform === 'win32') return psEncoded(psVolumeScript('down'));
      if (platform === 'darwin') return 'osascript -e "set volume output volume (output volume of (get volume settings) - 5)"';
      if (platform === 'linux') return 'amixer -q sset Master 5%- || pactl set-sink-volume @DEFAULT_SINK@ -5%';
      return null;

    case 'VOLUME_SET': {
      const level = Math.max(0, Math.min(100, Number(args.level) || 0));
      if (platform === 'win32') return psEncoded(psVolumeScript('set', level));
      if (platform === 'darwin') return `osascript -e "set volume output volume ${level}"`;
      if (platform === 'linux') return `amixer -q sset Master ${level}% || pactl set-sink-volume @DEFAULT_SINK@ ${level}%`;
      return null;
    }

    case 'MEDIA_PLAY_PAUSE':
      // Real hardware media keys are a single toggle (VK_MEDIA_PLAY_PAUSE)
      // — there's no separate "always play" / "always pause" signal on
      // most systems, so the phone only ever sends this one command.
      if (platform === 'win32') return psEncoded(psMediaScript('play'));
      if (platform === 'darwin') return 'osascript -e "tell application \\"System Events\\" to key code 16 using {command down, option down}"';
      if (platform === 'linux') return 'playerctl play-pause';
      return null;

    case 'MEDIA_NEXT':
      if (platform === 'win32') return psEncoded(psMediaScript('next'));
      if (platform === 'darwin') return 'playerctl next 2>/dev/null || osascript -e "tell application \\"Music\\" to next track"';
      if (platform === 'linux') return 'playerctl next';
      return null;

    case 'MEDIA_PREVIOUS':
      if (platform === 'win32') return psEncoded(psMediaScript('previous'));
      if (platform === 'darwin') return 'playerctl previous 2>/dev/null || osascript -e "tell application \\"Music\\" to previous track"';
      if (platform === 'linux') return 'playerctl previous';
      return null;

    default:
      return null;
  }
}

/** Actually runs the resolved command. The only OS-touching part. */
function realCommandExecutor(command, args = {}) {
  return new Promise((resolve) => {
    // Test hook: tests/cli-confirmation.test.js sets NEXUS_FAKE_SLEEP=1
    // so that confirming SLEEP_PC in the test verifies the confirmation
    // flow without actually suspending the developer's machine.
    if (command === 'SLEEP_PC' && process.env.NEXUS_FAKE_SLEEP === '1') {
      resolve({ ok: true, message: 'SLEEP_PC executed (test mode)' });
      return;
    }
    const shellCommand = resolveShellCommand(command, args);
    if (!shellCommand) {
      resolve({ ok: false, message: `${command} is not supported on ${process.platform}` });
      return;
    }
    exec(shellCommand, { timeout: 10_000 }, (error) => {
      if (error) {
        resolve({ ok: false, message: `${command} failed: ${error.message}` });
      } else {
        resolve({ ok: true, message: `${command} executed` });
      }
    });
  });
}

module.exports = { resolveShellCommand, realCommandExecutor };