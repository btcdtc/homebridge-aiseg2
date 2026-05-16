import { PlatformAccessory, Service } from 'homebridge';

import { EnergyStatus } from './aiseg2Client';
import { EnergyDevice } from './devices';
import { Aiseg2Platform } from './platform';


interface EnergyFlags {
  solarSurplus: boolean;
  batteryReady: boolean;
  batteryDischarging: boolean;
  ecocuteGoodTime: boolean;
}

type EnergyFlag = keyof EnergyFlags;

interface EnergyStatusServiceDefinition {
  key: EnergyFlag;
  subtype: string;
  name: string;
  available: (device: EnergyDevice) => boolean;
}

const STATUS_SERVICES: EnergyStatusServiceDefinition[] = [
  {
    key: 'solarSurplus',
    subtype: 'solar-surplus',
    name: 'AiSEG2 Solar Surplus',
    available: device => device.hasSolar,
  },
  {
    key: 'batteryReady',
    subtype: 'battery-ready',
    name: 'AiSEG2 Battery Ready',
    available: device => device.hasBattery,
  },
  {
    key: 'batteryDischarging',
    subtype: 'battery-discharging',
    name: 'AiSEG2 Battery Discharging',
    available: device => device.hasBattery,
  },
  {
    key: 'ecocuteGoodTime',
    subtype: 'ecocute-good-time',
    name: 'AiSEG2 EcoCute Good Time',
    available: device => device.hasSolar && device.hasBattery,
  },
];

export class EnergyAccessory {
  private readonly statusServices = new Map<EnergyFlag, Service>();
  private readonly batteryService?: Service;
  private readonly device: EnergyDevice;

  private state: EnergyFlags = {
    solarSurplus: false,
    batteryReady: false,
    batteryDischarging: false,
    ecocuteGoodTime: false,
  };

  private batteryLevel = 0;
  private chargingState: number;

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as EnergyDevice;
    this.chargingState = this.platform.Characteristic.ChargingState.NOT_CHARGEABLE;

    this.platform.configureAccessoryInformation(this.accessory, 'AiSEG2 Energy Status', this.device.uuidSeed);
    this.removeLegacyContactServices();

    for (const definition of STATUS_SERVICES) {
      if (definition.available(this.device)) {
        this.statusServices.set(definition.key, this.getStatusService(definition));
      } else {
        this.removeOccupancyService(definition.subtype);
      }
    }

    if (this.device.hasBattery) {
      this.batteryService = this.getBatteryService();
    } else {
      this.removeBatteryService();
    }

    this.configureGroupedServices();

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update AiSEG2 energy status: ${this.formatError(error)}`);
    });

    this.platform.registerInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update AiSEG2 energy status: ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getEnergyStatus();
    const nextState = this.energyFlags(status);
    this.applyState(nextState);
    this.updateBattery(status);
    this.platform.log.debug(
      'AiSEG2 energy status: ' +
      `solar=${this.formatNumber(status.solarGenerationWatts, 'W')}, ` +
      `battery=${this.formatNumber(status.batteryPercent, '%')}, ` +
      `batteryPower=${this.formatNumber(status.batteryPowerWatts, 'W')}, ` +
      `gridPower=${this.formatNumber(status.gridPowerWatts, 'W')}, ` +
      `gridNormal=${this.formatNumber(status.gridCumulativeNormalKwh, 'kWh')}, ` +
      `gridReverse=${this.formatNumber(status.gridCumulativeReverseKwh, 'kWh')}, ` +
      `working=${status.batteryWorkingStatus || 'unknown'}, ` +
      `goodTime=${nextState.ecocuteGoodTime ? 'yes' : 'no'}`,
    );
  }

  private energyFlags(status: EnergyStatus): EnergyFlags {
    const minSolarWatts = this.platform.energyNumber('solarSurplusWatts', 2500, 0, 100000);
    const minBatteryPercent = this.platform.energyNumber('batteryReadyPercent', 80, 0, 100);
    const batteryDischargeThresholdWatts = this.platform.energyNumber('batteryDischargeThresholdWatts', 100, 0, 100000);
    const solarSurplus = (status.solarGenerationWatts || 0) >= minSolarWatts;
    const batteryDischarging = status.batteryDischarging === true ||
      (status.batteryPowerWatts !== undefined && status.batteryPowerWatts <= -batteryDischargeThresholdWatts);
    const batteryReady = status.batteryPercent !== undefined &&
      status.batteryPercent >= minBatteryPercent &&
      !batteryDischarging;

    return {
      solarSurplus,
      batteryReady,
      batteryDischarging,
      ecocuteGoodTime: solarSurplus && batteryReady && this.platform.ecocuteSolarAutomationWindowOpen(new Date()),
    };
  }

  private applyState(nextState: EnergyFlags): void {
    this.state = nextState;
    for (const definition of STATUS_SERVICES) {
      const service = this.statusServices.get(definition.key);
      if (service) {
        this.updateOccupancy(service, nextState[definition.key]);
      }
    }
  }

  private updateBattery(status: EnergyStatus): void {
    if (!this.batteryService || status.batteryPercent === undefined) {
      return;
    }

    this.batteryLevel = this.batteryLevelFor(status.batteryPercent);
    this.chargingState = this.chargingStateFor(status);
    this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.batteryLevel);
    this.batteryService.updateCharacteristic(this.platform.Characteristic.ChargingState, this.chargingState);
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.batteryLevel <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private updateOccupancy(service: Service, active: boolean): void {
    service.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      active
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);
  }

  private getStatusService(definition: EnergyStatusServiceDefinition): Service {
    const serviceName = this.platform.formatHomeKitName(definition.name);
    const existingService = this.accessory.getServiceById(this.platform.Service.OccupancySensor, definition.subtype);
    const service = existingService ||
      this.accessory.addService(this.platform.Service.OccupancySensor, serviceName, definition.subtype);
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }
    service.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(() => this.occupancyFor(this.state[definition.key]));

    return service;
  }

  private getBatteryService(): Service {
    const serviceName = this.platform.formatHomeKitName('AiSEG2 Storage Battery');
    const existingService = this.accessory.getServiceById(this.platform.Service.Battery, 'storage-battery') ||
      this.accessory.getService(this.platform.Service.Battery);
    const service = existingService ||
      this.accessory.addService(this.platform.Service.Battery, serviceName, 'storage-battery');
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }
    service.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => this.batteryLevel);
    service.getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => this.chargingState);
    service.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() => this.batteryLevel <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    return service;
  }

  private configureGroupedServices(): void {
    const primaryService = this.statusServices.get('solarSurplus') ||
      this.statusServices.get('batteryReady') ||
      this.batteryService;
    if (!primaryService) {
      return;
    }

    const linkedServices = [
      ...this.statusServices.values(),
      this.batteryService,
    ].filter((service): service is Service => Boolean(service) && service !== primaryService);
    this.platform.configureGroupedService(primaryService, linkedServices, true);
  }

  private removeLegacyContactServices(): void {
    for (const definition of STATUS_SERVICES) {
      const service = this.accessory.getServiceById(this.platform.Service.ContactSensor, definition.subtype);
      if (service) {
        this.accessory.removeService(service);
      }
    }
  }

  private removeOccupancyService(subtype: string): void {
    const service = this.accessory.getServiceById(this.platform.Service.OccupancySensor, subtype);
    if (service) {
      this.accessory.removeService(service);
    }
  }

  private removeBatteryService(): void {
    const service = this.accessory.getServiceById(this.platform.Service.Battery, 'storage-battery') ||
      this.accessory.getService(this.platform.Service.Battery);
    if (service) {
      this.accessory.removeService(service);
    }
  }

  private batteryLevelFor(value: number): number {
    return Math.round(Math.max(0, Math.min(100, value)));
  }

  private chargingStateFor(status: EnergyStatus): number {
    if (status.batteryCharging) {
      return this.platform.Characteristic.ChargingState.CHARGING;
    }
    if (status.batteryDischarging || status.batteryStandby || status.batteryPowerWatts !== undefined) {
      return this.platform.Characteristic.ChargingState.NOT_CHARGING;
    }
    return this.platform.Characteristic.ChargingState.NOT_CHARGEABLE;
  }

  private occupancyFor(active: boolean): number {
    return active
      ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? 'unknown' : `${value}${unit}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
