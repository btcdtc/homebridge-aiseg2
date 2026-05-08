import { PlatformAccessory, Service } from 'homebridge';

import { ContactSensorDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class ContactSensorAccessory {
  private readonly service: Service;
  private readonly device: ContactSensorDevice;

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

    this.applyState(
      this.device.wSensorVal !== 'wsensor_val open' && this.device.lockVal !== 'lock_val open',
      this.device.batteryUHF === 'U00' || this.device.batteryUHF === 'U01',
    );

    setInterval(() => {
      this.updateContactState().catch(error => {
        this.platform.log.error(`Failed to update contact sensor '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateContactState(): Promise<void> {
    const status = await this.platform.client.getContactSensorStatus(this.device);
    this.applyState(status.contactDetected, status.lowBattery);
  }

  private applyState(contactDetected: boolean, lowBattery: boolean): void {
    const contactState = contactDetected
      ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    const batteryState = lowBattery
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, contactState);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, batteryState);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
