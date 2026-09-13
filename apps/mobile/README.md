# NEXUS Mobile (React Native)

The real Android client for NEXUS. Runs on a physical phone via Expo Go
(SDK 51). Speaks the same wire protocol as `core/node.js` — see
`apps/mobile/__tests__/nexus-client.test.js` for the interop proof.

## Required setup (do this before anything else)

These two imports **must** be the very first lines executed, before any
other import — put them at the top of `App.js`:

```js
import 'fast-text-encoding';
import 'react-native-get-random-values';
```

Without `fast-text-encoding`: Hermes has no `TextEncoder`/`TextDecoder`,
and decrypting any message throws.
Without `react-native-get-random-values`: `globalThis.crypto.getRandomValues`
doesn't exist, and key generation / encryption throws.

Install everything this app needs:

```bash
cd apps/mobile
npx expo install fast-text-encoding react-native-get-random-values
npx expo install @noble/curves @noble/ciphers @noble/hashes
npx expo install expo-secure-store @react-native-async-storage/async-storage
npx expo install expo-file-system expo-document-picker expo-clipboard
```

## What's here

- `src/rn-crypto.js` — X25519 + HKDF-SHA256 + AES-256-GCM on `@noble/*`,
  byte-compatible with `packages/crypto/index.js` — verified by
  `__tests__/nexus-client.test.js`, not just asserted by comment. If you
  ever touch either crypto file, run that test before trusting the change.
- `src/NexusClient.js` — client half of `NexusNode`: HELLO, pairing,
  session resume, secure messaging, file transfer, remote control. Same
  event names as the desktop side (`paired`, `session-resumed`,
  `file-received`, etc.).
- `src/storage.js` — identity persistence (SecureStore, for the private
  key) and trusted-device persistence (AsyncStorage, for reconnect/resume
  without re-pairing).
- `src/screens/PairingScreen.js` — six code boxes, manual host:port entry.
- `src/screens/PermissionsScreen.js` — read-only view of what the phone
  requested. Approval happens on the desktop (there is no wire message
  for a phone to grant its own permissions; that is by design).
- `src/screens/DashboardScreen.js` — status, remote control (incl. media
  playback), clipboard, revoke.
- `src/screens/SendFileScreen.js` — pick and send a file, with progress.

## Running it

```bash
cd apps/mobile
npm install
npm test          # jest interop test against core/node.js
npx expo start    # scan the QR with Expo Go on your phone
```

Connect to your desktop's LAN IP and port `8342` from the pairing screen,
enter the code shown on the desktop, then approve permissions there.

## If you're debugging a reconnect loop or a "message type undefined" error

Kill Metro completely (`Ctrl+C`, not just pressing `r`), force-quit Expo
Go on the phone, then `npx expo start --clear` and reopen fresh. Fast
Refresh can leave stale references to modules like `protocol.js` after an
edit — a full reload is the reliable fix. Avoid saving files while the
app is actively running and connected; each save triggers a refresh that
can stack a new connection attempt on top of one that hasn't finished
closing yet.