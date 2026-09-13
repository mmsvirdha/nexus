/**
 * Minimal EventEmitter for React Native.
 *
 * React Native does not ship Node's `events` module. The subset we use is
 * on/once/off/emit — that's what this implements. It is intentionally
 * small: no `removeAllListeners`, no `prependListener`, no error-event
 * special-casing, because none of that is used by NexusClient.
 */
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push({ fn, once: false });
    return this;
  }
  once(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push({ fn, once: true });
    return this;
  }
  off(event, fn) {
    const arr = this._listeners.get(event);
    if (!arr) return this;
    const idx = arr.findIndex((e) => e.fn === fn);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }
  emit(event, payload) {
    const arr = this._listeners.get(event);
    if (!arr || arr.length === 0) return false;
    // Copy before iterating: a listener may call off() during dispatch.
    for (const entry of arr.slice()) {
      try {
        entry.fn(payload);
      } catch (e) {
        // Swallow listener errors — one bad listener must not break the
        // others. This matches Node's behavior when no 'error' listener
        // is attached... except Node rethrows for 'error'; we don't,
        // because our consumer already logs via an 'error' handler.
        console.warn(`[nexus] listener for "${event}" threw:`, e && e.message);
      }
      if (entry.once) this.off(event, entry.fn);
    }
    return true;
  }
}