/**
 * NEXUS Protocol
 * ----------------
 * Defines the wire format every NEXUS device speaks over WebSocket.
 * Every message is a single JSON object (envelope) with a typed payload.
 */

const PROTOCOL_VERSION = 1;

/** @enum {string} */
const MessageType = Object.freeze({
  HELLO: 'HELLO',
  HELLO_ACK: 'HELLO_ACK',

    PAIR_REQUEST: 'PAIR_REQUEST',
  PAIR_CHALLENGE: 'PAIR_CHALLENGE',
  PAIR_RESPONSE: 'PAIR_RESPONSE',
  PAIR_ACCEPT: 'PAIR_ACCEPT',
  PAIR_REJECT: 'PAIR_REJECT',
  DEVICE_REVOKED: 'DEVICE_REVOKED',

  SESSION_RESUME: 'SESSION_RESUME',
  SESSION_RESUMED: 'SESSION_RESUMED',

  PING: 'PING',
  PONG: 'PONG',

  FILE_OFFER: 'FILE_OFFER',
  FILE_ACCEPT: 'FILE_ACCEPT',
  FILE_REJECT: 'FILE_REJECT',
  FILE_CHUNK: 'FILE_CHUNK',
  FILE_CHUNK_ACK: 'FILE_CHUNK_ACK',
  FILE_COMPLETE: 'FILE_COMPLETE',
  FILE_CANCEL: 'FILE_CANCEL',
  FILE_RESUME_REQUEST: 'FILE_RESUME_REQUEST',

  CLIPBOARD_UPDATE: 'CLIPBOARD_UPDATE',

  DEVICE_STATUS: 'DEVICE_STATUS',
  NOTIFICATION: 'NOTIFICATION',

  COMMAND_REQUEST: 'COMMAND_REQUEST',
  COMMAND_RESPONSE: 'COMMAND_RESPONSE',

  ERROR: 'ERROR',
});

const PERMISSIONS = Object.freeze([
  'FILE_SEND',
  'FILE_RECEIVE',
  'CLIPBOARD_READ',
  'CLIPBOARD_WRITE',
  'SCREEN_STREAM',
  'REMOTE_INPUT',      // reserved for future mouse/keyboard control — not implemented yet
  'SYSTEM_COMMAND',    // reserved for future arbitrary command execution — deliberately never wired up
  'CAMERA_ACCESS',
  'REMOTE_CONTROL',    // the safe, fixed command set actually implemented: lock, sleep, volume, media
  'NOTIFICATIONS',     // may forward OS notifications to the other device
]);

// The ONLY commands REMOTE_CONTROL can trigger. This is a fixed,
// reviewed allow-list — never a passthrough to an arbitrary string.
// Adding a new remote-control capability means adding a case here AND
// in core/commands.js, not just sending a new string over the wire.
const ALLOWED_COMMANDS = Object.freeze([
  'LOCK_PC',
  'SLEEP_PC',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'VOLUME_SET',
  'MEDIA_PLAY_PAUSE', // single toggle command — see core/commands.js for why
  'MEDIA_NEXT',
  'MEDIA_PREVIOUS',
]);

// Commands that stay behind an explicit per-action confirmation on the
// executing device EVEN THOUGH the permission was already granted.
// A granted permission means "this device is allowed to ask" — it does
// not mean every disruptive ask executes silently forever.
const COMMANDS_REQUIRING_CONFIRMATION = Object.freeze(['SLEEP_PC']);

// Chunk size for file transfer (256 KB). Small enough to keep memory
// bounded, large enough to keep per-chunk overhead low on a LAN.
const CHUNK_SIZE = 256 * 1024;

let counter = 0;
function makeMessageId() {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a protocol envelope.
 * @param {string} type - one of MessageType
 * @param {object} payload
 * @param {{source?: string, destination?: string}} [meta]
 */
function createMessage(type, payload = {}, meta = {}) {
  if (!Object.values(MessageType).includes(type)) {
    throw new Error(`Unknown NEXUS message type: ${type}`);
  }
  return {
    version: PROTOCOL_VERSION,
    messageId: makeMessageId(),
    type,
    source: meta.source || null,
    destination: meta.destination || null,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Parse and lightly validate a raw string/buffer into an envelope.
 * Throws on malformed input rather than silently accepting garbage.
 */
function parseMessage(raw) {
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error('Malformed NEXUS message: not valid JSON');
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('Malformed NEXUS message: not an object');
  if (obj.version !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${obj.version}`);
  if (!Object.values(MessageType).includes(obj.type)) throw new Error(`Unknown message type: ${obj.type}`);
  if (typeof obj.payload !== 'object' || obj.payload === null) throw new Error('Malformed NEXUS message: missing payload');
  return obj;
}

module.exports = {
  PROTOCOL_VERSION,
  MessageType,
  PERMISSIONS,
  ALLOWED_COMMANDS,
  COMMANDS_REQUIRING_CONFIRMATION,
  CHUNK_SIZE,
  createMessage,
  parseMessage,
  makeMessageId,
};