void (async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      this.onRequest('/door-locks', this.handleDoorLocks.bind(this));
      this.onRequest('/ecocutes', this.handleEcocutes.bind(this));
      this.onRequest('/webhook-token', this.handleWebhookToken.bind(this));
      this.onRequest('/local-address', this.handleLocalAddress.bind(this));
      this.ready();
    }

    async handleDoorLocks(payload) {
      try {
        const devices = await this.discoverNamedDevices(payload, client => client.getDoorLockDevices(), 'door locks');
        return {
          doorLocks: devices.devices,
          warning: devices.warning,
        };
      } catch (error) {
        return {
          doorLocks: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    async handleEcocutes(payload) {
      try {
        const devices = await this.discoverNamedDevices(payload, client => client.getEcocuteDevices(), 'EcoCute devices');
        return {
          ecocutes: devices.devices,
          warning: devices.warning,
        };
      } catch (error) {
        return {
          ecocutes: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    async handleWebhookToken(payload) {
      const config = payload && payload.config ? payload.config : {};
      const configuredToken = this.normalizeToken(config.webhook && config.webhook.token);
      if (configuredToken) {
        return { token: configuredToken };
      }

      try {
        const secretPath = path.join(this.homebridgeStoragePath, 'aiseg2-webhook.json');
        if (!fs.existsSync(secretPath)) {
          return { token: '' };
        }

        const file = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
        return { token: this.normalizeToken(file.token) };
      } catch (error) {
        return {
          token: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    async handleLocalAddress() {
      return { address: this.localIpv4Address() || '' };
    }

    async resolveHost(config) {
      const configuredHost = String(config.host || '').trim();
      if (configuredHost) {
        return configuredHost;
      }

      if (!config.autodiscover) {
        return '';
      }

      const { discoverAiseg2Controller } = require('../dist/aiseg2Discovery');
      const result = await discoverAiseg2Controller(String(config.password || ''));
      return result.host;
    }

    async discoverNamedDevices(payload, loader, label) {
      const config = payload && payload.config ? payload.config : {};
      const { Aiseg2Client } = require('../dist/aiseg2Client');
      const host = await this.resolveHost(config);
      const password = String(config.password || '');

      if (!host || !password) {
        return {
          devices: [],
          warning: `AiSEG2 host and password are required to discover ${label}.`,
        };
      }

      const client = new Aiseg2Client(host, password);
      const devices = await loader(client);
      return {
        devices: devices.map(device => ({
          name: device.displayName,
          nodeId: device.nodeId,
          eoj: device.eoj,
        })),
      };
    }

    normalizeToken(token) {
      return String(token || '').trim().replace(/^\/?api\/webhook\//u, '');
    }

    localIpv4Address() {
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal) {
            return address.address;
          }
        }
      }

      return undefined;
    }
  }

  return new UiServer();
})();
