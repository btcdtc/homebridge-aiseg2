import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AirPurifierStatus, CheckResult, OperationResponse } from './aiseg2Client';
import { AirPurifierDevice } from './devices';
import { Aiseg2Platform } from './platform';


enum AirPurifierMode {
  Stop = '0x40',
  Auto = '0x41',
  Weak = '0x42',
  Medium = '0x43',
  Strong = '0x44',
  Turbo = '0x45',
}

export class AirPurifierAccessory {
  private readonly service: Service;
  private readonly device: AirPurifierDevice;

  private state = {
    active: 0,
    currentState: 0,
    targetState: 1,
    rotationSpeed: 0,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirPurifierDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Air Purifier')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.AirPurifier) ||
      this.accessory.addService(this.platform.Service.AirPurifier);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(() => this.state.active);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(() => this.state.currentState);
    this.service.getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onSet(this.setTargetState.bind(this))
      .onGet(() => this.state.targetState);
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 25,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(() => this.state.rotationSpeed);

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air purifier '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air purifier '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getAirPurifierStatus(this.device);
    this.applyStatus(status);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.setMode(active ? AirPurifierMode.Auto : AirPurifierMode.Stop);
  }

  async setTargetState(value: CharacteristicValue): Promise<void> {
    const mode = Number(value) === this.platform.Characteristic.TargetAirPurifierState.AUTO
      ? AirPurifierMode.Auto
      : AirPurifierMode.Medium;
    await this.setMode(mode);
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const speed = Number(value);
    if (!Number.isFinite(speed)) {
      throw new Error(`Invalid air purifier speed '${value}'`);
    }

    await this.setMode(this.modeFromRotationSpeed(speed));
  }

  private async setMode(mode: AirPurifierMode): Promise<void> {
    const token = await this.platform.client.getAirPurifierControlToken(this.device);
    const response = await this.platform.client.changeAirPurifierMode(this.device, token, mode);
    await this.waitForAcceptedChange(response, token);

    const status = await this.platform.client.getAirPurifierStatus(this.device);
    this.applyStatus({
      ...status,
      mode,
      state: mode === AirPurifierMode.Stop ? '0x31' : '0x30',
      active: mode !== AirPurifierMode.Stop,
    });
  }

  private applyStatus(status: AirPurifierStatus): void {
    this.state.active = status.active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.state.currentState = status.active
      ? this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
    this.state.targetState = status.mode === AirPurifierMode.Auto
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
    this.state.rotationSpeed = this.rotationSpeedFromMode(status.mode);

    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState, this.state.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState, this.state.targetState);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
  }

  private modeFromRotationSpeed(speed: number): AirPurifierMode {
    if (speed <= 0) {
      return AirPurifierMode.Stop;
    }

    if (speed <= 25) {
      return AirPurifierMode.Weak;
    }

    if (speed <= 50) {
      return AirPurifierMode.Medium;
    }

    if (speed <= 75) {
      return AirPurifierMode.Strong;
    }

    return AirPurifierMode.Turbo;
  }

  private rotationSpeedFromMode(mode: string): number {
    switch (mode) {
      case AirPurifierMode.Weak:
        return 25;
      case AirPurifierMode.Medium:
        return 50;
      case AirPurifierMode.Strong:
        return 75;
      case AirPurifierMode.Turbo:
        return 100;
      default:
        return 0;
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
      const result = await this.platform.client.checkAirPurifierChange(acceptId, this.device, token);

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
