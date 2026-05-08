import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AirConditionerStatus, CheckResult, OperationResponse } from './aiseg2Client';
import { AirConditionerDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class AirConditionerAccessory {
  private readonly service: Service;
  private readonly device: AirConditionerDevice;
  private indoorHumidityService?: Service;
  private outdoorTemperatureService?: Service;
  private pendingActive?: boolean;
  private pendingTargetHeatingCoolingState?: number;
  private powerActionSequence = 0;

  private state = {
    currentHeatingCoolingState: 0,
    targetHeatingCoolingState: 0,
    currentTemperature: 20,
    targetTemperature: 25,
    currentHumidity: undefined as number | undefined,
    outdoorTemperature: undefined as number | undefined,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirConditionerDevice;
    this.state.currentTemperature = this.device.currentTemperature ?? this.state.currentTemperature;
    this.state.targetTemperature = this.device.targetTemperature ?? this.state.targetTemperature;
    this.state.currentHumidity = this.device.currentHumidity;
    this.state.outdoorTemperature = this.device.outdoorTemperature;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Air Conditioner')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.state.targetTemperature);

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
          this.platform.Characteristic.TargetHeatingCoolingState.COOL,
          this.platform.Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(() => this.state.targetHeatingCoolingState);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.state.currentHeatingCoolingState);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTemperature);

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 16,
        maxValue: 30,
        minStep: 1,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(() => this.state.targetTemperature);

    this.service.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    this.applySupplementalServices(this.device.currentHumidity, this.device.outdoorTemperature);

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(force = false): Promise<void> {
    const status = await this.platform.client.getAirConditionerStatus(this.device, force);
    this.applyStatus(status);
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const targetState = Number(value);
    const desiredActive = targetState !== this.platform.Characteristic.TargetHeatingCoolingState.OFF;

    if (this.pendingActive !== undefined) {
      this.updateTargetHeatingCoolingState(this.pendingTargetHeatingCoolingState ?? this.state.targetHeatingCoolingState);
      this.platform.log.warn(
        `${this.device.displayName} power request ignored while ${this.formatActive(this.pendingActive)} is still pending`,
      );
      return;
    }

    const status = await this.platform.client.getAirConditionerStatus(this.device, true);
    this.platform.log.info(
      `${this.device.displayName} power request: target=${this.formatActive(desiredActive)}, current=${this.formatActive(status.active)}`,
    );

    if (status.active !== desiredActive) {
      const actionId = this.beginPendingPowerState(desiredActive, targetState);
      this.updateTargetHeatingCoolingState(targetState);

      try {
        const token = await this.platform.client.getAirConditionerControlToken();
        const response = await this.platform.client.changeAirConditionerPower(this.device, token, status);
        this.platform.log.info(`${this.device.displayName} power request accepted: acceptId=${response.acceptId ?? '-'}`);
        await this.waitForAcceptedChange(response, token);

        this.confirmPowerState(actionId, desiredActive).catch(error => {
          this.clearPendingPowerState(actionId);
          this.platform.log.error(`${this.device.displayName} post-power refresh failed: ${this.formatError(error)}`);
          this.updateStatus(true).catch(refreshError => {
            this.platform.log.error(`${this.device.displayName} post-power recovery refresh failed: ${this.formatError(refreshError)}`);
          });
        }).finally(() => {
          this.clearPendingPowerState(actionId);
        });
      } catch (error) {
        this.clearPendingPowerState(actionId);
        await this.updateStatus(true);
        throw error;
      }
      return;
    }

    this.applyStatus(status);
    this.platform.log.info(`${this.device.displayName} power request ignored: already ${this.formatActive(desiredActive)}`);
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const temperature = Number(value);
    if (!Number.isFinite(temperature)) {
      throw new Error(`Invalid target temperature '${value}'`);
    }

    this.state.targetTemperature = temperature;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, temperature);
    this.platform.log.warn(
      `${this.device.displayName} target temperature request ignored by AiSEG2: stored ${temperature}C in HomeKit only`,
    );
  }

  private applyStatus(status: AirConditionerStatus): void {
    if (this.pendingActive !== undefined && status.active !== this.pendingActive) {
      this.applyCurrentStateAndMeasurements(status);
      this.updateTargetHeatingCoolingState(this.pendingTargetHeatingCoolingState ?? this.targetHeatingCoolingState(status));
      return;
    }

    this.state.currentHeatingCoolingState = this.currentHeatingCoolingState(status);
    this.state.targetHeatingCoolingState = this.targetHeatingCoolingState(status);

    if (status.currentTemperature !== undefined) {
      this.state.currentTemperature = status.currentTemperature;
    }

    if (status.targetTemperature !== undefined) {
      this.state.targetTemperature = status.targetTemperature;
    }

    if (status.currentHumidity !== undefined) {
      this.state.currentHumidity = status.currentHumidity;
    }

    if (status.outdoorTemperature !== undefined) {
      this.state.outdoorTemperature = status.outdoorTemperature;
    }

    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.state.currentHeatingCoolingState,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.state.targetHeatingCoolingState,
    );
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.state.targetTemperature);
    if (this.state.currentHumidity !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.state.currentHumidity);
    }
    this.applySupplementalServices(this.state.currentHumidity, this.state.outdoorTemperature);
  }

  private applyCurrentStateAndMeasurements(status: AirConditionerStatus): void {
    this.state.currentHeatingCoolingState = this.currentHeatingCoolingState(status);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.state.currentHeatingCoolingState,
    );
    this.applyMeasurements(status);
  }

  private applyMeasurements(status: AirConditionerStatus): void {
    if (status.currentTemperature !== undefined) {
      this.state.currentTemperature = status.currentTemperature;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    }

    if (status.currentHumidity !== undefined) {
      this.state.currentHumidity = status.currentHumidity;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.state.currentHumidity);
    }

    if (status.outdoorTemperature !== undefined) {
      this.state.outdoorTemperature = status.outdoorTemperature;
    }

    this.applySupplementalServices(this.state.currentHumidity, this.state.outdoorTemperature);
  }

  private currentHeatingCoolingState(status: AirConditionerStatus): number {
    if (!status.active) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    return status.mode === '0x43'
      ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
      : this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
  }

  private targetHeatingCoolingState(status: AirConditionerStatus): number {
    if (!status.active) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }

    switch (status.mode) {
      case '0x42':
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case '0x43':
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  private applySupplementalServices(currentHumidity: number | undefined, outdoorTemperature: number | undefined): void {
    if (currentHumidity !== undefined) {
      this.ensureIndoorHumidityService()
        .updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, currentHumidity);
    }

    if (outdoorTemperature !== undefined) {
      this.ensureOutdoorTemperatureService()
        .updateCharacteristic(this.platform.Characteristic.CurrentTemperature, outdoorTemperature);
    }
  }

  private updateTargetHeatingCoolingState(targetState: number): void {
    this.state.targetHeatingCoolingState = targetState;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
  }

  private ensureIndoorHumidityService(): Service {
    if (!this.indoorHumidityService) {
      const name = this.platform.formatHomeKitName(`${this.device.displayName} 室内湿度`);
      this.indoorHumidityService = this.accessory.getServiceById(this.platform.Service.HumiditySensor, 'indoor-humidity') ||
        this.accessory.addService(this.platform.Service.HumiditySensor, name, 'indoor-humidity');
      this.indoorHumidityService.setCharacteristic(this.platform.Characteristic.Name, name);
    }

    return this.indoorHumidityService;
  }

  private ensureOutdoorTemperatureService(): Service {
    if (!this.outdoorTemperatureService) {
      const name = this.platform.formatHomeKitName(`${this.device.displayName} 室外温度`);
      this.outdoorTemperatureService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'outdoor-temperature') ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, name, 'outdoor-temperature');
      this.outdoorTemperatureService.setCharacteristic(this.platform.Characteristic.Name, name);
    }

    return this.outdoorTemperatureService;
  }

  private async waitForAcceptedChange(response: OperationResponse, token: string): Promise<void> {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      throw new Error(`${this.device.displayName} update submission failed: ${JSON.stringify(response)}`);
    }

    const acceptId = Number(response.acceptId);
    if (!Number.isInteger(acceptId)) {
      return;
    }

    for (let count = 0; count < 8; count++) {
      await this.delay(1000);
      const result = await this.platform.client.checkAirConditionerChange(acceptId, this.device, token);

      if (result === CheckResult.OK) {
        return;
      }

      if (result === CheckResult.Invalid) {
        break;
      }
    }

    throw new Error(`Timed out waiting for '${this.device.displayName}' to update`);
  }

  private async confirmPowerState(actionId: number, desiredActive: boolean): Promise<void> {
    let lastStatus: AirConditionerStatus | undefined;

    for (let count = 0; count < 12; count++) {
      if (actionId !== this.powerActionSequence) {
        return;
      }

      await this.delay(1000);
      if (actionId !== this.powerActionSequence) {
        return;
      }

      const status = await this.platform.client.getAirConditionerStatus(this.device, true);
      if (actionId !== this.powerActionSequence) {
        return;
      }

      lastStatus = status;

      if (status.active === desiredActive) {
        this.applyStatus(status);
        this.platform.log.info(`${this.device.displayName} power state confirmed: ${this.formatActive(desiredActive)}`);
        return;
      }

      this.applyCurrentStateAndMeasurements(status);
    }

    if (lastStatus) {
      this.applyCurrentStateAndMeasurements(lastStatus);
    }
    throw new Error(`Timed out waiting for '${this.device.displayName}' to report ${this.formatActive(desiredActive)}`);
  }

  private beginPendingPowerState(desiredActive: boolean, targetState: number): number {
    const actionId = ++this.powerActionSequence;
    this.pendingActive = desiredActive;
    this.pendingTargetHeatingCoolingState = targetState;
    return actionId;
  }

  private clearPendingPowerState(actionId: number): void {
    if (actionId === this.powerActionSequence) {
      this.pendingActive = undefined;
      this.pendingTargetHeatingCoolingState = undefined;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private formatActive(active: boolean): string {
    return active ? 'on' : 'off';
  }
}
