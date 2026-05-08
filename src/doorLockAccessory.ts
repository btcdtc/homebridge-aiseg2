import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { CheckResult, DoorLockStatus, OperationResponse } from './aiseg2Client';
import { DoorLockDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class DoorLockAccessory {
  private readonly service: Service;
  private readonly device: DoorLockDevice;
  private pendingTargetSecured?: boolean;

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

  async updateStatus(force = false): Promise<void> {
    const status = await this.platform.client.getDoorLockStatus(this.device, force);
    this.applyStatus(status);
  }

  async setTargetState(value: CharacteristicValue): Promise<void> {
    const targetState = Number(value);
    const desiredSecured = targetState === this.platform.Characteristic.LockTargetState.SECURED;

    if (this.pendingTargetSecured !== undefined) {
      this.updateTargetState(this.pendingTargetSecured);
      this.platform.log.warn(
        `${this.device.displayName} lock request ignored while ${this.formatSecured(this.pendingTargetSecured)} is still pending`,
      );
      return;
    }

    const status = await this.platform.client.getDoorLockStatus(this.device, true);
    this.platform.log.info(
      `${this.device.displayName} lock request: target=${this.formatSecured(desiredSecured)}, ` +
      `current=${this.formatSecured(status.secured)}, command=${status.statecmd || '-'}`,
    );

    if (status.secured === desiredSecured) {
      this.applyStatus(status);
      this.platform.log.info(`${this.device.displayName} lock request ignored: already ${this.formatSecured(desiredSecured)}`);
      return;
    }

    this.pendingTargetSecured = desiredSecured;
    this.updateTargetState(desiredSecured);

    try {
      const token = await this.platform.client.getDoorLockControlToken();
      const response = await this.platform.client.changeDoorLock(this.device, token, status);
      this.assertAcceptedResponse(response);
      this.platform.log.info(
        `${this.device.displayName} lock request accepted: target=${this.formatSecured(desiredSecured)}, ` +
        `acceptId=${response.acceptId ?? '-'}`,
      );

      this.confirmTargetState(response, token, desiredSecured).catch(error => {
        this.platform.log.error(`Failed to confirm door lock '${this.device.displayName}' state: ${this.formatError(error)}`);
        this.updateStatus(true).catch(refreshError => {
          this.platform.log.error(
            `Failed to refresh door lock '${this.device.displayName}' after confirmation failure: ${this.formatError(refreshError)}`,
          );
        });
      }).finally(() => {
        this.pendingTargetSecured = undefined;
      });
    } catch (error) {
      this.pendingTargetSecured = undefined;
      await this.updateStatus(true);
      throw error;
    }
  }

  private applyStatus(status: DoorLockStatus): void {
    if (this.pendingTargetSecured !== undefined && status.secured !== this.pendingTargetSecured) {
      this.applyCurrentState(status);
      this.updateTargetState(this.pendingTargetSecured);
      return;
    }

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

  private async confirmTargetState(response: OperationResponse, token: string, desiredSecured: boolean): Promise<void> {
    await this.waitForAcceptedChange(response, token);
    await this.pollForDesiredState(desiredSecured);
  }

  private async waitForAcceptedChange(response: OperationResponse, token: string): Promise<void> {
    this.assertAcceptedResponse(response);

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

    throw new Error(`Timed out waiting for '${this.device.displayName}' to accept update`);
  }

  private async pollForDesiredState(desiredSecured: boolean): Promise<void> {
    for (let count = 0; count < 30; count++) {
      await this.delay(1000);
      const status = await this.platform.client.getDoorLockStatus(this.device, true);
      this.applyCurrentState(status);

      if (status.secured === desiredSecured) {
        this.applyStatus(status);
        this.platform.log.info(`${this.device.displayName} lock state confirmed: ${this.formatSecured(desiredSecured)}`);
        return;
      }
    }

    throw new Error(`Timed out waiting for '${this.device.displayName}' to report ${desiredSecured ? 'secured' : 'unsecured'}`);
  }

  private assertAcceptedResponse(response: OperationResponse): void {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      throw new Error(`${this.device.displayName} update submission failed: ${JSON.stringify(response)}`);
    }
  }

  private applyCurrentState(status: DoorLockStatus): void {
    if (status.secured === true) {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.SECURED;
    } else if (status.secured === false) {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
    } else {
      this.state.currentState = this.platform.Characteristic.LockCurrentState.UNKNOWN;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.state.currentState);
  }

  private updateTargetState(secured: boolean): void {
    this.state.targetState = secured
      ? this.platform.Characteristic.LockTargetState.SECURED
      : this.platform.Characteristic.LockTargetState.UNSECURED;
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.state.targetState);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private formatSecured(secured: boolean | undefined): string {
    if (secured === true) {
      return 'secured';
    }

    if (secured === false) {
      return 'unsecured';
    }

    return 'unknown';
  }
}
