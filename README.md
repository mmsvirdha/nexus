# NEXUS

**Secure Cross-Device Intelligence & Automation Platform**

Control your Windows PC from your Android phone over your local network —
no cloud, no relay, no account. Every message between the two devices is
encrypted end-to-end with a session key that's derived independently on
both sides and never travels over the wire.

```
📱 Phone  ───────────────────────  🖥️ Desktop
     Manual host:port / mDNS   →
     ←  6-digit pairing code
     ECDH (X25519) → AES-256-GCM session key  ⇄
     Default-deny permissions, approved per-capability on the desktop
     Resumable chunked file transfer            ⇄
     Bidirectional clipboard sync                ⇄
     Remote control (lock / sleep / volume / media)  →
     Live CPU / RAM / hostname telemetry          ←
     Notifications                                →
```

## Why

Copying something on your phone and pasting it on your laptop — or the
other way around — still isn't seamless in 2026 unless you route it
through a cloud service that's storing your clipboard history somewhere
you didn't ask it to. NEXUS does it directly, device to device, over the
network you're already on.

## Features

- 🔐 **Secure pairing** — a 6-digit code shown on the desktop is the only
  way a phone can establish trust. Being on the same Wi-Fi is not enough.
- 🛡️ **End-to-end encryption** — X25519 ECDH key exchange, HKDF-SHA256,
  AES-256-GCM. The session key is derived locally on both sides and never
  crosses the network.
- 🚫 **Default-deny permissions** — pairing alone grants nothing. Every
  capability (files, clipboard, remote control, notifications) is
  requested by the phone and approved individually by the desktop owner,
  and enforcement lives entirely on the receiving device — a phone can
  claim whatever it wants, only the desktop's local permission table
  decides what actually happens.
- 🖥️ **Remote control** — lock, sleep, volume, and media playback
  (play/pause, next, previous), driven through native OS APIs (Windows
  Core Audio COM interface + `keybd_event` for media keys — no third-party
  utilities required). Disruptive actions like sleep require a fresh
  confirmation on the desktop every time, even when the permission is
  already granted — a standing grant is never a standing blank check.
- 📁 **File transfer** — chunked, checksummed (SHA-256, whole-file and
  per-chunk), and resumable if the connection drops mid-transfer. The
  desktop sees every incoming file before it lands and chooses where to
  save it.
- 📋 **Bidirectional clipboard sync** — copy on the phone, paste on the
  laptop, or the other way around.
- 📊 **Live telemetry** — CPU, memory, hostname, and connection status,
  pushed securely every 5 seconds.
- 🔔 **Notifications** — forward phone alerts to a native desktop
  notification.
- 🔁 **Session resume** — reconnect to an already-trusted device without
  re-pairing.
- ❌ **Remote revocation** — cut a device's access from either side,
  instantly, both directions. A revoked device must fully re-pair; a
  stale key alone won't let it back in.

## Architecture

```
apps/
  desktop-agent/     Electron UI + a headless Node.js agent you can run
                      standalone; native OS confirmation dialogs and
                      notifications
  mobile/             React Native (Expo) Android client — pairing,
                      permissions, dashboard, remote control, file
                      transfer, clipboard, all screens functional
  mobile-simulator/   Terminal-based "phone" for exercising the full
                      protocol without an Android device or build
core/
  node.js             The symmetric peer engine — WebSocket transport,
                      HELLO handshake, pairing, encrypted messaging,
                      resumable file transfer, remote commands
  commands.js         Cross-platform command resolution + execution
                      (pure resolver + thin OS-touching executor, split
                      for unit-testability)
  discovery.js        mDNS advertise/browse, with manual host:port
                      fallback
packages/
  protocol/           Wire format — message types, permission catalog,
                      command whitelist. Shared verbatim between the
                      desktop and mobile apps.
  crypto/             X25519 + HKDF-SHA256 + AES-256-GCM, built on pure-JS
                      @noble libraries — no native modules, so the exact
                      same file runs unmodified on Node (desktop) and
                      Hermes (React Native), eliminating an entire class
                      of cross-platform wire-format bugs by construction.
  store/              JSON-backed persistence (devices, permissions,
                      transfers, audit log)
tests/                4 files, 30+ checks: protocol/crypto unit tests,
                      a full end-to-end integration flow over a real
                      WebSocket, remote-control + notification coverage,
                      and a real-child-process test of the terminal
                      confirmation UI
```

## Running it locally

### Desktop agent

```bash
npm install
npm run desktop:ui      # Electron UI
# or
npm run desktop         # headless CLI agent
```

### Mobile app (Android via Expo)

```bash
cd apps/mobile
npm install
npx expo start
```

Scan the QR code with Expo Go, connect to your desktop's LAN IP and port
`8342`, enter the pairing code shown on the desktop, and approve
permissions from the dialog that appears there.

### No phone handy? Use the CLI simulator

```bash
npm run phone
nexus> connect 127.0.0.1 8342
nexus> pair <desktop-device-id> <code>
nexus> send <desktop-device-id> ./some-file.zip
nexus> clip <desktop-device-id> hello from the CLI
nexus> cmd <desktop-device-id> VOLUME_UP
```

### Run the tests

```bash
npm test
```

## Security model

- The desktop generates a long-term X25519 keypair on first run
  (`~/.nexus/desktop/identity.json` — **never commit this file**, see
  `.gitignore`).
- Pairing requires a 6-digit code with a short expiry, generated fresh on
  the desktop and entered on the phone. This is the only way a device
  becomes trusted — proximity to the same Wi-Fi network proves nothing on
  its own.
- Every message after pairing is encrypted with AES-256-GCM under a
  session key derived via ECDH + HKDF-SHA256. That key is computed
  independently by both devices and never appears on the wire.
- All permissions default to `false`. The receiving device's local
  permission table is the sole source of truth for what's allowed —
  never the sender's claim about what it should be able to do.
- Disruptive remote commands require confirmation on the desktop at the
  moment they're requested, regardless of any standing permission grant.
- Revoking a device is immediate and mutual: both sides drop trust, and
  reconnecting requires a full re-pair, not just a new connection.

## What's next

See `docs/ROADMAP.md` for the phased plan in detail. Not yet built:
capturing real Android notifications (sending works; capturing needs a
native listener service and a dev build), mDNS discovery on the mobile
side (manual host:port works today), remote mouse/keyboard, application
launching, camera/screen streaming, and an automation (`IF → THEN`)
engine.

## License

MIT — see `LICENSE`.