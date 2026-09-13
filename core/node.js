/**
 * NEXUS Core Node
 * ---------------
 * A single class used by BOTH the desktop agent and the mobile
 * (simulator / eventual React Native) app, because the protocol is
 * symmetric: any two NEXUS devices talk to each other the same way.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const { MessageType, PERMISSIONS, ALLOWED_COMMANDS, COMMANDS_REQUIRING_CONFIRMATION, CHUNK_SIZE, createMessage, parseMessage } = require('../packages/protocol');
const nexusCrypto = require('../packages/crypto');
const { Store } = require('../packages/store');
const { realCommandExecutor } = require('./commands');

// Native OS dialogs (the file-approve prompt, and especially the "Save
// as…" file picker) can stall Electron's JS event loop on Windows for
// however long a human takes to click through them — sometimes 30-60+
// seconds. A short heartbeat timeout mistakes that stall for a dead
// connection and closes it right as the user finishes approving,
// destroying an otherwise-healthy session. 90s gives real human
// dialog-clicking time plenty of room while still catching genuinely
// dead connections (a phone that's actually gone stays gone far longer
// than that).
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

class NexusNode extends EventEmitter {
  constructor(opts) {
    super();
    this.deviceName = opts.deviceName;
    this.deviceType = opts.deviceType;
    this.dataDir = opts.dataDir;
    this.receivedDir = path.join(this.dataDir, 'received');
    fs.mkdirSync(this.receivedDir, { recursive: true });

    this.store = new Store(path.join(this.dataDir, 'store.json'));
    this._loadOrCreateIdentity();
    this.commandExecutor = opts.commandExecutor || realCommandExecutor;

    // If true (default for headless / test use), file offers are accepted
    // immediately. If false, they are queued and the caller must call
    // acceptFileOffer() or rejectFileOffer(). The Electron UI sets this to
    // false so a human can approve.
    this.autoAcceptFiles = opts.autoAcceptFiles !== false;

    this.sessions = new Map();
    this.pendingPairingCodes = new Map();
    this.pendingCommands = new Map();
    this.pendingCommandRequests = new Map();
    /** fileId -> { session, payload, startChunk, tmpPath, defaultFinalPath } */
    this.pendingFileOffers = new Map();

    this._server = null;
  }

  // ---------------------------------------------------------------- identity
  _loadOrCreateIdentity() {
    const identityPath = path.join(this.dataDir, 'identity.json');
    if (fs.existsSync(identityPath)) {
      this.identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    } else {
      const { publicKey, privateKey } = nexusCrypto.generateDeviceKeyPair();
      this.identity = {
        deviceId: nexusCrypto.deriveDeviceId(publicKey),
        publicKey,
        privateKey,
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(identityPath, JSON.stringify(this.identity, null, 2));
    }
  }

  get deviceId() {
    return this.identity.deviceId;
  }

  // ----------------------------------------------------------------- server
  listen(port) {
    this._server = new WebSocket.Server({ port });
    this._server.on('connection', (ws) => this._attach(ws, false));
    this.emit('log', `Listening for NEXUS peers on port ${port}`);
    return this;
  }

  connect(host, port) {
    const ws = new WebSocket(`ws://${host}:${port}`);
    ws.on('open', () => this._attach(ws, true));
    ws.on('error', (err) => this.emit('error', new Error(`Connection to ${host}:${port} failed: ${err.message}`)));
    return this;
  }

  // ------------------------------------------------------------- connection
  _attach(ws, isInitiator) {
    const session = new Session(ws);
    ws.on('message', (raw) => this._onMessage(session, raw));
    ws.on('close', () => {
      session.closed = true;
      this._onClose(session);
    });
    ws.on('error', (err) => this.emit('error', err));

    if (isInitiator) {
      this._send(session, MessageType.HELLO, {
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        deviceType: this.deviceType,
        publicKey: this.identity.publicKey,
      });
    }
  }

  _onClose(session) {
    if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
    if (session.remoteDeviceId) {
      if (this.sessions.get(session.remoteDeviceId) === session) {
        this.sessions.delete(session.remoteDeviceId);
      }
      const dev = this.store.getDevice(session.remoteDeviceId);
      if (dev) this.store.upsertDevice({ ...dev, status: 'offline' });
      this.emit('device-disconnected', session.remoteDeviceId);
    }
  }

   async _onMessage(session, raw) {
    let msg;
    try {
      msg = parseMessage(raw);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    // Any message from the peer proves it is alive. Without this, a
    // file transfer (or any long burst of traffic) can starve the PONG
    // replies and cause the desktop to time out and tear down the
    // session mid-transfer.
    session.lastPong = Date.now();

    try {
      await this._dispatch(session, msg);
    } catch (e) {
      try {
        this._send(session, MessageType.ERROR, { message: e.message, inResponseTo: msg.type });
      } catch (_) {}
      this.emit('error', e);
    }
  }

  _dispatch(session, msg) {
    switch (msg.type) {
      case MessageType.HELLO: return this._handleHello(session, msg);
      case MessageType.HELLO_ACK: return this._handleHelloAck(session, msg);
      case MessageType.PAIR_REQUEST: return this._handlePairRequest(session, msg);
      case MessageType.PAIR_ACCEPT: return this._handlePairAccept(session, msg);
      case MessageType.PAIR_REJECT: this.emit('pair-rejected', msg.payload); return;
      case MessageType.DEVICE_REVOKED: return this._handleDeviceRevoked(session);
      case MessageType.SESSION_RESUME: return this._handleSessionResume(session, msg);
      case MessageType.SESSION_RESUMED: return this._handleSessionResumed(session, msg);
      case MessageType.PING: return this._send(session, MessageType.PONG, {});
      case MessageType.PONG: session.lastPong = Date.now(); return;
      default: return this._handleSecureMessage(session, msg);
    }
  }

  // ------------------------------------------------------------ HELLO phase
  _handleHello(session, msg) {
    const { deviceId, deviceName, deviceType, publicKey } = msg.payload;
    session.remoteDeviceId = deviceId;
    session.remoteDeviceName = deviceName;
    session.remoteDeviceType = deviceType;
    session.remotePublicKey = publicKey;
    const previous = this.sessions.get(deviceId);
    if (previous && previous !== session && previous.heartbeat) {
      clearInterval(previous.heartbeat);
      previous.heartbeat = null;
    }
    this.sessions.set(deviceId, session);
    this._send(session, MessageType.HELLO_ACK, {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      deviceType: this.deviceType,
      publicKey: this.identity.publicKey,
    });
    this._afterHandshake(session);
  }

  _handleHelloAck(session, msg) {
    const { deviceId, deviceName, deviceType, publicKey } = msg.payload;
    session.remoteDeviceId = deviceId;
    session.remoteDeviceName = deviceName;
    session.remoteDeviceType = deviceType;
    session.remotePublicKey = publicKey;
    const previous = this.sessions.get(deviceId);
    if (previous && previous !== session && previous.heartbeat) {
      clearInterval(previous.heartbeat);
      previous.heartbeat = null;
    }
    this.sessions.set(deviceId, session);
    this._afterHandshake(session);
  }

  _afterHandshake(session) {
    const existing = this.store.getDevice(session.remoteDeviceId);
    this.store.upsertDevice({
      deviceId: session.remoteDeviceId,
      name: session.remoteDeviceName,
      type: session.remoteDeviceType,
      publicKey: session.remotePublicKey,
      status: 'online',
      trusted: existing ? existing.trusted : false,
    });
    if (existing && existing.trusted) {
      session.sessionKey = nexusCrypto.deriveSessionKey(this.identity.privateKey, session.remotePublicKey);
      session.trusted = true;
      this._startHeartbeat(session);
      this.emit('device-connected', { deviceId: session.remoteDeviceId, name: session.remoteDeviceName, trusted: true });
    } else {
      this.emit('device-discovered', { deviceId: session.remoteDeviceId, name: session.remoteDeviceName, trusted: false });
    }
  }

  // ----------------------------------------------------------------- pairing
  generatePairingCode() {
    const code = nexusCrypto.generatePairingCode();
    this.pendingPairingCodes.set(code, { expiresAt: Date.now() + 5 * 60_000 });
    return code;
  }

  requestPairing(remoteDeviceId, code, requestedPermissions = []) {
    const session = this.sessions.get(remoteDeviceId);
    if (!session) throw new Error(`Not connected to device ${remoteDeviceId}`);
    this._send(session, MessageType.PAIR_REQUEST, {
      code,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      publicKey: this.identity.publicKey,
      requestedPermissions,
    });
  }

  _handlePairRequest(session, msg) {
    const { code, requestedPermissions = [] } = msg.payload;
    const entry = this.pendingPairingCodes.get(code);
    const valid = entry && entry.expiresAt > Date.now();
    if (!valid) {
      this._send(session, MessageType.PAIR_REJECT, { reason: 'invalid_or_expired_code' });
      this.store.auditLog(session.remoteDeviceId, 'PAIR_REQUEST', 'REJECTED_BAD_CODE');
      return;
    }
    this.pendingPairingCodes.delete(code);
    session.sessionKey = nexusCrypto.deriveSessionKey(this.identity.privateKey, session.remotePublicKey);
    session.trusted = true;
    const defaultPerms = Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
    this.store.setPermissions(session.remoteDeviceId, defaultPerms);
    this.store.upsertDevice({
      deviceId: session.remoteDeviceId,
      trusted: true,
      status: 'online',
      requestedPermissions,
    });
    this._send(session, MessageType.PAIR_ACCEPT, {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      publicKey: this.identity.publicKey,
    });
    this.store.auditLog(session.remoteDeviceId, 'PAIR_REQUEST', 'ACCEPTED');
    this._startHeartbeat(session);
    this.emit('paired', { deviceId: session.remoteDeviceId, name: session.remoteDeviceName });
    this.emit('permission-request', {
      deviceId: session.remoteDeviceId,
      name: session.remoteDeviceName,
      deviceType: session.remoteDeviceType,
      requestedPermissions,
    });
  }

  _handlePairAccept(session) {
    session.sessionKey = nexusCrypto.deriveSessionKey(this.identity.privateKey, session.remotePublicKey);
    session.trusted = true;
    const defaultPerms = Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
    this.store.setPermissions(session.remoteDeviceId, defaultPerms);
    this.store.upsertDevice({ deviceId: session.remoteDeviceId, trusted: true, status: 'online' });
    this.store.auditLog(session.remoteDeviceId, 'PAIR_ACCEPT', 'OK');
    this._startHeartbeat(session);
    this.emit('paired', { deviceId: session.remoteDeviceId, name: session.remoteDeviceName });
  }

  setPermissions(deviceId, perms) { return this.store.setPermissions(deviceId, perms); }
  getPermissions(deviceId) { return this.store.getPermissions(deviceId); }

  revokeDevice(deviceId) {
    const existing = this.store.getDevice(deviceId);
    this.store.upsertDevice({ deviceId, trusted: false, status: existing ? existing.status : 'offline' });
    this.store.setPermissions(deviceId, Object.fromEntries(PERMISSIONS.map((p) => [p, false])));
    const session = this.sessions.get(deviceId);
    if (session) {
      session.trusted = false;
      session.sessionKey = null;
      if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
      try { this._send(session, MessageType.DEVICE_REVOKED, {}); } catch (_) {}
      session.ws.close();
    }
    this.store.auditLog(deviceId, 'DEVICE_REVOKED', 'SUCCESS');
    this.emit('device-revoked', { deviceId });
  }

  _handleSessionResume(session) {
    const existing = this.store.getDevice(session.remoteDeviceId);
    if (!existing || !existing.trusted) {
      this._send(session, MessageType.ERROR, {
        message: 'device_not_trusted_here',
        inResponseTo: MessageType.SESSION_RESUME,
      });
      return;
    }
    const previous = this.sessions.get(session.remoteDeviceId);
    if (previous && previous !== session && previous.heartbeat) {
      clearInterval(previous.heartbeat);
      previous.heartbeat = null;
    }
    session.sessionKey = nexusCrypto.deriveSessionKey(this.identity.privateKey, session.remotePublicKey);
    session.trusted = true;
    this._startHeartbeat(session);
    this._send(session, MessageType.SESSION_RESUMED, {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
    });
    this.store.auditLog(session.remoteDeviceId, 'SESSION_RESUME', 'ACCEPTED');
    this.emit('device-connected', {
      deviceId: session.remoteDeviceId,
      name: session.remoteDeviceName,
      trusted: true,
    });
  }

  _handleSessionResumed(session) {
    this.store.auditLog(session.remoteDeviceId, 'SESSION_RESUMED', 'OK');
  }

  _handleDeviceRevoked(session) {
    session.trusted = false;
    session.sessionKey = null;
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
    const existing = this.store.getDevice(session.remoteDeviceId);
    if (existing) this.store.upsertDevice({ ...existing, trusted: false });
    this.store.auditLog(session.remoteDeviceId, 'REVOKED_BY_PEER', 'OK');
    this.emit('revoked-by-peer', { deviceId: session.remoteDeviceId });
  }

  _startHeartbeat(session) {
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
    session.heartbeatClosed = false;
    session.lastPong = Date.now();
    session.heartbeat = setInterval(() => {
      if (session.heartbeatClosed) return;
      if (Date.now() - session.lastPong > HEARTBEAT_TIMEOUT_MS) {
        session.heartbeatClosed = true;
        this.emit('log', `Heartbeat timeout for ${session.remoteDeviceId}, closing`);
        clearInterval(session.heartbeat);
        session.heartbeat = null;
        try { session.ws.terminate(); } catch (_) {}
        return;
      }
      try { this._send(session, MessageType.PING, {}); } catch (_) {}
    }, HEARTBEAT_INTERVAL_MS);
  }

  // --------------------------------------------------------- secure sending
  _send(session, type, payload) {
    const msg = createMessage(type, payload, { source: this.deviceId, destination: session.remoteDeviceId });
    session.ws.send(JSON.stringify(msg));
  }

  _sendSecure(session, type, payload) {
    if (!session.sessionKey) throw new Error('No secure session established with this device yet');
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const enc = nexusCrypto.encrypt(session.sessionKey, plaintext);
    this._send(session, type, { enc });
  }

  _requirePermission(session, permission) {
    if (!this.store.isAllowed(session.remoteDeviceId, permission)) {
      this.store.auditLog(session.remoteDeviceId, `DENIED:${permission}`, 'BLOCKED');
      throw new Error(`Permission denied: ${session.remoteDeviceId} lacks ${permission}`);
    }
  }

  _handleSecureMessage(session, msg) {
    if (!session.trusted || !session.sessionKey) {
      throw new Error(`Rejected ${msg.type} from untrusted/unpaired device ${session.remoteDeviceId}`);
    }
       const decrypted = JSON.parse(nexusCrypto.decrypt(session.sessionKey, msg.payload.enc).toString('utf8'));
    console.log(`[nexus:dbg] received ${msg.type}`);

    switch (msg.type) {
      case MessageType.CLIPBOARD_UPDATE:
        this._requirePermission(session, 'CLIPBOARD_WRITE');
        this.emit('clipboard', { from: session.remoteDeviceId, text: decrypted.text });
        return;
      case MessageType.DEVICE_STATUS:
        this.emit('status', { from: session.remoteDeviceId, status: decrypted });
        return;
      case MessageType.NOTIFICATION:
        if (!this.store.isAllowed(session.remoteDeviceId, 'NOTIFICATIONS')) {
          this.store.auditLog(session.remoteDeviceId, 'DENIED:NOTIFICATIONS', 'BLOCKED');
          return;
        }
        this.emit('notification', { from: session.remoteDeviceId, notification: decrypted });
        return;
      case MessageType.COMMAND_REQUEST: return this._handleCommandRequest(session, decrypted);
      case MessageType.COMMAND_RESPONSE: return this._handleCommandResponse(decrypted);
      case MessageType.FILE_OFFER: return this._handleFileOffer(session, decrypted);
      case MessageType.FILE_ACCEPT: return this._handleFileAccept(session, decrypted);
      case MessageType.FILE_REJECT:
        this.emit('file-rejected', { from: session.remoteDeviceId, ...decrypted });
        return;
      case MessageType.FILE_CHUNK: return this._handleFileChunk(session, decrypted);
      case MessageType.FILE_CHUNK_ACK: return this._handleFileChunkAck(session, decrypted);
      case MessageType.FILE_COMPLETE: return this._handleFileComplete(session, decrypted);
      case MessageType.FILE_CANCEL:
        this.store.removeTransfer(decrypted.fileId);
        this.emit('file-cancelled', { from: session.remoteDeviceId, fileId: decrypted.fileId });
        return;
      case MessageType.ERROR:
        this.emit('peer-error', { from: session.remoteDeviceId, ...decrypted });
        return;
      default:
        throw new Error(`Unhandled secure message type: ${msg.type}`);
    }
  }

  sendClipboard(deviceId, text) {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error(`Not connected to ${deviceId}`);
    this._sendSecure(session, MessageType.CLIPBOARD_UPDATE, { text });
    this.store.auditLog(deviceId, 'CLIPBOARD_SEND', 'ATTEMPTED');
  }

  sendStatus(deviceId, status) {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    this._sendSecure(session, MessageType.DEVICE_STATUS, status);
  }

  broadcastStatus(status) {
    for (const session of this.sessions.values()) {
      if (session.trusted) this._sendSecure(session, MessageType.DEVICE_STATUS, status);
    }
  }

  sendNotification(deviceId, { app, title, body }) {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error(`Not connected to ${deviceId}`);
    this._sendSecure(session, MessageType.NOTIFICATION, { app, title, body });
  }

  sendCommand(deviceId, command, args = {}, { timeoutMs = 30_000 } = {}) {
    if (!ALLOWED_COMMANDS.includes(command)) return Promise.reject(new Error(`Unknown command: ${command}`));
    const session = this.sessions.get(deviceId);
    if (!session) return Promise.reject(new Error(`Not connected to ${deviceId}`));
    const commandId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommandRequests.delete(commandId);
        reject(new Error(`Command ${command} timed out waiting for a response from ${deviceId}`));
      }, timeoutMs);
      this.pendingCommandRequests.set(commandId, { resolve, reject, timeout });
      this._sendSecure(session, MessageType.COMMAND_REQUEST, { commandId, command, args });
      this.store.auditLog(deviceId, `COMMAND_REQUEST:${command}`, 'SENT');
    });
  }

  _handleCommandRequest(session, payload) {
    const { commandId, command, args } = payload;
    const respond = (result) => this._sendSecure(session, MessageType.COMMAND_RESPONSE, { commandId, ...result });
    if (!ALLOWED_COMMANDS.includes(command)) {
      this.store.auditLog(session.remoteDeviceId, `COMMAND:${command}`, 'REJECTED_UNKNOWN');
      return respond({ ok: false, message: `Unknown command: ${command}` });
    }
    if (!this.store.isAllowed(session.remoteDeviceId, 'REMOTE_CONTROL')) {
      this.store.auditLog(session.remoteDeviceId, `DENIED:REMOTE_CONTROL:${command}`, 'BLOCKED');
      return respond({ ok: false, message: 'Permission denied' });
    }
    if (COMMANDS_REQUIRING_CONFIRMATION.includes(command)) {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        respond({ ok: false, message: 'Timed out waiting for confirmation' });
        this.store.auditLog(session.remoteDeviceId, `COMMAND:${command}`, 'TIMED_OUT_UNCONFIRMED');
      }, 30_000);
      this.pendingCommands.set(commandId, { session, command, args, timeout });
      this.emit('command-confirmation-required', { commandId, command, args, from: session.remoteDeviceId });
      return;
    }
    this._executeCommand(command, args).then(respond);
    this.store.auditLog(session.remoteDeviceId, `COMMAND:${command}`, 'EXECUTED');
  }

  confirmCommand(commandId, approved) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommands.delete(commandId);
    const respond = (result) => this._sendSecure(pending.session, MessageType.COMMAND_RESPONSE, { commandId, ...result });
    if (!approved) {
      this.store.auditLog(pending.session.remoteDeviceId, `COMMAND:${pending.command}`, 'DENIED_BY_USER');
      return respond({ ok: false, message: 'Denied by user' });
    }
    this.store.auditLog(pending.session.remoteDeviceId, `COMMAND:${pending.command}`, 'CONFIRMED_AND_EXECUTED');
    this._executeCommand(pending.command, pending.args).then(respond);
  }

  async _executeCommand(command, args) {
    try { return await this.commandExecutor(command, args); }
    catch (e) { return { ok: false, message: e.message }; }
  }

  _handleCommandResponse(payload) {
    const { commandId, ok, message } = payload;
    const pending = this.pendingCommandRequests.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommandRequests.delete(commandId);
    pending.resolve({ ok, message });
  }

  // --------------------------------------------------------- file transfer
  async sendFile(deviceId, filePath, { fileId } = {}) {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error(`Not connected to ${deviceId}`);
    const stat = fs.statSync(filePath);
    const totalChunks = Math.ceil(stat.size / CHUNK_SIZE);
    const checksum = await sha256File(filePath);
    fileId = fileId || crypto.randomUUID();
    const transfer = this.store.upsertTransfer(fileId, {
      fileId, direction: 'send', filePath,
      fileName: path.basename(filePath),
      fileSize: stat.size, totalChunks, checksum, deviceId,
      sentChunks: 0, status: 'offering',
    });
    session.outgoingTransfers = session.outgoingTransfers || new Map();
    session.outgoingTransfers.set(fileId, transfer);
    this._sendSecure(session, MessageType.FILE_OFFER, {
      fileId, fileName: transfer.fileName, fileSize: stat.size, totalChunks, checksum,
    });
  }

  /**
   * Called by the desktop agent when a file offer comes in. If
   * this.autoAcceptFiles is true (the default), the offer is accepted
   * immediately with a path derived from fileName under receivedDir.
   * If false, the offer is queued and the caller must call
   * acceptFileOffer() or rejectFileOffer() explicitly.
   */
  _handleFileOffer(session, payload) {
    const { fileId, fileName, fileSize, totalChunks, checksum } = payload;

    if (!this.store.isAllowed(session.remoteDeviceId, 'FILE_RECEIVE')) {
      this.store.auditLog(session.remoteDeviceId, 'DENIED:FILE_RECEIVE', 'BLOCKED');
      this._sendSecure(session, MessageType.FILE_REJECT, { fileId, reason: 'permission_denied' });
      this.emit('file-offer-rejected', { from: session.remoteDeviceId, fileId, fileName });
      return;
    }

    const existing = this.store.getTransfer(fileId);
    const startChunk = existing && existing.direction === 'receive' ? existing.receivedChunks : 0;
    const tmpPath = path.join(this.receivedDir, `${fileId}.part`);
    if (!existing) fs.closeSync(fs.openSync(tmpPath, 'a'));

    // Default final path (used if the user doesn't override it).
    const defaultFinalPath = uniquePath(path.join(this.receivedDir, sanitizeFileName(fileName)));

    this.store.upsertTransfer(fileId, {
      fileId, direction: 'receive', fileName, fileSize, totalChunks, checksum,
      deviceId: session.remoteDeviceId, receivedChunks: startChunk, tmpPath,
      finalPath: null,
      status: 'pending_accept',
    });

    if (this.autoAcceptFiles) {
      // Immediate accept, same as the old behavior. Used by tests and by
      // any non-interactive caller.
      this._acceptFileOfferInternal(session, fileId, { startChunk, finalPath: defaultFinalPath });
      return;
    }

    // Queue for human approval.
    this.pendingFileOffers.set(fileId, {
      session,
      fileId,
      from: session.remoteDeviceId,
      fromName: session.remoteDeviceName,
      fileName,
      fileSize,
      totalChunks,
      checksum,
      startChunk,
      tmpPath,
      defaultFinalPath,
    });
    this.emit('file-offer-pending', {
      fileId,
      from: session.remoteDeviceId,
      fromName: session.remoteDeviceName,
      fileName,
      fileSize,
      totalChunks,
      defaultFinalPath,
    });
    this.store.auditLog(session.remoteDeviceId, 'FILE_OFFER', `PENDING:${fileName}`);
  }

  /** Called by the UI to accept a queued offer. */
  acceptFileOffer(fileId, { finalPath } = {}) {
    const pending = this.pendingFileOffers.get(fileId);
    if (!pending) return false;
    this.pendingFileOffers.delete(fileId);
    const chosenPath = finalPath
      ? uniquePathIfExists(finalPath)
      : pending.defaultFinalPath;
    this._acceptFileOfferInternal(pending.session, fileId, {
      startChunk: pending.startChunk,
      finalPath: chosenPath,
    });
    return true;
  }

  /** Called by the UI to reject a queued offer. */
  rejectFileOffer(fileId, { reason = 'rejected_by_user' } = {}) {
    const pending = this.pendingFileOffers.get(fileId);
    if (!pending) return false;
    this.pendingFileOffers.delete(fileId);
    try {
      this._sendSecure(pending.session, MessageType.FILE_REJECT, { fileId, reason });
    } catch (_) {}
    this.store.removeTransfer(fileId);
    this.store.auditLog(pending.from, 'FILE_OFFER', `REJECTED:${pending.fileName}`);
    this.emit('file-offer-rejected', { from: pending.from, fileId, fileName: pending.fileName, reason });
    return true;
  }

  _acceptFileOfferInternal(session, fileId, { startChunk, finalPath }) {
    this.store.upsertTransfer(fileId, {
      finalPath,
      status: 'receiving',
    });
    this._sendSecure(session, MessageType.FILE_ACCEPT, { fileId, startChunk });
    this.store.auditLog(session.remoteDeviceId, 'FILE_OFFER', `ACCEPTED:${fileId}`);
    this.emit('file-offer-accepted', {
      from: session.remoteDeviceId, fileId, finalPath,
    });
  }

  async _handleFileAccept(session, payload) {
    const { fileId, startChunk } = payload;
    const transfer = this.store.getTransfer(fileId);
    if (!transfer) throw new Error(`No such outgoing transfer: ${fileId}`);
    const fh = fs.openSync(transfer.filePath, 'r');
    try {
      for (let i = startChunk; i < transfer.totalChunks; i++) {
        if (session.closed || session.ws.readyState !== WebSocket.OPEN) {
          this.store.upsertTransfer(fileId, { status: 'interrupted' });
          this.emit('file-interrupted', { fileId, deviceId: session.remoteDeviceId, atChunk: i });
          throw new Error(`Connection to ${session.remoteDeviceId} lost during file transfer (stopped before chunk ${i}/${transfer.totalChunks})`);
        }
        const buf = Buffer.alloc(Math.min(CHUNK_SIZE, transfer.fileSize - i * CHUNK_SIZE));
        fs.readSync(fh, buf, 0, buf.length, i * CHUNK_SIZE);
        const chunkChecksum = crypto.createHash('sha256').update(buf).digest('hex');
        this._sendSecure(session, MessageType.FILE_CHUNK, {
          fileId, chunkIndex: i, totalChunks: transfer.totalChunks,
          checksum: chunkChecksum, data: buf.toString('base64'),
        });
        this.store.upsertTransfer(fileId, { sentChunks: i + 1, status: 'sending' });
        this.emit('file-progress', { fileId, direction: 'send', chunkIndex: i, totalChunks: transfer.totalChunks });
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (session.ws.bufferedAmount > 8 * CHUNK_SIZE) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      fs.closeSync(fh);
    }
    this._sendSecure(session, MessageType.FILE_COMPLETE, { fileId, checksum: transfer.checksum });
    this.store.upsertTransfer(fileId, { status: 'sent' });
    this.store.auditLog(session.remoteDeviceId, 'FILE_TRANSFER', `SENT:${transfer.fileName}`);
    this.emit('file-sent', { fileId, deviceId: session.remoteDeviceId });
  }

    _handleFileChunk(session, payload) {
    console.log(`[nexus:dbg] _handleFileChunk fileId=${payload.fileId ? payload.fileId.slice(0,8) : 'NONE'} chunk=${payload.chunkIndex}/${payload.totalChunks}`);
    const { fileId, chunkIndex, totalChunks, checksum, data } = payload;
    const transfer = this.store.getTransfer(fileId);
    if (!transfer) throw new Error(`No such incoming transfer: ${fileId}`);
    const buf = Buffer.from(data, 'base64');
    const actualChecksum = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualChecksum !== checksum) {
      this._sendSecure(session, MessageType.FILE_CHUNK_ACK, { fileId, chunkIndex, ok: false });
      this.emit('file-chunk-corrupt', { fileId, chunkIndex });
      return;
    }
    const fh = fs.openSync(transfer.tmpPath, 'r+');
    fs.writeSync(fh, buf, 0, buf.length, chunkIndex * CHUNK_SIZE);
    fs.closeSync(fh);
    this.store.upsertTransfer(fileId, { receivedChunks: chunkIndex + 1 });
    this._sendSecure(session, MessageType.FILE_CHUNK_ACK, { fileId, chunkIndex, ok: true });
    this.emit('file-progress', { fileId, direction: 'receive', chunkIndex, totalChunks });
  }

  _handleFileChunkAck(session, payload) {
    this.emit('file-chunk-ack', { fileId: payload.fileId, chunkIndex: payload.chunkIndex, ok: payload.ok });
  }

  async _handleFileComplete(session, payload) {
    const { fileId, checksum } = payload;
    const transfer = this.store.getTransfer(fileId);
    if (!transfer) throw new Error(`No such incoming transfer: ${fileId}`);
    const actual = await sha256File(transfer.tmpPath);
    const finalPath = transfer.finalPath || path.join(this.receivedDir, sanitizeFileName(transfer.fileName));
    if (actual !== checksum) {
      this.store.upsertTransfer(fileId, { status: 'checksum_failed' });
      this.store.auditLog(session.remoteDeviceId, 'FILE_TRANSFER', `CHECKSUM_MISMATCH:${transfer.fileName}`);
      this.emit('file-error', { fileId, reason: 'checksum_mismatch' });
      return;
    }
    // Ensure parent directory exists (the user may have picked a folder
    // that we are about to write into for the first time).
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.renameSync(transfer.tmpPath, finalPath);
    this.store.upsertTransfer(fileId, { status: 'complete', finalPath });
    this.store.auditLog(session.remoteDeviceId, 'FILE_TRANSFER', `RECEIVED:${transfer.fileName}`);
    this.emit('file-received', { fileId, fileName: transfer.fileName, path: finalPath, from: session.remoteDeviceId });
  }

  close() {
    for (const session of this.sessions.values()) {
      if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
      session.ws.close();
    }
    for (const pending of this.pendingCommands.values()) clearTimeout(pending.timeout);
    for (const pending of this.pendingCommandRequests.values()) clearTimeout(pending.timeout);
    this.pendingCommands.clear();
    this.pendingCommandRequests.clear();
    this.pendingFileOffers.clear();
    if (this._server) this._server.close();
  }
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.remoteDeviceId = null;
    this.remoteDeviceName = null;
    this.remoteDeviceType = null;
    this.remotePublicKey = null;
    this.sessionKey = null;
    this.trusted = false;
    this.closed = false;
    this.heartbeat = null;
    this.heartbeatClosed = false;
    this.lastPong = Date.now();
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sanitizeFileName(name) {
  // Strip path separators and control characters. The user-supplied name
  // comes over the wire and could be adversarial.
  return String(name).replace(/[\/\\\x00-\x1f]/g, '_').replace(/^\.+/, '_') || 'file';
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return p;
}

function uniquePathIfExists(p) {
  // For user-chosen paths we ask for confirmation via the Electron save
  // dialog, which already handles overwrite prompts. So we just return
  // what the user chose. Kept as a separate function for clarity.
  return p;
}

module.exports = { NexusNode };