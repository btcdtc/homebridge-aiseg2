import { PlatformAccessory, Service } from 'homebridge';

import { AirEnvironmentSensorDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class AirEnvironmentSensorAccessory {
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly device: AirEnvironmentSensorDevice;

  private state = {
    temperature: 0,
    humidity: 0,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirEnvironmentSensorDevice;

    this.platform.configureAccessoryInformation(this.accessory, 'AiSEG2 Air Environment Sensor', this.device.uuidSeed);

    const temperatureServiceName = this.platform.formatHomeKitName(`${this.device.displayName} 温度`);
    const existingTemperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);
    this.temperatureService = existingTemperatureService ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, temperatureServiceName);
    if (!existingTemperatureService) {
      this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, temperatureServiceName);
    }

    const humidityServiceName = this.platform.formatHomeKitName(`${this.device.displayName} 湿度`);
    const existingHumidityService = this.accessory.getService(this.platform.Service.HumiditySensor);
    this.humidityService = existingHumidityService ||
      this.accessory.addService(this.platform.Service.HumiditySensor, humidityServiceName);
    if (!existingHumidityService) {
      this.humidityService.setCharacteristic(this.platform.Characteristic.Name, humidityServiceName);
    }
    this.platform.configureGroupedService(
      this.temperatureService,
      [this.humidityService],
      this.platform.groupAirEnvironmentSensors,
    );

    this.applyState(this.device.temperature, this.device.humidity);

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air environment sensor '${this.device.displayName}': ${this.formatError(error)}`);
    });

    this.platform.registerInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air environment sensor '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(): Promise<void> {
    const status = await this.platform.client.getAirEnvironmentStatus(this.device);
    this.applyState(status.temperature, status.humidity);
  }

  private applyState(temperature: number | undefined, humidity: number | undefined): void {
    if (temperature !== undefined) {
      this.state.temperature = temperature;
    }

    if (humidity !== undefined) {
      this.state.humidity = humidity;
    }

    this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.temperature);
    this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.state.humidity);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
