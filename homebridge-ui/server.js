void (async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      this.deviceGroups = {
        doorLocks: {
          legacyKey: 'doorLocks',
          label: 'door locks',
          load: client => client.getDoorLockDevices(),
        },
        ecocutes: {
          legacyKey: 'ecocutes',
          label: 'EcoCute devices',
          load: client => client.getEcocuteDevices(),
        },
      };

      this.onRequest('/devices', this.handleDevices.bind(this));
      this.onRequest('/door-locks', payload => this.handleLegacyDeviceGroup(payload, 'doorLocks'));
      this.onRequest('/ecocutes', payload => this.handleLegacyDeviceGroup(payload, 'ecocutes'));
      this.onRequest('/webhook-token', this.handleWebhookToken.bind(this));
      this.onRequest('/local-address', this.handleLocalAddress.bind(this));
      this.ready();
    }

    async handleDevices(payload) {
      return this.discoverDeviceGroups(payload, this.requestedDeviceGroups(payload));
    }

    async handleLegacyDeviceGroup(payload, group) {
      const key = this.deviceGroups[group].legacyKey;
      const result = await this.discoverDeviceGroups(payload, [group]);
      return {
        [key]: result[group] || [],
        warning: result.warnings && result.warnings[group],
        error: result.errors && result.errors[group],
      };
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
          error: this.formatError(error),
        };
      }
    }

    async handleLocalAddress() {
      return { address: this.localIpv4Address() || '' };
    }

    async discoverDeviceGroups(payload, groups) {
      const config = payload && payload.config ? payload.config : {};
      const client = await this.clientFromConfig(config);
      const output = {
        warnings: {},
        errors: {},
      };

      if (!client) {
        for (const group of groups) {
          output[group] = [];
          output.warnings[group] = `AiSEG2 host and password are required to discover ${this.deviceGroups[group].label}.`;
        }
        return output;
      }

      await Promise.all(groups.map(async group => {
        try {
          const devices = await this.deviceGroups[group].load(client);
          output[group] = devices.map(device => ({
            name: device.displayName,
            nodeId: device.nodeId,
            eoj: device.eoj,
          }));
        } catch (error) {
          output[group] = [];
          output.errors[group] = this.formatError(error);
        }
      }));

      return output;
    }

    requestedDeviceGroups(payload) {
      const groups = Array.isArray(payload && payload.groups)
        ? payload.groups
        : Object.keys(this.deviceGroups);

      return groups.filter(group => Object.prototype.hasOwnProperty.call(this.deviceGroups, group));
    }

    async clientFromConfig(config) {
      const { Aiseg2Client } = require('../dist/aiseg2Client');
      const host = await this.resolveHost(config);
      const password = String(config.password || '');

      return host && password ? new Aiseg2Client(host, password) : undefined;
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

    formatError(error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  return new UiServer();
})();
