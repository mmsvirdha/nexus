# NEXUS Wire Protocol (v1)

Every message is one JSON object over a single persistent WebSocket
connection between two paired devices.

## Envelope

```json
{
  "version": 1,
  "messageId": "opaque string, unique per message",
  "type": "FILE_CHUNK",
  "source": "nexus-<deviceId> or null before HELLO completes",
  "destination": "nexus-<deviceId> or null",
  "timestamp": "ISO-8601",
  "payload": { "...": "type-specific" }
}
```

## Message types and when they're used

| Type | Direction | Encrypted? | Purpose |
|---|---|---|---|
| `HELLO` / `HELLO_ACK` | either | no | exchange deviceId, name, type, public key on connect |
| `PAIR_REQUEST` | initiator → responder | no | present the out-of-band pairing code |
| `PAIR_ACCEPT` / `PAIR_REJECT` | responder → initiator | no | confirm/deny pairing |
| `PING` / `PONG` | either | no | heartbeat, every 10s, 25s timeout |
| `FILE_OFFER` | sender → receiver | yes | announce a file, size, chunk count, whole-file checksum |
| `FILE_ACCEPT` / `FILE_REJECT` | receiver → sender | yes | accept (with resume `startChunk`) or refuse |
| `FILE_CHUNK` | sender → receiver | yes | one chunk, base64 data + per-chunk SHA-256 |
| `FILE_CHUNK_ACK` | receiver → sender | yes | per-chunk ack, `ok: false` on checksum mismatch |
| `FILE_COMPLETE` | sender → receiver | yes | whole-file checksum for final verification |
| `FILE_CANCEL` | either | yes | abort an in-progress transfer |
| `CLIPBOARD_UPDATE` | either | yes | push clipboard text to the peer |
| `DEVICE_STATUS` | either | yes | CPU/RAM/etc. telemetry push |
| `NOTIFICATION` | either | yes | forwarded OS notification (phase 10, not yet wired to real OS APIs) |
| `ERROR` | either | usually no | best-effort error surfaces (e.g. malformed message) |

"Encrypted" messages carry `payload: { enc: { iv, authTag, ciphertext } }`
— all real base64 AES-256-GCM, not a placeholder — and are only
processed once a session key exists (i.e. after pairing).

## Why pairing happens before encryption, not during HELLO

`HELLO` deliberately happens in the clear: it's just "here's who I claim
to be and my public key," which isn't sensitive. The **pairing code**
(shown on one device, entered on the other) is the actual trust
anchor — it proves a human with physical access to both devices approved
the relationship. Only after that succeeds do we derive the ECDH session
key and start encrypting.

## File transfer state machine

```
sender                              receiver
  |--- FILE_OFFER(fileId, size, --->|
  |     totalChunks, checksum)      | check permission
  |                                 | check for existing partial
  |                                 |   transfer with this fileId
  |<-- FILE_ACCEPT(startChunk) -----|
  |--- FILE_CHUNK(i) -------------->|  (for i = startChunk..totalChunks-1)
  |<-- FILE_CHUNK_ACK(i, ok) -------|
  |            ...                  |
  |--- FILE_COMPLETE(checksum) ---->| verify whole-file SHA-256
  |                                 | rename .part -> final name
```

If the connection drops mid-transfer, both sides already have `fileId`
and know how far they got (the receiver from `receivedChunks` in its
transfer store, tracked chunk-by-chunk as they're written to disk).
Re-offering the same `fileId` after reconnecting causes the receiver to
report its true `startChunk` in `FILE_ACCEPT`, and the sender resumes
from there — see `tests/integration.test.js` for a working demonstration
of exactly this.

## Extending the protocol

Add new types to `MessageType` in `packages/protocol/index.js`, handle
them in `NexusNode._handleSecureMessage` (or the unencrypted switch in
`_dispatch` if it must work pre-pairing), and — if the action is
sensitive — add a new value to `PERMISSIONS` and gate it with
`store.isAllowed()` **on the receiving side**, matching the existing
pattern for `FILE_RECEIVE` and `CLIPBOARD_WRITE`.
