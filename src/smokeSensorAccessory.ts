import { PlatformAccessory, Service } from 'homebridge';

import { SmokeSensorDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class SmokeSensorAccessory {
  private readonly service: Service;
  private readonly device: SmokeSensorDevice;

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as SmokeSensorDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Smoke Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.SmokeSensor) ||
      this.accessory.addService(this.platform.Service.SmokeSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

    this.updateSmokeState().catch(error => {
      this.platform.log.error(`Failed to update smoke sensor '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateSmokeState().catch(error => {
        this.platform.log.error(`Failed to update smoke sensor '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 5000);
  }

  async updateSmokeState(): Promise<void> {
    const status = await this.platform.client.getSmokeSensorStatus(this.device);
    const smokeState = status.smokeDetected
      ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    const lowBattery = status.lowBattery
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected, smokeState);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, lowBattery);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
