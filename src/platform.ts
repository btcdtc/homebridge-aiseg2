import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LightingDevice, LightingAccessory } from './lightingAccessory';
import { Aiseg2Client } from './aiseg2Client';


export class Aiseg2Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly client: Aiseg2Client;

  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.client = new Aiseg2Client(String(this.config.host || ''), String(this.config.password || ''));
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices().catch(error => {
        this.log.error(`Failed to discover AiSEG2 devices: ${this.formatError(error)}`);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  // Discover the various AiSEG2 device types that are compatible with Homekit
  async discoverDevices(): Promise<void> {
    await this.discoverLighting();
  }

  provisionDevice(device: LightingDevice) {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    const homeKitName = this.formatHomeKitName(device.displayName);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      existingAccessory.context.device = device;
      if (existingAccessory.displayName !== homeKitName) {
        existingAccessory.updateDisplayName(homeKitName);
      }
      this.api.updatePlatformAccessories([existingAccessory]);

      new LightingAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(homeKitName, uuid);
      accessory.context.device = device;
      new LightingAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
  }

  // Fetch all lighting devices from the AiSEG2 controller
  async discoverLighting(): Promise<void> {
    this.log.debug('Fetching lighting devices from AiSEG2');
    const devices = await this.client.getLightingDevices();

    for (const device of devices) {
      this.log.info(`Discovered lighting device '${device.displayName}'`);
      this.log.debug(JSON.stringify(device));

      try {
        await this.provisionLightingDevices(device);
      } catch (error) {
        this.log.error(`Failed to provision lighting device '${device.displayName}': ${this.formatError(error)}`);
      }
    }
  }

  // Provision a lighting device in Homebridge
  async provisionLightingDevices(deviceData: LightingDevice): Promise<void> {
    this.log.debug(`Fetching lighting device details for '${deviceData.displayName}'`);
    const status = await this.client.getLightingStatus(deviceData);

    deviceData.state = status.state ? 'on' : 'off';
    deviceData.dimmable = status.dimmable;
    deviceData.brightness = status.brightness;

    this.log.debug(`Device data: ${JSON.stringify(deviceData)}`);
    this.provisionDevice(deviceData);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  public formatHomeKitName(name: string): string {
    const sanitizedName = name
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

    return sanitizedName || 'AiSEG2 Light';
  }
}
