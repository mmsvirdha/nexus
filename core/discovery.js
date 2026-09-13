/**
 * NEXUS Discovery
 * ---------------
 * Advertises this device on the LAN and browses for peers, using mDNS
 * (via `bonjour-service`) so devices don't need to type IP addresses.
 *
 * If mDNS is unavailable (blocked network, container without multicast,
 * corporate Wi-Fi that filters it, etc.) this degrades gracefully:
 * `advertise()`/`browse()` just log a warning and do nothing, and the
 * caller can fall back to manual host:port entry (see mobile-simulator).
 */

const EventEmitter = require('events');

const SERVICE_TYPE = 'nexus';

class Discovery extends EventEmitter {
  constructor({ deviceId, deviceName, deviceType, port }) {
    super();
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.deviceType = deviceType;
    this.port = port;
    this.bonjour = null;
    this.publishedService = null;
    this.browser = null;
  }

  _getBonjour() {
    if (this.bonjour) return this.bonjour;
    try {
      const { Bonjour } = require('bonjour-service');
      this.bonjour = new Bonjour();
      return this.bonjour;
    } catch (e) {
      this.emit('warning', `mDNS unavailable (${e.message}); falling back to manual connection only.`);
      return null;
    }
  }

  advertise() {
    const bonjour = this._getBonjour();
    if (!bonjour) return this;
    this.publishedService = bonjour.publish({
      name: `${this.deviceName} (${this.deviceId})`,
      type: SERVICE_TYPE,
      port: this.port,
      txt: {
        deviceId: this.deviceId,
        deviceType: this.deviceType,
        protocolVersion: '1',
      },
    });
    this.emit('advertising', { name: this.deviceName, port: this.port });
    return this;
  }

  browse() {
    const bonjour = this._getBonjour();
    if (!bonjour) return this;
    this.browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
      if (service.txt && service.txt.deviceId === this.deviceId) return; // ignore ourselves
      this.emit('found', {
        deviceId: service.txt && service.txt.deviceId,
        deviceType: service.txt && service.txt.deviceType,
        name: service.name,
        host: service.host,
        addresses: service.addresses,
        port: service.port,
      });
    });
    return this;
  }

  stop() {
    if (this.publishedService) this.publishedService.stop();
    if (this.bonjour) this.bonjour.destroy();
  }
}

module.exports = { Discovery, SERVICE_TYPE };
