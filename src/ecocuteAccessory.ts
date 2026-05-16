import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { EcocuteStatus, EcocuteWaterHeatingMode, OperationResponse } from './aiseg2Client';
import { EcocuteDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class EcocuteAccessory {
  private readonly manualHeatingService: Service;
  private readonly bathAutoService?: Service;
  private readonly tankTemperatureService: Service;
  private readonly suppliedWaterTemperatureService: Service;
  private readonly bathWaterTemperatureService: Service;
  private readonly device: EcocuteDevice;
  private waterHeatingChangeInFlight = false;

  private state = {
    manualHeating: false,
    bathAuto: false,
    waterHeatingMode: undefined as string | undefined,
    waterHeatingStatus: undefined as string | undefined,
    tankTemperature: 0,
    suppliedWaterTemperature: 0,
    bathWaterTemperature: 0,
    remainingWaterLiters: undefined as number | undefined,
    tankCapacityLiters: undefined as number | undefined,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as EcocuteDevice;

    this.platform.configureAccessoryInformation(
      this.accessory,
      this.ecocuteModelName(),
      this.device.uuidSeed,
    );

    this.manualHeatingService = this.getSwitchService('manual-heating', `${this.device.displayName} 手動沸き上げ`);
    this.manualHeatingService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setManualHeating.bind(this))
      .onGet(() => this.state.manualHeating);

    this.bathAutoService = this.platform.client.ecocuteCanSet(this.device, 0xe3)
      ? this.getBathAutoService()
      : this.removeSwitchService('bath-auto');

    this.tankTemperatureService = this.getTemperatureService('tank-temperature', `${this.device.displayName} タンク温度`);
    this.suppliedWaterTemperatureService = this.getTemperatureService('supplied-water-temperature', `${this.device.displayName} 給湯温度`);
    this.bathWaterTemperatureService = this.getTemperatureService('bath-water-temperature', `${this.device.displayName} 風呂温度`);
    this.configureGroupedServices();

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update EcoCute '${this.device.displayName}': ${this.formatError(error)}`);
    });

    this.platform.registerInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update EcoCute '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getEcocuteStatus(this.device);
    this.applyStatus(status);
  }

  async setManualHeating(value: CharacteristicValue): Promise<void> {
    const enabled = Boolean(value);

    if (!enabled && !this.canStopManualHeating()) {
      this.platform.log.info(`${this.device.displayName} manual water heating stop ignored: not manually heating`);
      this.state.manualHeating = false;
      this.manualHeatingService.updateCharacteristic(this.platform.Characteristic.On, false);
      return;
    }

    if (enabled && this.state.manualHeating) {
      this.manualHeatingService.updateCharacteristic(this.platform.Characteristic.On, true);
      return;
    }

    await this.changeManualHeating(enabled);
  }

  async setBathAuto(value: CharacteristicValue): Promise<void> {
    const enabled = Boolean(value);
    this.platform.log.info(`${this.device.displayName} bath auto request: target=${enabled ? 'on' : 'off'}`);

    try {
      const response = await this.platform.client.changeEcocuteBathAuto(this.device, enabled);
      this.assertAcceptedResponse(response);
      this.platform.log.info(
        `${this.device.displayName} bath auto request accepted: target=${enabled ? 'on' : 'off'}, ` +
        `transport=${response.transport || 'ECHONET Lite'}${response.endpoint ? ` endpoint=${response.endpoint}` : ''}`,
      );
      this.state.bathAuto = enabled;
      this.bathAutoService?.updateCharacteristic(this.platform.Characteristic.On, this.state.bathAuto);
      await this.delayedRefresh();
    } catch (error) {
      this.platform.log.error(`${this.device.displayName} bath auto request failed: ${this.formatError(error)}`);
      await this.updateStatus().catch(refreshError => {
        this.platform.log.error(`${this.device.displayName} post-bath-auto refresh failed: ${this.formatError(refreshError)}`);
      });
      throw this.platform.homeKitError(error);
    }
  }

  private async changeManualHeating(enabled: boolean): Promise<void> {
    if (this.waterHeatingChangeInFlight) {
      this.platform.log.warn(`${this.device.displayName} manual water heating request ignored while update is pending`);
      throw this.platform.communicationError();
    }

    const mode = enabled ? EcocuteWaterHeatingMode.ManualHeating : EcocuteWaterHeatingMode.ManualStop;
    this.waterHeatingChangeInFlight = true;
    this.state.manualHeating = enabled;
    this.state.waterHeatingMode = mode;
    this.manualHeatingService.updateCharacteristic(this.platform.Characteristic.On, enabled);
    this.platform.log.info(`${this.device.displayName} manual water heating request: target=${enabled ? 'on' : 'off'}`);

    try {
      const response = await this.platform.client.changeEcocuteWaterHeatingMode(this.device, mode);
      this.assertAcceptedResponse(response);
      this.platform.log.info(
        `${this.device.displayName} manual water heating request accepted: target=${this.formatWaterHeatingMode(mode)}, ` +
        `transport=${response.transport || 'ECHONET Lite'}${response.endpoint ? ` endpoint=${response.endpoint}` : ''}`,
      );
      await this.delayedRefresh(enabled ? 5000 : 1500);
    } catch (error) {
      this.platform.log.error(`${this.device.displayName} manual water heating request failed: ${this.formatError(error)}`);
      await this.updateStatus().catch(refreshError => {
        this.platform.log.error(`${this.device.displayName} post-action refresh failed: ${this.formatError(refreshError)}`);
      });
      throw this.platform.homeKitError(error);
    } finally {
      this.waterHeatingChangeInFlight = false;
    }
  }

  private applyStatus(status: EcocuteStatus): void {
    this.state.waterHeatingMode = status.waterHeatingMode;
    this.state.waterHeatingStatus = status.waterHeatingStatus;

    if (status.tankTemperature !== undefined) {
      this.state.tankTemperature = status.tankTemperature;
    }

    if (status.suppliedWaterTemperature !== undefined) {
      this.state.suppliedWaterTemperature = status.suppliedWaterTemperature;
    }

    if (status.bathWaterTemperature !== undefined) {
      this.state.bathWaterTemperature = status.bathWaterTemperature;
    }

    if (status.remainingWaterLiters !== undefined) {
      this.state.remainingWaterLiters = status.remainingWaterLiters;
    }

    if (status.tankCapacityLiters !== undefined) {
      this.state.tankCapacityLiters = status.tankCapacityLiters;
    }

    if (status.waterHeatingMode !== undefined) {
      this.state.manualHeating = status.waterHeatingMode === EcocuteWaterHeatingMode.ManualHeating &&
        status.waterHeatingStatus !== '0x42';
    }

    if (status.bathAuto !== undefined) {
      this.state.bathAuto = status.bathAuto;
    } else if (status.bathOperationStatus !== undefined) {
      this.state.bathAuto = status.bathOperationStatus === '0x41' || status.bathOperationStatus === '0x43';
    }

    this.manualHeatingService.updateCharacteristic(this.platform.Characteristic.On, this.state.manualHeating);
    this.tankTemperatureService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.state.tankTemperature,
    );
    this.suppliedWaterTemperatureService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.state.suppliedWaterTemperature,
    );
    this.bathWaterTemperatureService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.state.bathWaterTemperature,
    );
    this.bathAutoService?.updateCharacteristic(this.platform.Characteristic.On, this.state.bathAuto);

    this.platform.log.debug(
      `${this.device.displayName} EcoCute status: ` +
      `tank=${this.formatNumber(status.tankTemperature, 'C')}, ` +
      `remaining=${this.formatNumber(status.remainingWaterLiters, 'L')}/` +
      `${this.formatNumber(status.tankCapacityLiters, 'L')} (${this.formatPercent(this.remainingWaterPercent(status))}), ` +
      `heatingCommand=${status.waterHeatingMode || 'unknown'}, heatingStatus=${status.waterHeatingStatus || 'unknown'}`,
    );
  }

  private getSwitchService(subtype: string, name: string): Service {
    const serviceName = this.platform.formatHomeKitName(name);
    const existingService = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
    const service = existingService || this.accessory.addService(this.platform.Service.Switch, serviceName, subtype);
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }

    return service;
  }

  private getBathAutoService(): Service {
    const service = this.getSwitchService('bath-auto', `${this.device.displayName} ふろ自動`);
    service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setBathAuto.bind(this))
      .onGet(() => this.state.bathAuto);
    return service;
  }

  private removeSwitchService(subtype: string): undefined {
    const existingService = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
    if (existingService) {
      this.accessory.removeService(existingService);
    }

    return undefined;
  }

  private getTemperatureService(subtype: string, name: string): Service {
    const serviceName = this.platform.formatHomeKitName(name);
    const existingService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, subtype);
    const service = existingService ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, serviceName, subtype);
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }

    return service;
  }

  private configureGroupedServices(): void {
    this.platform.configureGroupedService(
      this.manualHeatingService,
      [
        ...(this.bathAutoService ? [this.bathAutoService] : []),
        this.tankTemperatureService,
        this.suppliedWaterTemperatureService,
        this.bathWaterTemperatureService,
      ],
      this.platform.groupEcocuteServices,
    );
  }

  private canStopManualHeating(): boolean {
    return this.state.manualHeating || this.state.waterHeatingMode === EcocuteWaterHeatingMode.ManualHeating;
  }

  private async delayedRefresh(delayMs = 1500): Promise<void> {
    await this.delay(delayMs);
    await this.updateStatus();
  }

  private assertAcceptedResponse(response: OperationResponse): void {
    if (response.result !== undefined && String(response.result) !== '0') {
      throw new Error(`${this.device.displayName} update submission failed: ${this.platform.safeJson(response)}`);
    }
  }

  private ecocuteModelName(): string {
    const productCode = this.platform.client.echonetProductCodeForEcocute(this.device);
    if (productCode) {
      return `AiSEG2 EcoCute (${productCode})`;
    }

    return this.platform.client.echonetEndpointForEcocute(this.device)
      ? 'AiSEG2 EcoCute (ECHONET Lite)'
      : 'AiSEG2 EcoCute';
  }

  private remainingWaterPercent(status: EcocuteStatus): number | undefined {
    const remaining = status.remainingWaterLiters ?? this.state.remainingWaterLiters;
    const capacity = status.tankCapacityLiters ?? this.state.tankCapacityLiters;
    if (remaining === undefined || capacity === undefined || capacity <= 0) {
      return undefined;
    }

    return Math.max(0, Math.min(100, Math.round((remaining / capacity) * 100)));
  }

  private formatWaterHeatingMode(mode: EcocuteWaterHeatingMode): string {
    switch (mode) {
      case EcocuteWaterHeatingMode.ManualHeating:
        return 'manual heating';
      case EcocuteWaterHeatingMode.ManualStop:
        return 'heating stop';
      default:
        return 'automatic heating';
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? 'unknown' : `${value}${unit}`;
  }

  private formatPercent(value: number | undefined): string {
    return value === undefined ? 'unknown' : `${value}%`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
