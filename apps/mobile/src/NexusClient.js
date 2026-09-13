/**
 * NexusClient — React Native.
 *
 * Speaks exactly the same wire protocol as core/node.js's NexusNode:
 * same HELLO / HELLO_ACK payloads, same PAIR_REQUEST / PAIR_ACCEPT,
 * same post-pairing `{ enc: { iv, authTag, ciphertext } }` envelope, same
 * event names, same default-deny semantics.
 */

import * as FileSystem from 'expo-file-system';
import { randomBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { createMessage, parseMessage, MessageType, CHUNK_SIZE } from '../../../packages/protocol';
import * as rnCrypto from './rn-crypto';
import { Emitter } from './emitter';

export class NexusClient extends Emitter {
  constructor({ identity, deviceName, trustedDeviceHint }) {
    super();
    if (!identity || !identity.deviceId || !identity.publicKey || !identity.privateKey) {
      throw new Error('NexusClient: identity with deviceId/publicKey/privateKey is required');
    }
    this.identity = identity;
    this.deviceName = deviceName || 'NEXUS Phone';
    this.deviceType = 'mobile';
    this.ws = null;
    this._remote = null;
    this._sessionKey = null;
    this._trusted = false;
    this._closedByUs = false;
    this._trustedDeviceHint = trustedDeviceHint || null;

    this._pendingCommands = new Map();
    this._outgoingFiles = new Map();
    this._incomingFiles = new Map();
    this._fileSendHandlers = new Map();

    // When the laptop accepts an offered file, kick off the chunk stream.
    // This listener fires from _handleSecureMessage after FILE_ACCEPT has
    // been decrypted, so `p` is the plaintext payload ({ fileId, startChunk }).
    this.on('file-accepted', (p) => {
      const outgoing = this._outgoingFiles.get(p.fileId);
      if (!outgoing) return;
      const startChunk = typeof p.startChunk === 'number' ? p.startChunk : 0;
      this._streamFileChunks(p.fileId, outgoing, startChunk).catch((e) => {
        this.emit('file-error', { fileId: p.fileId, reason: e.message });
      });
    });
  }

  connect(host, port) {
    this._closedByUs = false;
    const url = `ws://${host}:${port}`;
    this.emit('log', `Connecting to ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this._sendHello();
    ws.onmessage = (evt) => this._onMessage(evt.data);
    ws.onerror = (e) => {
      this.emit('error', new Error(`WebSocket error: ${e && e.message ? e.message : 'unknown'}`));
    };
    ws.onclose = () => {
      const remoteId = this._remote && this._remote.deviceId;
      this._trusted = false;
      this._sessionKey = null;
      this.emit('device-disconnected', remoteId);
    };
  }

  _sendHello() {
    this._sendRaw(MessageType.HELLO, {
      deviceId: this.identity.deviceId,
      deviceName: this.deviceName,
      deviceType: this.deviceType,
      publicKey: this.identity.publicKey,
    });
  }

  close() {
    this._closedByUs = true;
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }

  requestPairing(remoteDeviceId, code, requestedPermissions = []) {
    if (!this._remote || this._remote.deviceId !== remoteDeviceId) {
      throw new Error(`Not connected to ${remoteDeviceId}`);
    }
    this._sendRaw(MessageType.PAIR_REQUEST, {
      code,
      deviceId: this.identity.deviceId,
      deviceName: this.deviceName,
      publicKey: this.identity.publicKey,
      requestedPermissions,
    });
    this.emit('log', 'Pairing request sent');
  }

  sendClipboard(remoteDeviceId, text) {
    this._sendSecure(remoteDeviceId, MessageType.CLIPBOARD_UPDATE, { text });
  }

  sendNotification(remoteDeviceId, { app, title, body }) {
    this._sendSecure(remoteDeviceId, MessageType.NOTIFICATION, { app, title, body });
  }

  sendCommand(remoteDeviceId, command, args = {}, { timeoutMs = 30_000 } = {}) {
    const commandId = uuidv4();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingCommands.delete(commandId);
        reject(new Error(`Command ${command} timed out`));
      }, timeoutMs);
      this._pendingCommands.set(commandId, { resolve, reject, timeout });
      try {
        this._sendSecure(remoteDeviceId, MessageType.COMMAND_REQUEST, { commandId, command, args });
      } catch (e) {
        clearTimeout(timeout);
        this._pendingCommands.delete(commandId);
        reject(e);
      }
    });
  }

  /**
   * Offer a file to the peer. Resolves once the peer accepts, rejects on
   * decline or timeout. Chunks are streamed from the file-accepted handler.
   *
   * The default is intentionally generous (2 minutes, not a "normal"
   * network timeout): accepting a file on the laptop means a human has
   * to click through the approve dialog AND the OS "Save as…" file
   * picker, which can easily take longer than a typical request timeout.
   * See core/node.js's HEARTBEAT_TIMEOUT_MS for the matching reason on
   * the desktop side — both got bumped together so neither side gives up
   * on the other mid-dialog.
   */
  async sendFile(remoteDeviceId, fileUri, { fileId, fileName } = {}, { timeoutMs = 120_000 } = {}) {
    if (!this._sessionKey) throw new Error('Not paired yet');
    const info = await FileSystem.getInfoAsync(fileUri, { size: true });
    if (!info.exists) throw new Error(`File not found: ${fileUri}`);
    const size = info.size;
    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const name = fileName || fileUri.split('/').pop() || 'file.bin';
    const checksum = await sha256File(fileUri);
    const id = fileId || uuidv4();

    this._outgoingFiles.set(id, { fileUri, size, totalChunks, checksum, name, remoteDeviceId });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._outgoingFiles.delete(id);
        this.removeAllHandlersForFile(id);
        reject(new Error('Timed out waiting for the laptop to accept the file'));
      }, timeoutMs);

      const onAccepted = (p) => {
        if (p.fileId !== id) return;
        clearTimeout(timeout);
        this.removeAllHandlersForFile(id);
        resolve({ fileId: id, totalChunks });
      };
      const onRejected = (p) => {
        if (p.fileId !== id) return;
        clearTimeout(timeout);
        this._outgoingFiles.delete(id);
        this.removeAllHandlersForFile(id);
        reject(new Error(p.reason === 'permission_denied'
          ? 'The laptop has not granted FILE_RECEIVE to this phone'
          : `The laptop declined the file (${p.reason || 'unknown'})`));
      };

      this._fileSendHandlers.set(id, { onAccepted, onRejected });
      this.once('file-accepted', onAccepted);
      this.once('file-rejected', onRejected);

      this._sendSecure(remoteDeviceId, MessageType.FILE_OFFER, {
        fileId: id, fileName: name, fileSize: size, totalChunks, checksum,
      });
    });
  }

  removeAllHandlersForFile(fileId) {
    const h = this._fileSendHandlers.get(fileId);
    if (!h) return;
    this.off('file-accepted', h.onAccepted);
    this.off('file-rejected', h.onRejected);
    this._fileSendHandlers.delete(fileId);
  }

    _sendRaw(type, payload) {
    console.log('[nexus:dbg] _sendRaw called. type =', JSON.stringify(type), 'typeof type =', typeof type);
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('WebSocket not open');
    }
    const msg = createMessage(type, payload, {
      source: this.identity.deviceId,
      destination: this._remote ? this._remote.deviceId : null,
    });
    this.ws.send(JSON.stringify(msg));
  }

  _sendSecure(remoteDeviceId, type, payload) {
    if (!this._sessionKey) throw new Error('No secure session established');
    if (!this._remote || this._remote.deviceId !== remoteDeviceId) {
      throw new Error(`Not connected to ${remoteDeviceId}`);
    }
    const plaintext = JSON.stringify(payload);
    const enc = rnCrypto.encrypt(this._sessionKey, plaintext);
    this._sendRaw(type, { enc });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = parseMessage(raw);
    } catch (e) {
      this.emit('error', e);
      return;
    }
    try {
      this._dispatch(msg);
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * Only NON-ENCRYPTED messages are handled here. Anything that arrives
   * after pairing as `{ enc: { iv, authTag, ciphertext } }` goes through
   * _handleSecureMessage, which decrypts first.
   */
  _dispatch(msg) {
    switch (msg.type) {
      case MessageType.HELLO:
        this._handleHello(msg);
        return;
      case MessageType.HELLO_ACK:
        this._handleHelloAck(msg);
        return;
      case MessageType.PAIR_ACCEPT:
        this._handlePairAccept(msg);
        return;
      case MessageType.PAIR_REJECT:
        this.emit('pair-rejected', msg.payload);
        return;
      case MessageType.SESSION_RESUMED:
        this._handleSessionResumed(msg);
        return;
      case MessageType.DEVICE_REVOKED:
        this._trusted = false;
        this._sessionKey = null;
        this.emit('revoked-by-peer', { deviceId: msg.source });
        return;
      case MessageType.PING:
        try { this._sendRaw(MessageType.PONG, {}); } catch (_) {}
        return;
      case MessageType.PONG:
        return;
      default:
        return this._handleSecureMessage(msg);
    }
  }

  _handleHello(msg) {
    const { deviceId, deviceName, deviceType, publicKey } = msg.payload;
    this._remote = {
      deviceId, name: deviceName, type: deviceType, publicKey,
      host: (this.ws && this.ws.url) ? hostFromUrl(this.ws.url) : null,
      port: (this.ws && this.ws.url) ? portFromUrl(this.ws.url) : null,
    };
    this._sendRaw(MessageType.HELLO_ACK, {
      deviceId: this.identity.deviceId,
      deviceName: this.deviceName,
      deviceType: this.deviceType,
      publicKey: this.identity.publicKey,
    });
    this._afterHandshake();
  }

  _handleHelloAck(msg) {
    const { deviceId, deviceName, deviceType, publicKey } = msg.payload;
    this._remote = {
      deviceId, name: deviceName, type: deviceType, publicKey,
      host: (this.ws && this.ws.url) ? hostFromUrl(this.ws.url) : null,
      port: (this.ws && this.ws.url) ? portFromUrl(this.ws.url) : null,
    };
    this._afterHandshake();
  }

  _afterHandshake() {
    if (
      this._trustedDeviceHint &&
      this._trustedDeviceHint.deviceId === this._remote.deviceId
    ) {
      this._sendRaw(MessageType.SESSION_RESUME, {
        deviceId: this.identity.deviceId,
        deviceName: this.deviceName,
        publicKey: this.identity.publicKey,
      });
      this.emit('log', 'SESSION_RESUME sent');
      return;
    }
    this.emit('device-discovered', {
      deviceId: this._remote.deviceId,
      name: this._remote.name,
      host: this._remote.host,
      port: this._remote.port,
    });
  }

  _handleSessionResumed(msg) {
    this._sessionKey = rnCrypto.deriveSessionKey(
      this.identity.privateKey,
      this._remote.publicKey
    );
    this._trusted = true;
    this.emit('log', 'Session resumed');
    this.emit('session-resumed', {
      deviceId: this._remote.deviceId,
      name: this._remote.name,
      host: this._remote.host,
      port: this._remote.port,
    });
  }

  _handlePairAccept(msg) {
    this._sessionKey = rnCrypto.deriveSessionKey(
      this.identity.privateKey,
      this._remote.publicKey
    );
    this._trusted = true;
    this.emit('log', 'Secure session established');
    this.emit('paired', {
      deviceId: this._remote.deviceId,
      name: this._remote.name,
      host: this._remote.host,
      port: this._remote.port,
    });
  }

  /**
   * Handles every post-pairing message. Decrypts payload.enc first, then
   * dispatches on the message type with the plaintext payload.
   */
  _handleSecureMessage(msg) {
    if (
      msg.type === MessageType.ERROR &&
      msg.payload &&
      msg.payload.inResponseTo === MessageType.SESSION_RESUME
    ) {
      this.emit('log', 'SESSION_RESUME rejected; falling back to pairing');
      this._trustedDeviceHint = null;
      if (this._remote) {
        this.emit('device-discovered', {
          deviceId: this._remote.deviceId,
          name: this._remote.name,
          host: this._remote.host,
          port: this._remote.port,
        });
      }
      return;
    }

    if (!this._trusted || !this._sessionKey) {
      this.emit('error', new Error(`Rejected ${msg.type} from untrusted device`));
      return;
    }
    if (!msg.payload || !msg.payload.enc) {
      this.emit('error', new Error(`Expected encrypted payload for ${msg.type}`));
      return;
    }
    let decrypted;
    try {
      const buf = rnCrypto.decrypt(this._sessionKey, msg.payload.enc);
      decrypted = JSON.parse(rnCrypto.bufferToUtf8(buf));
    } catch (e) {
      this.emit('error', new Error(`Failed to decrypt ${msg.type}: ${e.message}`));
      return;
    }

    switch (msg.type) {
      case MessageType.CLIPBOARD_UPDATE:
        this.emit('clipboard', { from: msg.source, text: decrypted.text });
        return;
      case MessageType.DEVICE_STATUS:
        this.emit('status', { from: msg.source, status: decrypted });
        return;
      case MessageType.NOTIFICATION:
        this.emit('notification', { from: msg.source, notification: decrypted });
        return;
      case MessageType.COMMAND_RESPONSE:
        return this._handleCommandResponse(decrypted);
      case MessageType.FILE_OFFER:
        return this._handleFileOffer(msg.source, decrypted);
      case MessageType.FILE_ACCEPT:
        this.emit('file-accepted', decrypted);
        return;
      case MessageType.FILE_REJECT:
        this.emit('file-rejected', { from: msg.source, ...decrypted });
        return;
      case MessageType.FILE_CHUNK:
        return this._handleFileChunk(msg.source, decrypted);
      case MessageType.FILE_CHUNK_ACK:
        this.emit('file-chunk-ack', decrypted);
        return;
      case MessageType.FILE_COMPLETE:
        return this._handleFileComplete(msg.source, decrypted);
      case MessageType.ERROR:
        this.emit('peer-error', { from: msg.source, ...decrypted });
        return;
      default:
        this.emit('error', new Error(`Unhandled message type: ${msg.type}`));
    }
  }

  _handleCommandResponse(payload) {
    const pending = this._pendingCommands.get(payload.commandId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this._pendingCommands.delete(payload.commandId);
    pending.resolve({ ok: payload.ok, message: payload.message });
  }

  /**
   * Stream the chunks of a file the peer has accepted.
   *
   * Checks the socket is still OPEN before each chunk. If the connection
   * is lost mid-transfer, this aborts with a clear error instead of
   * silently pushing chunks into a dead socket (which is what made the
   * progress bar climb while the desktop received nothing).
   */
  async _streamFileChunks(fileId, outgoing, startChunk) {
    try {
      for (let i = startChunk; i < outgoing.totalChunks; i++) {
        if (!this.ws || this.ws.readyState !== 1) {
          throw new Error('Connection to the laptop was lost during transfer');
        }
        const position = i * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, outgoing.size - position);
        const b64 = await FileSystem.readAsStringAsync(outgoing.fileUri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });
        const checksum = rnCrypto.sha256Hex(base64ToBytes(b64));
        this._sendSecure(outgoing.remoteDeviceId, MessageType.FILE_CHUNK, {
          fileId, chunkIndex: i, totalChunks: outgoing.totalChunks,
          checksum, data: b64,
        });
        this.emit('file-progress', {
          fileId, direction: 'send', chunkIndex: i, totalChunks: outgoing.totalChunks,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      this._sendSecure(outgoing.remoteDeviceId, MessageType.FILE_COMPLETE, {
        fileId, checksum: outgoing.checksum,
      });
      this._outgoingFiles.delete(fileId);
      this.emit('file-sent', { fileId });
    } catch (e) {
      this._outgoingFiles.delete(fileId);
      this.emit('file-error', { fileId, reason: e.message });
    }
  }

  async _handleFileOffer(from, payload) {
    const { fileId, fileName, fileSize, totalChunks, checksum } = payload;
    const tmpPath = `${FileSystem.documentDirectory}nexus-${fileId}.part`;
    this._incomingFiles.set(fileId, {
      fileId, from, fileName, fileSize, totalChunks, checksum, tmpPath,
      chunks: [],
      received: 0,
    });
    this._sendSecure(from, MessageType.FILE_ACCEPT, { fileId, startChunk: 0 });
    this.emit('file-offer-accepted', { from, fileId, fileName });
  }

  async _handleFileChunk(from, payload) {
    const { fileId, chunkIndex, data, checksum } = payload;
    const incoming = this._incomingFiles.get(fileId);
    if (!incoming) return;
    const raw = base64ToBytes(data);
    if (rnCrypto.sha256Hex(raw) !== checksum) {
      this._sendSecure(from, MessageType.FILE_CHUNK_ACK, { fileId, chunkIndex, ok: false });
      return;
    }
    incoming.chunks[chunkIndex] = raw;
    incoming.received = chunkIndex + 1;
    this._incomingFiles.set(fileId, incoming);
    this._sendSecure(from, MessageType.FILE_CHUNK_ACK, { fileId, chunkIndex, ok: true });
    this.emit('file-progress', {
      fileId, direction: 'receive', chunkIndex, totalChunks: incoming.totalChunks,
    });
  }

  async _handleFileComplete(from, payload) {
    const incoming = this._incomingFiles.get(payload.fileId);
    if (!incoming) return;
    this._incomingFiles.delete(payload.fileId);

    const total = incoming.chunks.reduce((n, c) => n + (c ? c.length : 0), 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of incoming.chunks) {
      if (!c) continue;
      all.set(c, off);
      off += c.length;
    }
    const b64 = bytesToBase64(all);

    await FileSystem.writeAsStringAsync(incoming.tmpPath, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    this.emit('file-received', {
      fileId: payload.fileId,
      fileName: incoming.fileName,
      path: incoming.tmpPath,
      from,
    });
  }
}

function uuidv4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function hostFromUrl(url) {
  try {
    const m = url.match(/^wss?:\/\/([^:\/]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
function portFromUrl(url) {
  try {
    const m = url.match(/^wss?:\/\/[^:\/]+:(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// FIX: the previous version stripped '=' padding characters before
// computing the output length ("clean.length" no longer matched the
// real base64 length once padding was removed), which corrupted the
// last 1-2 bytes of ANY file whose size wasn't a multiple of 3 (i.e.
// almost every real file). That silently broke both the per-chunk
// checksum AND the whole-file checksum, which is why files "sent"
// successfully on the phone but the desktop's checksum verification
// failed quietly and no file ever landed in the received folder. This
// version keeps '=' in `clean` so every group of 4 characters lines up
// correctly, and uses the real padding count to size the output.
function base64ToBytes(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - padding);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean[i], c1 = clean[i + 1], c2 = clean[i + 2], c3 = clean[i + 3];
    const n = (B64.indexOf(c0) << 18) | (B64.indexOf(c1) << 12)
            | ((c2 === '=' ? 0 : B64.indexOf(c2)) << 6) | (c3 === '=' ? 0 : B64.indexOf(c3));
    if (p < out.length) out[p++] = (n >> 16) & 0xff;
    if (p < out.length) out[p++] = (n >> 8) & 0xff;
    if (p < out.length) out[p++] = n & 0xff;
  }
  return out;
}

function bytesToBase64(bytes) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i+1] << 8) | bytes[i+2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const a = bytes[i];
    const b = rem === 2 ? bytes[i+1] : 0;
    const n = (a << 16) | (b << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (rem === 2 ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

async function sha256File(fileUri) {
  const info = await FileSystem.getInfoAsync(fileUri, { size: true });
  const size = info.exists && typeof info.size === 'number' ? info.size : 0;
  const hasher = sha256.create();
  let pos = 0;
  while (pos < size) {
    const len = Math.min(CHUNK_SIZE, size - pos);
    const b64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: pos,
      length: len,
    });
    hasher.update(base64ToBytes(b64));
    pos += len;
  }
  const digest = hasher.digest();
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}