<#
  NEXUS Windows volume helper.
  Called by core/commands.js as:
      powershell -NoProfile -ExecutionPolicy Bypass -File volume.ps1 <up|down|set> [value]
  No external tools. Uses the Windows Core Audio API via inline C#.
#>

param(
  [Parameter(Mandatory=$true)][ValidateSet('up','down','set')] [string]$Action,
  [int]$Value = 0
)

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
  public static float Get() {
    float level; Vol().GetMasterVolumeLevelScalar(out level); return level;
  }
  public static void Set(float level) {
    if (level < 0f) level = 0f;
    if (level > 1f) level = 1f;
    Vol().SetMasterVolumeLevelScalar(level, Guid.Empty);
  }
}
'@

Add-Type -TypeDefinition $cs

$current = [Audio]::Get()
switch ($Action) {
  'up'   { [Audio]::Set($current + 0.05) }
  'down' { [Audio]::Set($current - 0.05) }
  'set'  { [Audio]::Set([float]$Value / 100.0) }
}

exit 0