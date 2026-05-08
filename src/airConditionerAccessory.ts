import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AirConditionerStatus, CheckResult, OperationResponse } from './aiseg2Client';
import { AirConditionerDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class AirConditionerAccessory {
  private readonly service: Service;
  private readonly device: AirConditionerDevice;

  private state = {
    currentHeatingCoolingState: 0,
    targetHeatingCoolingState: 0,
    currentTemperature: 20,
    targetTemperature: 25,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirConditionerDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Air Conditioner')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

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

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 5000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getAirConditionerStatus(this.device);
    this.applyStatus(status);
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const targetState = Number(value);
    const desiredActive = targetState !== this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    const status = await this.platform.client.getAirConditionerStatus(this.device);

    if (status.active !== desiredActive) {
      const token = await this.platform.client.getAirConditionerControlToken();
      const response = await this.platform.client.changeAirConditionerPower(this.device, token, status);
      await this.waitForAcceptedChange(response, token);
    }

    const updatedStatus = await this.platform.client.getAirConditionerStatus(this.device);
    this.applyStatus({
      ...updatedStatus,
      mode: desiredActive ? updatedStatus.mode : '0x41',
      state: desiredActive ? '0x30' : '0x31',
      active: desiredActive,
    });
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const temperature = Number(value);
    if (!Number.isFinite(temperature)) {
      throw new Error(`Invalid target temperature '${value}'`);
    }

    this.state.targetTemperature = temperature;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, temperature);
    this.platform.log.warn(
      `${this.device.displayName} target temperature changes are not sent to AiSEG2 yet; stored ${temperature}C in HomeKit`,
    );
  }

  private applyStatus(status: AirConditionerStatus): void {
    this.state.currentHeatingCoolingState = this.currentHeatingCoolingState(status);
    this.state.targetHeatingCoolingState = this.targetHeatingCoolingState(status);

    if (status.currentTemperature !== undefined) {
      this.state.currentTemperature = status.currentTemperature;
    }

    if (status.targetTemperature !== undefined) {
      this.state.targetTemperature = status.targetTemperature;
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
