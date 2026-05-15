import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
  Service,
  Characteristic,
  Categories,
  APIEvent,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings';
import { discoverAiseg2Controller, localDiscoverySubnets } from './aiseg2Discovery';
import { discoverEchonetLiteNodes, localEchonetLiteSubnets } from './echonetLiteDiscovery';
import { AirConditionerAccessory } from './airConditionerAccessory';
import { AirEnvironmentSensorAccessory } from './airEnvironmentSensorAccessory';
import { AirPurifierAccessory } from './airPurifierAccessory';
import { ContactSensorAccessory } from './contactSensorAccessory';
import { DoorLockAccessory } from './doorLockAccessory';
import { EcocuteAccessory } from './ecocuteAccessory';
import { LightingAccessory } from './lightingAccessory';
import { ShutterAccessory } from './shutterAccessory';
import { SmokeSensorAccessory } from './smokeSensorAccessory';
import { Aiseg2Client } from './aiseg2Client';
import { LightingDevice, SupportedDevice, SupportedDeviceKind } from './devices';


export class Aiseg2Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public client!: Aiseg2Client;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly intervalHandles = new Set<ReturnType<typeof setInterval>>();
  private discoveredAccessoryUUIDs = new Set<string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices().catch(error => {
        this.log.error(`Failed to discover AiSEG2 devices: ${this.formatError(error)}`);
      });
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.configureIdentify(accessory);
    this.accessories.push(accessory);
  }

  // Discover the various AiSEG2 device types that are compatible with Homekit
  async discoverDevices(): Promise<void> {
    await this.resolveClient();
    await this.discoverEchonetLiteDevices();
    this.discoveredAccessoryUUIDs = new Set<string>();
    await this.discoverLighting();
    await this.discoverContactSensors();
    await this.discoverSmokeSensors();
    await this.discoverAirConditioners();
    await this.discoverAirEnvironmentSensors();
    await this.discoverShutters();
    await this.discoverAirPurifiers();
    await this.discoverEcocutes();
    await this.discoverDoorLocks();
    this.unregisterStaleAccessories();
  }

  provisionDevice(device: SupportedDevice) {
    const uuid = this.markDeviceSeen(device);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    const homeKitName = this.formatHomeKitName(device.displayName);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      existingAccessory.context.device = device;
      existingAccessory.context.kind = device.kind;
      existingAccessory.category = this.categoryForDevice(device.kind);
      this.configureIdentify(existingAccessory);
      if (existingAccessory.displayName !== homeKitName) {
        existingAccessory.updateDisplayName(homeKitName);
      }
      this.api.updatePlatformAccessories([existingAccessory]);

      this.createAccessoryHandler(device.kind, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(homeKitName, uuid, this.categoryForDevice(device.kind));
      accessory.context.device = device;
      accessory.context.kind = device.kind;
      this.configureIdentify(accessory);
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
      this.markDeviceSeen(device);
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
      this.markDeviceSeen(device);
      this.log.info(`Discovered contact sensor '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverSmokeSensors(): Promise<void> {
    this.log.debug('Fetching smoke sensors from AiSEG2');
    const devices = await this.client.getSmokeSensorDevices();

    for (const device of devices) {
      this.markDeviceSeen(device);
      this.log.info(`Discovered smoke sensor '${device.displayName}'`);
      this.provisionDevice(device);
    }
  }

  async discoverAirConditioners(): Promise<void> {
    this.log.debug('Fetching air conditioners from AiSEG2');
    const devices = await this.client.getAirConditionerDevices();

    for (const device of devices) {
      this.markDeviceSeen(device);
      this.log.info(`Discovered air conditioner '${device.displayName}'`);
      const capabilities = await this.client.getAirConditionerCapabilities(device);
      const status = await this.client.getAirConditionerStatus(device, true);
      device.state = status.state;
      device.mode = status.mode;
      device.modeLabel = status.modeLabel;
      device.fanMode = status.fanMode || capabilities.currentFanMode;
      device.fanModeLabel = status.fanModeLabel;
      device.currentTemperature = status.currentTemperature;
      device.targetTemperature = status.targetTemperature ?? capabilities.targetTemperature;
      device.currentHumidity = status.currentHumidity;
      device.outdoorTemperature = status.outdoorTemperature;
      device.minTemperature = capabilities.minTemperature;
      device.maxTemperature = capabilities.maxTemperature;
      device.availableModes = capabilities.modes;
      device.availableFanModes = capabilities.fanModes;
      this.provisionDevice(device);
    }
  }

  async discoverShutters(): Promise<void> {
    this.log.debug('Fetching shutters from AiSEG2');
    const devices = await this.client.getShutterDevices();

    for (const device of devices) {
      this.markDeviceSeen(device);
      this.log.info(`Discovered shutter '${device.displayName}'`);
      const endpoint = this.client.echonetEndpointForShutter(device);
      if (endpoint) {
        this.log.info(`ECHONET mapped shutter '${device.displayName}' -> ${endpoint.host}/${endpoint.eoj}`);
        if (this.client.supportsShutterHalfOpen(device) && !this.client.echonetSupportsShutterPosition(device)) {
          const timedPositionNote = this.client.echonetSupportsTimedShutterPosition(device)
            ? ' It exposes timed movement properties (0xd2/0xe9), but not exact position control.'
            : '';
          this.log.info(
            `ECHONET shutter '${device.displayName}' supports open/close/stop direct control; ` +
            `half-open remains on AiSEG2 because the endpoint does not expose degree-of-opening control (0xe1).${timedPositionNote}`,
          );
        }
      } else if (this.echonetEnabled && this.echonetBoolean('preferShutters', true)) {
        this.log.info(`AiSEG fallback for shutter '${device.displayName}': no matching ECHONET endpoint`);
      }
      this.provisionDevice(device);
    }
  }

  async discoverAirPurifiers(): Promise<void> {
    this.log.debug('Fetching air purifiers from AiSEG2');
    const devices = await this.client.getAirPurifierDevices();

    for (const device of devices) {
      this.markDeviceSeen(device);
      this.log.info(`Discovered air purifier '${device.displayName}'`);
      const endpoint = this.client.echonetEndpointForAirPurifier(device);
      if (endpoint) {
        this.log.info(`ECHONET mapped air purifier '${device.displayName}' -> ${endpoint.host}/${endpoint.eoj}`);
      } else if (this.echonetEnabled && this.echonetBoolean('preferAirPurifiers', true)) {
        this.log.info(`AiSEG fallback for air purifier '${device.displayName}': no matching ECHONET endpoint`);
      }
      this.provisionDevice(device);
    }
  }

  async discoverEcocutes(): Promise<void> {
    this.log.debug('Fetching EcoCute devices from AiSEG2');
    const devices = await this.client.getEcocuteDevices();

    for (const device of devices) {
      this.log.info(`Discovered EcoCute '${device.displayName}'`);
      const endpoint = this.client.echonetEndpointForEcocute(device);
      if (!endpoint) {
        if (this.echonetEnabled && this.echonetBoolean('preferEcocutes', true)) {
          this.log.info(`Skipping EcoCute '${device.displayName}': no matching ECHONET endpoint`);
        } else {
          this.log.debug(`Skipping EcoCute '${device.displayName}': ECHONET Lite direct control is disabled`);
        }
        continue;
      }

      this.log.info(`ECHONET mapped EcoCute '${device.displayName}' -> ${endpoint.host}/${endpoint.eoj}`);
      this.log.info(
        `ECHONET EcoCute '${device.displayName}' exposes HomeKit switches for manual heating and automatic bath where supported`,
      );
      this.provisionDevice(device);
    }
  }

  async discoverAirEnvironmentSensors(): Promise<void> {
    this.log.debug('Fetching air environment sensors from AiSEG2');
    const devices = await this.client.getAirEnvironmentSensorDevices();

    for (const device of devices) {
      this.markDeviceSeen(device);
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
      this.markDeviceSeen(device);
      this.log.info(`Discovered door lock '${device.displayName}'`);
      const endpoint = this.client.echonetEndpointForDoorLock(device);
      if (endpoint) {
        this.log.info(`ECHONET mapped door lock '${device.displayName}' -> ${endpoint.host}/${endpoint.eoj}`);
      } else if (this.echonetEnabled && this.echonetBoolean('preferDoorLocks', true)) {
        this.log.info(`AiSEG fallback for door lock '${device.displayName}': no unique ECHONET endpoint`);
      }
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
      case 'ecocute':
        new EcocuteAccessory(this, accessory);
        break;
      case 'doorLock':
        new DoorLockAccessory(this, accessory);
        break;
      default:
        this.log.warn(`No HomeKit handler registered for AiSEG2 device kind '${kind}'`);
        break;
    }
  }

  private categoryForDevice(kind: SupportedDeviceKind): Categories {
    switch (kind) {
      case 'lighting':
        return this.api.hap.Categories.LIGHTBULB;
      case 'contactSensor':
      case 'smokeSensor':
      case 'airEnvironmentSensor':
        return this.api.hap.Categories.SENSOR;
      case 'airConditioner':
        return this.api.hap.Categories.AIR_CONDITIONER;
      case 'shutter':
        return this.api.hap.Categories.WINDOW_COVERING;
      case 'airPurifier':
        return this.api.hap.Categories.AIR_PURIFIER;
      case 'ecocute':
        return this.api.hap.Categories.SWITCH;
      case 'doorLock':
        return this.api.hap.Categories.DOOR_LOCK;
      default:
        return this.api.hap.Categories.OTHER;
    }
  }

  private configureIdentify(accessory: PlatformAccessory): void {
    if (accessory.listenerCount(PlatformAccessoryEvent.IDENTIFY) > 0) {
      return;
    }

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      const device = accessory.context.device as SupportedDevice | undefined;
      this.log.info(`Identify requested for '${device?.displayName || accessory.displayName}'`);
    });
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  public get groupAirPurifierSensors(): boolean {
    return this.configBoolean('groupAirPurifierSensors', true);
  }

  public get groupAirConditionerSensors(): boolean {
    return this.configBoolean('groupAirConditionerSensors', true);
  }

  public get groupAirEnvironmentSensors(): boolean {
    return this.configBoolean('groupAirEnvironmentSensors', true);
  }

  public get groupEcocuteServices(): boolean {
    return this.configBoolean('groupEcocuteServices', true);
  }

  public get exposeContactSensorLockState(): boolean {
    return this.configBoolean('exposeContactSensorLockState', false);
  }

  public get echonetDiscovery(): boolean {
    return this.configBoolean('echonetDiscovery', false);
  }

  public get echonetEnabled(): boolean {
    return this.echonetBoolean('enabled', false);
  }

  public configureGroupedService(primaryService: Service, linkedServices: Service[], enabled: boolean): void {
    primaryService.setPrimaryService(enabled);
    for (const linkedService of linkedServices) {
      if (enabled) {
        primaryService.addLinkedService(linkedService);
      } else {
        primaryService.removeLinkedService(linkedService);
      }
    }
  }

  public configureAccessoryInformation(accessory: PlatformAccessory, model: string, serialNumber: string): void {
    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.Characteristic.Model, model)
      .setCharacteristic(this.Characteristic.SerialNumber, serialNumber)
      .setCharacteristic(this.Characteristic.FirmwareRevision, PLUGIN_VERSION);
  }

  public registerInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval> {
    const handle = setInterval(callback, delayMs);
    this.intervalHandles.add(handle);
    return handle;
  }

  public invalidValueError(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
  }

  public communicationError(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  public homeKitError(error: unknown): Error {
    if (error instanceof this.api.hap.HapStatusError) {
      return error;
    }

    return this.communicationError();
  }

  public safeJson(value: unknown): string {
    return JSON.stringify(value, (key, entry) => key.toLowerCase().includes('token') ? '[redacted]' : entry);
  }

  private configBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.config[key];
    return typeof value === 'boolean' ? value : defaultValue;
  }

  private async resolveClient(): Promise<void> {
    const host = this.configuredHost;
    if (host) {
      if (this.autodiscover) {
        this.log.info(`AiSEG2 auto discovery is enabled, but host is configured; using ${host}`);
      }
      this.client = new Aiseg2Client(host, this.password);
      this.configureClientEchonet();
      return;
    }

    if (!this.autodiscover) {
      throw new Error('AiSEG2 host is required when autodiscover is disabled');
    }

    this.log.info(`Auto discovering AiSEG2 controller on local subnets: ${localDiscoverySubnets().join(', ') || 'none'}`);
    const result = await discoverAiseg2Controller(this.password);
    this.log.info(`Auto discovered AiSEG2 controller at ${result.host} on ${result.interfaceName} ${result.subnet}`);
    this.client = new Aiseg2Client(result.host, this.password);
    this.configureClientEchonet();
  }

  private async discoverEchonetLiteDevices(): Promise<void> {
    if (!this.echonetDiscovery && !this.echonetEnabled) {
      return;
    }

    const configuredSubnets = this.configuredEchonetSubnets;
    const targetDescription = configuredSubnets.length > 0
      ? configuredSubnets.join(', ')
      : localEchonetLiteSubnets().join(', ') || 'none';

    this.log.info(`Discovering ECHONET Lite devices on ${targetDescription}`);
    if (this.echonetEnabled) {
      this.log.info('ECHONET Lite direct control enabled for matched shutters, door locks, air purifiers, and EcoCute devices');
    }

    try {
      const nodes = await discoverEchonetLiteNodes({
        subnets: configuredSubnets,
      });
      this.client.setEchonetNodes(nodes);

      if (nodes.length === 0) {
        this.log.info('No ECHONET Lite devices responded to discovery');
        return;
      }

      for (const node of nodes) {
        for (const object of node.objects) {
          const details = [
            object.manufacturerName || object.manufacturerCode,
            object.productCode,
            object.operationStatus
              ? `operation=${object.operationStatus}${object.operationStatusRaw ? ` (${object.operationStatusRaw})` : ''}`
              : object.operationStatusRaw ? `operation=${object.operationStatusRaw}` : undefined,
            object.faultStatus ? `fault=${object.faultStatus}` : undefined,
            object.configurationUrl ? `url=${object.configurationUrl}` : undefined,
          ].filter(Boolean);

          this.log.info(
            `Discovered ECHONET Lite ${object.className} ${object.eoj} at ${node.host}` +
            (details.length > 0 ? ` (${details.join(', ')})` : ''),
          );

          if (object.classCode === '0x05fd') {
            this.log.info(
              `ECHONET Lite JEM-A/HA switch at ${node.host} exposes set=[${(object.setProperties || []).join(', ')}] ` +
              `get=[${(object.getProperties || []).join(', ')}] notify=[${(object.notificationProperties || []).join(', ')}]`,
            );
          }
        }
      }
    } catch (error) {
      this.log.warn(`ECHONET Lite discovery failed: ${this.formatError(error)}`);
    }
  }

  private markDeviceSeen(device: SupportedDevice): string {
    const uuid = this.api.hap.uuid.generate(device.uuidSeed);
    this.discoveredAccessoryUUIDs.add(uuid);
    return uuid;
  }

  private unregisterStaleAccessories(): void {
    const staleAccessories = this.accessories.filter(accessory => !this.discoveredAccessoryUUIDs.has(accessory.UUID));
    if (staleAccessories.length === 0) {
      return;
    }

    for (const accessory of staleAccessories) {
      const device = accessory.context.device as SupportedDevice | undefined;
      this.log.info(`Removing stale accessory from cache: ${device?.displayName || accessory.displayName}`);
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    for (const accessory of staleAccessories) {
      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }
  }

  private shutdown(): void {
    for (const handle of this.intervalHandles) {
      clearInterval(handle);
    }

    if (this.intervalHandles.size > 0) {
      this.log.debug(`Cleared ${this.intervalHandles.size} AiSEG2 polling interval(s)`);
    }
    this.intervalHandles.clear();
  }

  private get configuredHost(): string {
    return String(this.config.host || '').trim();
  }

  private get password(): string {
    return String(this.config.password || '');
  }

  private get autodiscover(): boolean {
    return this.configBoolean('autodiscover', false);
  }

  private get configuredEchonetSubnets(): string[] {
    const nested = this.echonetConfig.subnets;
    const value = nested !== undefined ? nested : this.config.echonetSubnets;
    if (Array.isArray(value)) {
      return value.map(entry => String(entry).trim()).filter(Boolean);
    }

    return String(value || '')
      .split(/[\s,]+/)
      .map(entry => entry.trim())
      .filter(Boolean);
  }

  private configureClientEchonet(): void {
    this.client.configureEchonet({
      enabled: this.echonetEnabled,
      preferShutters: this.echonetBoolean('preferShutters', true),
      preferDoorLocks: this.echonetBoolean('preferDoorLocks', true),
      preferAirPurifiers: this.echonetBoolean('preferAirPurifiers', true),
      preferEcocutes: this.echonetBoolean('preferEcocutes', true),
      fallbackToAiseg: this.echonetBoolean('fallbackToAiseg', false),
      doorLockHosts: this.echonetStringMap('doorLockHosts'),
    });
  }

  private echonetBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.echonetConfig[key];
    return typeof value === 'boolean' ? value : defaultValue;
  }

  private echonetStringMap(key: string): Record<string, string> {
    const value = this.echonetConfig[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .map(([entryKey, entryValue]) => [entryKey, String(entryValue).trim()])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
  }

  private get echonetConfig(): Record<string, unknown> {
    const value = this.config.echonet;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
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
