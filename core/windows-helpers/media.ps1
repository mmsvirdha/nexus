<#
  NEXUS Windows media-key helper.
  Called by core/commands.js as:
      powershell -NoProfile -ExecutionPolicy Bypass -File media.ps1 <play|pause|next|previous>
  No external tools. Uses keybd_event (user32.dll) to send the same virtual
  key codes Windows media keys use.
#>

param(
  [Parameter(Mandatory=$true)][ValidateSet('play','pause','next','previous')] [string]$Action
)

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

# Virtual-key codes: https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
$VK_MEDIA_NEXT_TRACK = 0xB0
$VK_MEDIA_PREV_TRACK = 0xB1
$VK_MEDIA_PLAY_PAUSE = 0xB3

switch ($Action) {
  'play'     { [Media]::Press($VK_MEDIA_PLAY_PAUSE) }
  'pause'    { [Media]::Press($VK_MEDIA_PLAY_PAUSE) }
  'next'     { [Media]::Press($VK_MEDIA_NEXT_TRACK) }
  'previous' { [Media]::Press($VK_MEDIA_PREV_TRACK) }
}

exit 0