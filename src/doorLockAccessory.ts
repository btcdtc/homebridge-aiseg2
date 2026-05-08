import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { CheckResult, DoorLockStatus, OperationResponse } from './aiseg2Client';
import { DoorLockDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class DoorLockAccessory {
  private readonly service: Service;
  private readonly device: DoorLockDevice;

  private state = {
    currentState: 3,
    targetState: 1,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as DoorLockDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Door Lock')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.LockMechanism) ||
      this.accessory.addService(this.platform.Service.LockMechanism);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

    this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(() => this.state.currentState);
    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onSet(this.setTargetState.bind(this))
      .onGet(() => this.state.targetState);

    this.applyStatus({
      lockVal: this.device.lockVal || '',
      statecmd: this.device.statecmd || '',
      secured: this.device.lockVal === 'lock_val' ? true : this.device.lockVal === 'lock_val open' ? false : undefined,
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update door lock '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getDoorLockStatus(this.device);
    this.applyStatus(status);
  }

  async setTargetState(value: CharacteristicValue): Promise<void> {
    const targetState = Number(value);
    const desiredSecured = targetState === this.platform.Characteristic.LockTargetState.SECURED;
    const status = await this.platform.client.getDoorLockStatus(this.device);

    if (status.secured === desiredSecured) {
      this.applyStatus(status);
      return;
    }

    const token = await this.platform.client.getDoorLockControlToken();
    const response = await this.platform.client.changeDoorLock(this.device, token, status);
    await this.waitForAcceptedChange(response, token);

    this.state.currentState = desiredSecured
      ? this.platform.Characteristic.LockCurrentState.SECURED
      : this.platform.Characteristic.LockCurrentState.UNSECURED;
    this.state.targetState = desiredSecured
      ? this.platform.Characteristic.LockTargetState.SECURED
      : this.platform.Characteristic.LockTargetState.UNSECURED;
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.state.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.state.targetState);
  }

  private applyStatus(status: DoorLockStatus): void {
    if (status.secured === true) {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.SECURED;
      this.state.targetState = this.platform.Characteristic.LockTargetState.SECURED;
    } else if (status.secured === false) {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
      this.state.targetState = this.platform.Characteristic.LockTargetState.UNSECURED;
    } else {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.UNKNOWN;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.state.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.state.targetState);
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
      const result = await this.platform.client.checkDoorLockChange(acceptId, this.device, token);

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
