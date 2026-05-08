import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { CheckResult, OperationResponse, ShutterStatus } from './aiseg2Client';
import { ShutterDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class ShutterAccessory {
  private readonly service: Service;
  private readonly device: ShutterDevice;

  private state = {
    currentPosition: 50,
    targetPosition: 50,
    positionState: 2,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as ShutterDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Shutter')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => this.state.currentPosition);
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onSet(this.setTargetPosition.bind(this))
      .onGet(() => this.state.targetPosition);
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => this.state.positionState);
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.holdPosition.bind(this));

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update shutter '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update shutter '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 5000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getShutterStatus(this.device);
    this.applyStatus(status);
  }

  async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const targetPosition = Math.max(0, Math.min(100, Number(value)));
    if (!Number.isFinite(targetPosition)) {
      throw new Error(`Invalid shutter target position '${value}'`);
    }

    const currentPosition = this.state.currentPosition;
    if (targetPosition === currentPosition) {
      return;
    }

    this.state.targetPosition = targetPosition;
    this.state.positionState = targetPosition > currentPosition
      ? this.platform.Characteristic.PositionState.INCREASING
      : this.platform.Characteristic.PositionState.DECREASING;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);

    const token = await this.platform.client.getShutterControlToken();
    const response = await this.platform.client.changeShutterPosition(this.device, token, targetPosition);
    await this.waitForAcceptedChange(response, token);

    this.state.currentPosition = targetPosition >= 50 ? 100 : 0;
    this.state.targetPosition = this.state.currentPosition;
    this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state.currentPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
  }

  async holdPosition(value: CharacteristicValue): Promise<void> {
    if (!value) {
      return;
    }

    const token = await this.platform.client.getShutterControlToken();
    const response = await this.platform.client.stopShutter(this.device, token);
    await this.waitForAcceptedChange(response, token);

    this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
  }

  private applyStatus(status: ShutterStatus): void {
    this.state.currentPosition = status.position;
    this.state.targetPosition = status.position;
    this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state.currentPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
  }

  private async waitForAcceptedChange(response: OperationResponse, token: string): Promise<void> {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      throw new Error(`${this.device.displayName} update submission failed: ${JSON.stringify(response)}`);
    }

    const acceptId = Number(response.acceptId);
    if (!Number.isInteger(acceptId)) {
      return;
    }

    for (let count = 0; count < 10; count++) {
      await this.delay(1000);
      const result = await this.platform.client.checkShutterChange(acceptId, this.device, token);

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
