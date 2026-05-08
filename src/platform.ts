import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerAccessory } from './airConditionerAccessory';
import { AirEnvironmentSensorAccessory } from './airEnvironmentSensorAccessory';
import { AirPurifierAccessory } from './airPurifierAccessory';
import { ContactSensorAccessory } from './contactSensorAccessory';
import { DoorLockAccessory } from './doorLockAccessory';
import { LightingAccessory } from './lightingAccessory';
import { ShutterAccessory } from './shutterAccessory';
import { SmokeSensorAccessory } from './smokeSensorAccessory';
import { Aiseg2Client } from './aiseg2Client';
import { LightingDevice, SupportedDevice, SupportedDeviceKind } from './devices';


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
    await this.discoverContactSensors();
    await this.discoverSmokeSensors();
    await this.discoverAirConditioners();
    await this.discoverAirEnvironmentSensors();
    await this.discoverShutters();
    await this.discoverAirPurifiers();
    await this.discoverDoorLocks();
  }

  provisionDevice(device: SupportedDevice) {
    const uuid = this.api.hap.uuid.generate(device.uuidSeed);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    const homeKitName = this.formatHomeKitName(device.displayName);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      existingAccessory.context.device = device;
      existingAccessory.context.kind = device.kind;
      if (existingAccessory.displayName !== homeKitName) {
        existingAccessory.updateDisplayName(homeKitName);
      }
      this.api.updatePlatformAccessories([existingAccessory]);

      this.createAccessoryHandler(device.kind, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(homeKitName, uuid);
      accessory.context.device = device;
      accessory.context.kind = device.kind;
      this.createAccessoryHandler(device.kind, accessory);
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

  async discoverContactSensors(): Promise<void> {
    this.log.debug('Fetching contact sensors from AiSEG2');
    const devices = await this.client.getContactSensorDevices();

    for (const device of devices) {
      this.log.info(`Discovered contact sensor '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverSmokeSensors(): Promise<void> {
    this.log.debug('Fetching smoke sensors from AiSEG2');
    const devices = await this.client.getSmokeSensorDevices();

    for (const device of devices) {
      this.log.info(`Discovered smoke sensor '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverAirConditioners(): Promise<void> {
    this.log.debug('Fetching air conditioners from AiSEG2');
    const devices = await this.client.getAirConditionerDevices();

    for (const device of devices) {
      this.log.info(`Discovered air conditioner '${device.displayName}'`);
      const status = await this.client.getAirConditionerStatus(device);
      device.state = status.state;
      device.mode = status.mode;
      device.currentTemperature = status.currentTemperature;
      device.targetTemperature = status.targetTemperature;
      device.currentHumidity = status.currentHumidity;
      device.outdoorTemperature = status.outdoorTemperature;
      this.provisionDevice(device);
    }
  }

  async discoverShutters(): Promise<void> {
    this.log.debug('Fetching shutters from AiSEG2');
    const devices = await this.client.getShutterDevices();

    for (const device of devices) {
      this.log.info(`Discovered shutter '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverAirPurifiers(): Promise<void> {
    this.log.debug('Fetching air purifiers from AiSEG2');
    const devices = await this.client.getAirPurifierDevices();

    for (const device of devices) {
      this.log.info(`Discovered air purifier '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverAirEnvironmentSensors(): Promise<void> {
    this.log.debug('Fetching air environment sensors from AiSEG2');
    const devices = await this.client.getAirEnvironmentSensorDevices();

    for (const device of devices) {
      this.log.info(`Discovered air environment sensor '${device.displayName}'`);
      const status = await this.client.getAirEnvironmentStatus(device, true);
      device.temperature = status.temperature;
      device.humidity = status.humidity;
      this.provisionDevice(device);
    }
  }

  async discoverDoorLocks(): Promise<void> {
    this.log.debug('Fetching door locks from AiSEG2');
    const devices = await this.client.getDoorLockDevices();

    for (const device of devices) {
      this.log.info(`Discovered door lock '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  private createAccessoryHandler(kind: SupportedDeviceKind, accessory: PlatformAccessory): void {
    switch (kind) {
      case 'lighting':
        new LightingAccessory(this, accessory);
        break;
      case 'contactSensor':
        new ContactSensorAccessory(this, accessory);
        break;
      case 'smokeSensor':
        new SmokeSensorAccessory(this, accessory);
        break;
      case 'airConditioner':
        new AirConditionerAccessory(this, accessory);
        break;
      case 'airEnvironmentSensor':
        new AirEnvironmentSensorAccessory(this, accessory);
        break;
      case 'shutter':
        new ShutterAccessory(this, accessory);
        break;
      case 'airPurifier':
        new AirPurifierAccessory(this, accessory);
        break;
      case 'doorLock':
        new DoorLockAccessory(this, accessory);
        break;
      default:
        this.log.warn(`No HomeKit handler registered for AiSEG2 device kind '${kind}'`);
        break;
    }
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

    return sanitizedName || 'AiSEG2 Device';
  }
}
