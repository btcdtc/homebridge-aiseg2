import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { ContactSensorDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class ContactSensorAccessory {
  private readonly service: Service;
  private readonly lockService?: Service;
  private readonly device: ContactSensorDevice;

  private state = {
    lockCurrentState: 3,
    lockTargetState: 0,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as ContactSensorDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Contact Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.ContactSensor) ||
      this.accessory.addService(this.platform.Service.ContactSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));
    this.lockService = this.configureLockService(this.lockedFromValue(this.device.lockVal));

    this.applyState(
      this.contactDetectedFromDevice(),
      this.device.batteryUHF === 'U00' || this.device.batteryUHF === 'U01',
      this.lockedFromValue(this.device.lockVal),
    );

    setInterval(() => {
      this.updateContactState().catch(error => {
        this.platform.log.error(`Failed to update contact sensor '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateContactState(): Promise<void> {
    const status = await this.platform.client.getContactSensorStatus(this.device);
    this.applyState(status.contactDetected, status.lowBattery, status.locked);
  }

  private applyState(contactDetected: boolean, lowBattery: boolean, locked: boolean | undefined): void {
    const contactState = contactDetected
      ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    const batteryState = lowBattery
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, contactState);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, batteryState);
    this.applyLockState(locked);
  }

  private configureLockService(initialLocked: boolean | undefined): Service | undefined {
    const existingService = this.accessory.getServiceById(this.platform.Service.LockMechanism, 'lock-state');
    if (!this.platform.exposeContactSensorLockState || initialLocked === undefined) {
      if (existingService) {
        this.accessory.removeService(existingService);
      }
      return undefined;
    }

    const service = existingService ||
      this.accessory.addService(
        this.platform.Service.LockMechanism,
        this.platform.formatHomeKitName(`${this.device.displayName} ロック`),
        'lock-state',
      );
    service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.platform.formatHomeKitName(`${this.device.displayName} ロック`),
    );
    service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(() => this.state.lockCurrentState);
    service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(() => this.state.lockTargetState)
      .onSet(this.setReadOnlyLockTarget.bind(this));
    this.platform.configureGroupedService(this.service, [service], true);

    return service;
  }

  private applyLockState(locked: boolean | undefined): void {
    if (!this.lockService) {
      return;
    }

    if (locked === true) {
      this.state.lockCurrentState = this.platform.Characteristic.LockCurrentState.SECURED;
      this.state.lockTargetState = this.platform.Characteristic.LockTargetState.SECURED;
    } else if (locked === false) {
      this.state.lockCurrentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
      this.state.lockTargetState = this.platform.Characteristic.LockTargetState.UNSECURED;
    } else {
      this.state.lockCurrentState = this.platform.Characteristic.LockCurrentState.UNKNOWN;
    }

    this.lockService.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.state.lockCurrentState);
    this.lockService.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.state.lockTargetState);
  }

  private async setReadOnlyLockTarget(value: CharacteristicValue): Promise<void> {
    this.platform.log.warn(
      `${this.device.displayName} lock target request ignored: contact sensor lock state is read-only (${value})`,
    );
    this.lockService?.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.state.lockTargetState);
  }

  private contactDetectedFromDevice(): boolean {
    if (this.device.wSensorVal) {
      return this.device.wSensorVal !== 'wsensor_val open';
    }

    if (this.device.lockVal) {
      return this.device.lockVal !== 'lock_val open';
    }

    return true;
  }

  private lockedFromValue(value: string | undefined): boolean | undefined {
    if (value === 'lock_val') {
      return true;
    }

    if (value === 'lock_val open') {
      return false;
    }

    return undefined;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
