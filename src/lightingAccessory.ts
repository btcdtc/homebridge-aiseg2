import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { CheckResult, LightingChangeResponse, LightingStatus } from './aiseg2Client';
import { LightingDevice } from './devices';
import { Aiseg2Platform } from './platform';

enum LightState {
  On = '0x30',
  Off = '0x31',
}

export class LightingAccessory {
  private service: Service;

  // Accessory state tracking data
  private States = {
    On: false,
    Brightness: 100,
    Token: '',
    BlockUpdate: 0,
    UpdatingState: false,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name for display as the default name in the Home app
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.platform.formatHomeKitName(accessory.context.device.displayName),
    );
    this.States.On = accessory.context.device.state === 'on';
    this.States.Brightness = accessory.context.device.brightness || 100;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.States.On);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this));       // SET - bind to the 'setBrightness` method below

    // set brightness properties for the lightbulb device
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 20,
      });
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.States.Brightness);

    // Get a control token from the AiSEG2 controller
    this.updateControlToken().catch(error => {
      this.platform.log.error(`Failed to update control token for '${accessory.context.device.displayName}': ${this.formatError(error)}`);
    });

    // Refresh the control token every 15 seconds
    setInterval(() => {
      this.updateControlToken().catch(error => {
        this.platform.log.error(`Failed to update control token for '${accessory.context.device.displayName}': ${this.formatError(error)}`);
      });
    }, 15000);

    // Update lighting accessory characteristics values asynchronously
    setInterval(() => {
      this.updateLightingState().catch(error => {
        this.platform.log.error(
          `Failed to update lighting state for '${accessory.context.device.displayName}': ${this.formatError(error)}`,
        );
      });
    }, 5000);
  }

  // Fetch the current state of an AiSEG2 lighting device
  async updateLightingState(force = false): Promise<void> {
    if (!force && this.States.BlockUpdate >= 1) {
      this.States.BlockUpdate--;
      return;
    }

    if (this.States.UpdatingState) {
      return;
    }

    this.States.UpdatingState = true;
    const deviceData = this.accessory.context.device;
    try {
      const status = await this.platform.client.getLightingStatus(deviceData, force);
      this.updateHomeKitState(deviceData, status);
    } finally {
      this.States.UpdatingState = false;
    }
  }

  // Fetch the latest token to use for AiSEG2 device action requests
  async updateControlToken(): Promise<void> {
    this.platform.log.debug('Fetching control token from AiSEG2');
    this.States.Token = await this.platform.client.getControlToken();
    this.platform.log.debug(`Retrieved control token '${this.States.Token}'`);
  }

  // Poll for the execution status of an async AiSEG2 change request
  async checkStatus(acceptId: number): Promise<boolean> {
    this.States.BlockUpdate = 10;
    for (let count = 0; count < 6; count++) {
      await this.delay(500);
      this.platform.log.debug(`Polling status of async request ID ${acceptId}`);
      const result = await this.platform.client.checkLightingChange(acceptId);

      switch (result) {
        case CheckResult.OK:
          this.platform.log.debug(`Device state change for ${this.accessory.context.device.displayName} completed successfully`);
          this.States.BlockUpdate = 2;
          return true;
        case CheckResult.InProgress:
          break;
        case CheckResult.Invalid:
          this.platform.log.debug(`Device state change for ${this.accessory.context.device.displayName} is unknown`);
          this.States.BlockUpdate = 2;
          return false;
      }
    }

    this.platform.log.error(`Timed out waiting for accessory '${this.accessory.context.device.displayName}' to update state`);
    this.States.BlockUpdate = 2;
    return false;
  }

  // Handle set on requests from HomeKit
  async setOn(value: CharacteristicValue): Promise<void> {
    const requestedState = Boolean(value);
    if (requestedState === this.States.On) {
      return;
    }

    const onOff = requestedState
      ? LightState.On
      : LightState.Off;

    const deviceData = this.accessory.context.device;
    this.States.BlockUpdate = 10;

    try {
      await this.ensureControlToken();
      const response = await this.platform.client.changeLighting(deviceData, this.States.Token, onOff, '-');
      this.platform.log.debug(`Response: '${JSON.stringify(response)}'`);

      const result = await this.waitForAcceptedChange(response);

      if (result === true) {
        this.service.updateCharacteristic(this.platform.Characteristic.On, requestedState);

        this.States.On = requestedState;
        this.States.BlockUpdate = 2;

        this.platform.log.info(`${deviceData.displayName} switched ${requestedState ? 'ON' : 'OFF'}`);
        this.confirmLightingState({ state: requestedState }).catch(error => {
          this.platform.log.error(`${deviceData.displayName} post-update refresh failed: ${this.formatError(error)}`);
        });
      } else {
        throw new Error(`${deviceData.displayName} update submission failed: ${JSON.stringify(response)}`);
      }
    } catch (error) {
      this.States.BlockUpdate = 2;
      this.platform.log.error(`${deviceData.displayName} state update failed: ${this.formatError(error)}`);
      throw error;
    }
  }

  // Handle get on requests from HomeKit
  async getOn(): Promise<CharacteristicValue> {
    const deviceData = this.accessory.context.device;

    this.platform.log.debug(`Requested state for ${deviceData.displayName} is ${this.States.On ? 'ON' : 'OFF'}`);
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.States.On);

    return this.States.On;
  }

  // Handle set brightness requests from HomeKit
  async setBrightness(value: CharacteristicValue): Promise<void> {
    const deviceData = this.accessory.context.device;
    if (deviceData.dimmable === false) {
      throw new Error(`${deviceData.displayName} does not support brightness control`);
    }

    if (Number(value) <= 0) {
      await this.setOn(false);
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, 0);
      this.States.Brightness = 0;
      return;
    }

    const brightness = this.normalizeBrightness(value);
    this.States.BlockUpdate = 10;

    try {
      await this.ensureControlToken();
      const response = await this.platform.client.changeLighting(
        deviceData,
        this.States.Token,
        '-',
        this.formatBrightnessLevel(brightness),
      );

      const result = await this.waitForAcceptedChange(response);

      if (result === true) {
        this.service.updateCharacteristic(this.platform.Characteristic.On, true);
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);

        this.States.On = true;
        this.States.Brightness = brightness;
        this.States.BlockUpdate = 2;

        this.platform.log.info(`${deviceData.displayName} brightness set to ${brightness}%`);
        this.confirmLightingState({ state: true, brightness }).catch(error => {
          this.platform.log.error(`${deviceData.displayName} post-brightness refresh failed: ${this.formatError(error)}`);
        });
      } else {
        throw new Error(`${deviceData.displayName} brightness update failed: ${JSON.stringify(response)}`);
      }
    } catch (error) {
      this.States.BlockUpdate = 2;
      this.platform.log.error(`${deviceData.displayName} brightness update failed: ${this.formatError(error)}`);
      throw error;
    }
  }

  private updateHomeKitState(deviceData: LightingDevice, status: LightingStatus): void {
    if (status.state !== this.States.On) {
      this.States.On = status.state;
      this.platform.log.info(`${deviceData.displayName} state changed to ${status.state ? 'ON' : 'OFF'}`);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.On, status.state);

    if (status.dimmable && status.brightness !== undefined) {
      if (status.brightness !== this.States.Brightness) {
        this.States.Brightness = status.brightness;
        this.platform.log.info(`${deviceData.displayName} brightness changed to ${this.States.Brightness}%`);
      }
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.States.Brightness);
    }
  }

  private async ensureControlToken(): Promise<void> {
    if (!this.States.Token) {
      await this.updateControlToken();
    }
  }

  private async waitForAcceptedChange(response: LightingChangeResponse): Promise<boolean> {
    const acceptId = Number(response.acceptId);
    if (Number.isInteger(acceptId)) {
      return this.checkStatus(acceptId);
    }

    return true;
  }

  private async confirmLightingState(expected: Partial<LightingStatus>): Promise<void> {
    const deviceData = this.accessory.context.device;

    for (let count = 0; count < 6; count++) {
      await this.delay(750);
      const status = await this.platform.client.getLightingStatus(deviceData, true);
      this.updateHomeKitState(deviceData, status);

      if (this.lightingStatusMatches(status, expected)) {
        this.States.BlockUpdate = 0;
        return;
      }
    }

    this.States.BlockUpdate = 0;
  }

  private lightingStatusMatches(status: LightingStatus, expected: Partial<LightingStatus>): boolean {
    if (expected.state !== undefined && status.state !== expected.state) {
      return false;
    }

    if (expected.brightness !== undefined && status.brightness !== expected.brightness) {
      return false;
    }

    return true;
  }

  private normalizeBrightness(value: CharacteristicValue): number {
    const brightness = Number(value);
    if (!Number.isFinite(brightness)) {
      throw new Error(`Invalid brightness value '${value}'`);
    }

    const steppedBrightness = Math.round(brightness / 20) * 20;
    return Math.max(20, Math.min(100, steppedBrightness));
  }

  private formatBrightnessLevel(brightness: number): string {
    const level = Math.max(1, Math.min(5, Math.round(brightness / 20)));
    return `0x${level.toString(16)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
