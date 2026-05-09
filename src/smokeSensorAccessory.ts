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

    this.platform.configureAccessoryInformation(this.accessory, 'AiSEG2 Smoke Sensor', this.device.uuidSeed);

    const existingService = this.accessory.getService(this.platform.Service.SmokeSensor);
    const serviceName = this.platform.formatHomeKitName(this.device.displayName);
    this.service = existingService || this.accessory.addService(this.platform.Service.SmokeSensor, serviceName);
    if (!existingService) {
      this.service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }

    this.applyState(
      Boolean(this.device.color) || Boolean(this.device.time && this.device.time !== '-'),
      this.device.battVisible !== undefined && this.device.battVisible !== 'hidden',
    );

    this.platform.registerInterval(() => {
      this.updateSmokeState().catch(error => {
        this.platform.log.error(`Failed to update smoke sensor '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateSmokeState(): Promise<void> {
    const status = await this.platform.client.getSmokeSensorStatus(this.device);
    this.applyState(status.smokeDetected, status.lowBattery);
  }

  private applyState(smokeDetected: boolean, lowBattery: boolean): void {
    const smokeState = smokeDetected
      ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    const batteryState = lowBattery
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected, smokeState);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, batteryState);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
