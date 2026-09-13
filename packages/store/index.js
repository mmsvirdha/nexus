/**
 * NEXUS Store
 * -----------
 * A tiny JSON-file-backed persistence layer so the MVP has zero native
 * build dependencies (no better-sqlite3 compilation step required).
 *
 * The schema mirrors the SQLite tables described in the project design
 * doc (devices / permissions / transfers / events / audit_logs), so
 * swapping this module for a real SQLite-backed one later is a drop-in
 * change — every method here keeps the same signature.
 */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      devices: {},       // deviceId -> { deviceId, name, type, publicKey, status, lastSeen, createdAt }
      permissions: {},   // deviceId -> { PERM: true/false }
      transfers: {},     // fileId -> { ...transfer state, receivedChunks: [bool] }
      events: [],        // { id, deviceId, eventType, payload, timestamp }
      auditLogs: [],      // { id, deviceId, action, result, timestamp }
    };
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch (e) {
        console.error('[store] failed to parse existing store file, starting fresh:', e.message);
      }
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ---- devices ----
  upsertDevice(device) {
    const existing = this.data.devices[device.deviceId] || {};
    this.data.devices[device.deviceId] = {
      createdAt: existing.createdAt || new Date().toISOString(),
      ...existing,
      ...device,
      lastSeen: new Date().toISOString(),
    };
    this._save();
    return this.data.devices[device.deviceId];
  }
  getDevice(deviceId) {
    return this.data.devices[deviceId] || null;
  }
  listDevices() {
    return Object.values(this.data.devices);
  }
  removeDevice(deviceId) {
    delete this.data.devices[deviceId];
    delete this.data.permissions[deviceId];
    this._save();
  }

  // ---- permissions ----
  setPermissions(deviceId, perms) {
    this.data.permissions[deviceId] = { ...(this.data.permissions[deviceId] || {}), ...perms };
    this._save();
    return this.data.permissions[deviceId];
  }
  getPermissions(deviceId) {
    return this.data.permissions[deviceId] || {};
  }
  isAllowed(deviceId, permission) {
    return Boolean(this.data.permissions[deviceId] && this.data.permissions[deviceId][permission]);
  }

  // ---- transfers ----
  upsertTransfer(fileId, transfer) {
    this.data.transfers[fileId] = { ...(this.data.transfers[fileId] || {}), ...transfer };
    this._save();
    return this.data.transfers[fileId];
  }
  getTransfer(fileId) {
    return this.data.transfers[fileId] || null;
  }
  removeTransfer(fileId) {
    delete this.data.transfers[fileId];
    this._save();
  }

  // ---- events + audit ----
  logEvent(deviceId, eventType, payload = {}) {
    this.data.events.push({ id: this.data.events.length + 1, deviceId, eventType, payload, timestamp: new Date().toISOString() });
    if (this.data.events.length > 5000) this.data.events.shift(); // simple cap
    this._save();
  }
  auditLog(deviceId, action, result) {
    const entry = { id: this.data.auditLogs.length + 1, deviceId, action, result, timestamp: new Date().toISOString() };
    this.data.auditLogs.push(entry);
    if (this.data.auditLogs.length > 5000) this.data.auditLogs.shift();
    this._save();
    return entry;
  }
  recentAuditLogs(n = 50) {
    return this.data.auditLogs.slice(-n).reverse();
  }
}

module.exports = { Store };
