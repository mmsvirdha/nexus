# NEXUS Roadmap

## ✅ Done (this scaffold)

| Phase | What | Where |
|---|---|---|
| 1 | Device identity (X25519 keypair, deterministic deviceId) | `packages/crypto`, `core/node.js` |
| 2 | LAN discovery via mDNS, with manual-connect fallback | `core/discovery.js` |
| 3 | WebSocket transport + HELLO handshake | `core/node.js` |
| 4 | NEXUS protocol (typed envelope, message catalog) | `packages/protocol` |
| 5 | Secure pairing (6-digit code → ECDH session key) | `core/node.js` |
| 6 | Permission system, default-deny, receiver-enforced | `core/node.js`, `packages/store` |
| 7 | Chunked, checksummed, **resumable** file transfer | `core/node.js` |
| 8 | Clipboard sync (text) | `core/node.js` |
| 9 | Device telemetry (CPU/RAM push every 5s) | `apps/desktop-agent/agent.js` |
| — | Audit logging of pairing/transfers/denials | `packages/store` |
| — | End-to-end integration test proving all of the above | `tests/integration.test.js` |
| 6.5 | Permission-approval UI + device management (edit/revoke) | `apps/desktop-agent/renderer`, `core/node.js` (`revokeDevice`, `permission-request` event) |
| 10 | Notification forwarding (protocol + simulator; real Android listener still pending) | `core/node.js` (`sendNotification`), `apps/desktop-agent/electron-main.js` (native OS notification) |
| 11 | Remote control — safe subset: lock, sleep, volume, media | `core/commands.js`, `core/node.js` (`sendCommand`, `confirmCommand`), `apps/desktop-agent/electron-main.js` (native confirm dialog) |

Phase 10 is done at the protocol/desktop level — `sendNotification()` is
permission-gated exactly like everything else, the CLI simulator can
trigger it (`notify` command), and the Electron app shows a real native
OS notification and logs it. What's still missing is the actual Android
side: a real notification listener service to *capture* phone
notifications in the first place, which needs native Android code (see
`apps/mobile/README.md`) — the simulator can only fake sending one.

Phase 11's safe subset is fully implemented and tested: `LOCK_PC`,
`SLEEP_PC`, `VOLUME_UP/DOWN/SET`, `MEDIA_PLAY/PAUSE/NEXT/PREVIOUS`. Two
independent gates protect it — `REMOTE_CONTROL` permission (default-deny,
receiver-enforced) and a **fixed command whitelist** checked on both the
sender (so nothing malformed even gets sent) and the receiver (so a
modified client can't bypass the sender's own check). `SLEEP_PC`
additionally requires a fresh, per-action confirmation via a real native
OS dialog on the desktop, even though the permission was already granted
— see `COMMANDS_REQUIRING_CONFIRMATION` in `packages/protocol`. The
headless CLI agent (`apps/desktop-agent/agent.js`) has the equivalent as
a terminal prompt when not running under Electron, verified end-to-end
via `tests/cli-confirmation.test.js`, which spawns the real agent as a
child process and drives its actual stdin — no shell tricks, no
in-process event simulation. (`NEXUS_DATA_DIR` / `NEXUS_PORT` env vars
exist solely so that test can run isolated instances without touching a
real `~/.nexus` directory or the default port.) The actual OS commands
(`core/commands.js`) are split into a pure resolver function
(unit-tested with zero side effects) and a thin executor; verified in
this sandbox to fail cleanly, not crash, when the underlying OS tool
(`amixer`, `loginctl`, `systemctl`, etc.) isn't present. **Deliberately
not implemented**: application launching, and mouse/keyboard/arbitrary
command execution — see the warning under Phase 11 below.

## 🔜 Next (in the order I'd tackle them)

### Phase 11, remaining scope — application launching
An explicit allow-list of applications the user configures on the
desktop (not an arbitrary path the phone can send) is the only safe way
to do this. Mouse/keyboard input is a separate, later step: it needs a
native input-injection module on the desktop side (`robotjs` or a
platform-native alternative) and careful rate-limiting, and should stay
gated behind its own `REMOTE_INPUT` permission (already reserved in
`packages/protocol`, not yet wired to anything). **Arbitrary command
execution should not be built at all** — `SYSTEM_COMMAND` exists in the
permission catalog as a reserved placeholder specifically so the wire
protocol can express "this device wants to run something," while the
comment next to it makes clear it is deliberately never implemented.

### Phase 12 — Automation engine
`IF <event> [AND <condition>] THEN <action>`. The event bus already
exists implicitly (`NexusNode` is an `EventEmitter`) — add a
`RuleEngine` that subscribes to the same events (`file-received`,
`status`, `device-connected`, etc.), evaluates stored rules from
`store.automation_rules` (add this table), and calls back into
`NexusNode` methods to execute actions. Keep actions to the same
permission-gated methods already exposed — don't give the rule engine a
side channel that bypasses permission checks.

### Phase 13 — Camera / screen streaming
Genuinely the hardest phase technically. Start with a low-frame-rate
preview (a few JPEG frames a second over the existing WebSocket) before
attempting a real video codec pipeline. This is where you'd eventually
reach for WebRTC instead of raw WebSocket frames, for proper
adaptive bitrate and NAT traversal if you ever add remote (non-LAN) use.

### Phase 14 — AI assistant
Intent parsing → the *same* permission-gated tool functions everything
else uses (`sendFile`, `sendClipboard`, `setPermissions` for
user-approved changes, etc.) — never a raw shell/API bypass. Require
explicit confirmation before any action with side effects, exactly as
sketched in the original design doc's "AI should not have unlimited
access" section.

### Phase 15 — Real mobile app
Replace `apps/mobile-simulator` with the real React Native screens in
`apps/mobile` once you're ready to test on an actual Android device or
emulator (background service, notification listener, and camera access
all require leaving Expo Go for a development build — see
`apps/mobile/README.md`).

## Explicitly deferred (don't build until the above is solid)

- Cloud relay / remote (non-LAN) connectivity — NAT traversal and a relay
  server are a project of their own; the LAN-only MVP is deliberately
  the whole point of phases 1–9.
- Multi-device (>2) synchronization and conflict resolution — solve the
  two-device case completely first; the sync/version-vector logic for
  N devices is a meaningfully different problem.
- PostgreSQL migration — only worth it once you actually add
  multi-user/cloud features; SQLite (or this JSON store) is fine until then.

## A bug worth knowing about (and how it was found)

An earlier version of the resume test in `tests/integration.test.js`
detected a dropped connection by polling `session.ws.readyState`. That
looked fine in isolation and passed repeatedly — until a revocation test
was added right after it, which occasionally failed with a confusing
"rejected FILE_OFFER from untrusted device" error nowhere near the code
that seemed responsible.

Root cause: `ws.terminate()`'s effect on `readyState` doesn't land as
promptly as the real `close` event does, especially on a loopback
connection. The sending loop kept sailing past the intended interruption
point for several more chunks before noticing, so the "interrupted"
transfer sometimes quietly finished in the background — which meant a
later test step's `await` resolved off that stale completion instead of
the thing it was actually supposed to wait for, and by the time the
*real* resumed request arrived, the test had already raced ahead into
revoking the device.

Fix: drive the interruption check off an explicit `session.closed` flag,
set synchronously inside the real `ws.on('close', ...)` handler, instead
of polling `readyState` (see `core/node.js`, `_attach` and
`_handleFileAccept`). Confirmed with 15+ consecutive clean runs
afterward, including after the remote-control and notification tests
were added on top.

The takeaway that generalizes beyond this one bug: **when a test's
correctness depends on a network operation happening within a certain
window, wait on an event that fires exactly when that thing happens —
don't infer it from a state flag that might update on its own schedule.**
The same principle applies to the real desktop/mobile apps once they're
built on real Wi-Fi instead of loopback, where these timing gaps are
larger and far more likely to bite in production.

## A related lesson: testing interactive CLIs

While verifying the terminal confirmation prompt added for disruptive
remote commands, an early manual test tried to drive a running agent
process's stdin via shell redirection into `/proc/<pid>/fd/0`, alongside
some ad-hoc juggling of overlapping background processes across
separate shell invocations. That produced a wall of confusing, unrelated
-looking repeated errors — not a real bug, just an artifact of stale
process state and a wrong tool for the job.

The fix was to stop improvising and use `child_process.spawn()` with a
real `stdio: ['pipe', 'pipe', 'pipe']` and write to `child.stdin`
properly — see `tests/cli-confirmation.test.js`. That's the correct way
to test any interactive CLI from another Node process, and it's what
finally gave a clean, trustworthy answer (confirmed 3x back-to-back).
