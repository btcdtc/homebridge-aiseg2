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

export class EnergyAccessory {
  private readonly solarSurplusService: Service;
  private readonly batteryReadyService: Service;
  private readonly batteryDischargingService: Service;
  private readonly ecocuteGoodTimeService: Service;
  private readonly device: EnergyDevice;

  private state: EnergyFlags = {
    solarSurplus: false,
    batteryReady: false,
    batteryDischarging: false,
    ecocuteGoodTime: false,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as EnergyDevice;

    this.platform.configureAccessoryInformation(this.accessory, 'AiSEG2 Energy Status', this.device.uuidSeed);

    this.solarSurplusService = this.getStatusService('solar-surplus', 'AiSEG2 Solar Surplus');
    this.batteryReadyService = this.getStatusService('battery-ready', 'AiSEG2 Battery Ready');
    this.batteryDischargingService = this.getStatusService('battery-discharging', 'AiSEG2 Battery Discharging');
    this.ecocuteGoodTimeService = this.getStatusService('ecocute-good-time', 'AiSEG2 EcoCute Good Time');

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
    this.platform.log.debug(
      'AiSEG2 energy status: ' +
      `solar=${this.formatNumber(status.solarGenerationWatts, 'W')}, ` +
      `battery=${this.formatNumber(status.batteryPercent, '%')}, ` +
      `batteryPower=${this.formatNumber(status.batteryPowerWatts, 'W')}, ` +
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
    this.updateContact(this.solarSurplusService, nextState.solarSurplus);
    this.updateContact(this.batteryReadyService, nextState.batteryReady);
    this.updateContact(this.batteryDischargingService, nextState.batteryDischarging);
    this.updateContact(this.ecocuteGoodTimeService, nextState.ecocuteGoodTime);
  }

  private updateContact(service: Service, active: boolean): void {
    service.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      active
        ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);
  }

  private getStatusService(subtype: string, name: string): Service {
    const serviceName = this.platform.formatHomeKitName(name);
    const existingService = this.accessory.getServiceById(this.platform.Service.ContactSensor, subtype);
    const service = existingService || this.accessory.addService(this.platform.Service.ContactSensor, serviceName, subtype);
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }
    service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() => this.contactStateFor(this.statusForSubtype(subtype)));

    return service;
  }

  private configureGroupedServices(): void {
    this.platform.configureGroupedService(
      this.solarSurplusService,
      [
        this.batteryReadyService,
        this.batteryDischargingService,
        this.ecocuteGoodTimeService,
      ],
      true,
    );
  }

  private statusForSubtype(subtype: string): boolean {
    switch (subtype) {
      case 'solar-surplus':
        return this.state.solarSurplus;
      case 'battery-ready':
        return this.state.batteryReady;
      case 'battery-discharging':
        return this.state.batteryDischarging;
      case 'ecocute-good-time':
        return this.state.ecocuteGoodTime;
      default:
        return false;
    }
  }

  private contactStateFor(active: boolean): number {
    return active
      ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? 'unknown' : `${value}${unit}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
