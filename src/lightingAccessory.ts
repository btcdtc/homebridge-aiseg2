import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { CheckResult, LightingChangeResponse, LightingStatus } from './aiseg2Client';
import { LightingDevice } from './devices';
import { LatestActionQueue } from './latestActionQueue';
import { Aiseg2Platform } from './platform';

enum LightState {
  On = '0x30',
  Off = '0x31',
}

type LightingAction =
  | { type: 'power'; state: boolean }
  | { type: 'brightness'; brightness: number };

export class LightingAccessory {
  private service: Service;
  private readonly supportsBrightness: boolean;
  private readonly actionQueue: LatestActionQueue<LightingAction>;

  // Accessory state tracking data
  private States = {
    On: false,
    Brightness: 100,
    Token: '',
    BlockUpdate: 0,
    UpdatingState: false,
  };

  private pendingLightingState?: Partial<LightingStatus>;
  private lightingActionSequence = 0;

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    const deviceData = accessory.context.device as LightingDevice;
    this.supportsBrightness = deviceData.dimmable !== false;
    this.actionQueue = new LatestActionQueue(this.performLightingAction.bind(this));

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
      this.platform.formatHomeKitName(deviceData.displayName),
    );
    this.States.On = deviceData.state === 'on';
    this.States.Brightness = deviceData.brightness || 100;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.States.On);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below

    if (this.supportsBrightness) {
      // register handlers for the Brightness Characteristic
      this.service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setBrightness.bind(this))       // SET - bind to the 'setBrightness` method below
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 20,
          validValues: [0, 20, 40, 60, 80, 100],
        });
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.States.Brightness);
    } else if (this.service.testCharacteristic(this.platform.Characteristic.Brightness)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(this.platform.Characteristic.Brightness));
      this.platform.log.info(`${deviceData.displayName} brightness control disabled: device does not support dimming`);
    }

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
    const deviceData = this.accessory.context.device;

    if (this.pendingLightingState?.state === requestedState) {
      this.applyPendingLightingState(deviceData, this.pendingLightingState);
      this.platform.log.warn(`${deviceData.displayName} power request ignored while ${requestedState ? 'ON' : 'OFF'} is still pending`);
      return;
    }

    if (!this.actionQueue.isRunning && requestedState === this.States.On) {
      this.platform.log.info(`${deviceData.displayName} power request ignored: already ${requestedState ? 'ON' : 'OFF'}`);
      return;
    }

    if (this.actionQueue.isRunning) {
      this.pendingLightingState = { state: requestedState };
      this.applyPendingLightingState(deviceData, this.pendingLightingState);
      this.platform.log.info(`${deviceData.displayName} power request queued: ${requestedState ? 'ON' : 'OFF'}`);
    }

    this.queueLightingAction({ type: 'power', state: requestedState });
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
      this.platform.log.warn(`${deviceData.displayName} brightness request rejected: device does not support brightness control`);
      throw new Error(`${deviceData.displayName} does not support brightness control`);
    }

    if (Number(value) <= 0) {
      this.platform.log.info(`${deviceData.displayName} brightness request: 0% maps to OFF`);
      await this.setOn(false);
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, 0);
      this.States.Brightness = 0;
      return;
    }

    const brightness = this.normalizeBrightness(value);
    this.States.Brightness = brightness;
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);

    if (this.pendingLightingState?.state === true && this.pendingLightingState.brightness === brightness) {
      this.applyPendingLightingState(deviceData, this.pendingLightingState);
      this.platform.log.warn(`${deviceData.displayName} brightness request ignored while ${brightness}% is still pending`);
      return;
    }

    if (this.actionQueue.isRunning) {
      this.pendingLightingState = { state: true, brightness };
      this.applyPendingLightingState(deviceData, this.pendingLightingState);
      this.platform.log.info(`${deviceData.displayName} brightness request queued: ${brightness}%`);
    }

    this.queueLightingAction({ type: 'brightness', brightness });
  }

  private queueLightingAction(action: LightingAction): void {
    void this.actionQueue.enqueue(action).catch(error => {
      this.platform.log.debug(`Lighting action queue stopped: ${this.formatError(error)}`);
    });
  }

  private async performLightingAction(action: LightingAction): Promise<void> {
    const deviceData = this.accessory.context.device;
    const expected = this.expectedStateForAction(action);
    const actionId = this.beginPendingLightingState(expected);

    this.States.BlockUpdate = 10;
    this.platform.log.info(`${deviceData.displayName} ${this.formatLightingActionRequest(action)}`);

    try {
      await this.ensureControlToken();
      const response = await this.sendLightingAction(action);
      this.platform.log.info(
        `${deviceData.displayName} ${this.formatLightingActionAccepted(action, response)}`,
      );

      const result = await this.waitForAcceptedChange(response);
      if (result !== true) {
        throw new Error(`${deviceData.displayName} update submission failed: ${JSON.stringify(response)}`);
      }

      if (this.actionQueue.hasQueued) {
        this.platform.log.info(
          `${deviceData.displayName} ${this.formatLightingActionSkipped(action)}: newer request is queued`,
        );
        return;
      }

      this.applyPendingLightingState(deviceData, expected);
      this.States.BlockUpdate = 2;
      this.platform.log.info(`${deviceData.displayName} ${this.formatLightingActionComplete(action)}`);
      await this.confirmLightingState(actionId, expected, action);
    } catch (error) {
      this.clearPendingLightingState(actionId);
      this.States.BlockUpdate = 2;
      this.platform.log.error(`${deviceData.displayName} ${this.formatLightingActionFailed(action)}: ${this.formatError(error)}`);
      this.updateLightingState(true).catch(refreshError => {
        this.platform.log.error(`${deviceData.displayName} post-failure refresh failed: ${this.formatError(refreshError)}`);
      });
      throw error;
    }
  }

  private updateHomeKitState(deviceData: LightingDevice, status: LightingStatus): void {
    if (this.pendingLightingState && !this.lightingStatusMatches(status, this.pendingLightingState)) {
      this.applyPendingLightingState(deviceData, this.pendingLightingState, status);
      return;
    }

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

  private applyPendingLightingState(
    deviceData: LightingDevice,
    pendingState: Partial<LightingStatus>,
    status?: LightingStatus,
  ): void {
    const onState = pendingState.state ?? status?.state;
    if (onState !== undefined) {
      this.States.On = onState;
      this.service.updateCharacteristic(this.platform.Characteristic.On, onState);
    }

    const brightness = pendingState.brightness ?? status?.brightness;
    if (deviceData.dimmable !== false && brightness !== undefined) {
      this.States.Brightness = brightness;
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
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

  private async sendLightingAction(action: LightingAction): Promise<LightingChangeResponse> {
    const deviceData = this.accessory.context.device;
    if (action.type === 'power') {
      const onOff = action.state
        ? LightState.On
        : LightState.Off;
      return this.platform.client.changeLighting(deviceData, this.States.Token, onOff, '-');
    }

    return this.platform.client.changeLighting(
      deviceData,
      this.States.Token,
      '-',
      this.formatBrightnessLevel(action.brightness),
    );
  }

  private async confirmLightingState(
    actionId: number,
    expected: Partial<LightingStatus>,
    action: LightingAction,
  ): Promise<void> {
    const deviceData = this.accessory.context.device;
    let lastStatus: LightingStatus | undefined;
    const maxAttempts = action.type === 'brightness' ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (let count = 0; count < 10; count++) {
        if (actionId !== this.lightingActionSequence || this.actionQueue.hasQueued) {
          return;
        }

        await this.delay(1000);
        if (actionId !== this.lightingActionSequence || this.actionQueue.hasQueued) {
          return;
        }

        const status = await this.platform.client.getLightingStatus(deviceData, true);
        if (actionId !== this.lightingActionSequence || this.actionQueue.hasQueued) {
          return;
        }

        lastStatus = status;
        this.updateHomeKitState(deviceData, status);

        if (this.lightingStatusMatches(status, expected)) {
          this.clearPendingLightingState(actionId);
          this.States.BlockUpdate = 0;
          this.platform.log.info(`${deviceData.displayName} state confirmed after action`);
          return;
        }
      }

      if (attempt < maxAttempts - 1 && action.type === 'brightness') {
        this.platform.log.warn(
          `${deviceData.displayName} state confirmation timed out: target=${action.brightness}%, ` +
          `current=${lastStatus?.brightness ?? 'unknown'}%; retrying brightness request`,
        );
        await this.ensureControlToken();
        const response = await this.sendLightingAction(action);
        this.platform.log.info(
          `${deviceData.displayName} brightness retry accepted: target=${action.brightness}%, acceptId=${response.acceptId ?? '-'}`,
        );
        await this.waitForAcceptedChange(response);
      }
    }

    this.clearPendingLightingState(actionId);
    this.States.BlockUpdate = 0;
    if (lastStatus) {
      this.updateHomeKitState(deviceData, lastStatus);
      this.platform.log.warn(`${deviceData.displayName} state confirmation timed out after action`);
    }
  }

  private beginPendingLightingState(expected: Partial<LightingStatus>): number {
    const actionId = ++this.lightingActionSequence;
    this.pendingLightingState = expected;
    return actionId;
  }

  private clearPendingLightingState(actionId: number): void {
    if (actionId === this.lightingActionSequence) {
      this.pendingLightingState = undefined;
    }
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

  private expectedStateForAction(action: LightingAction): Partial<LightingStatus> {
    if (action.type === 'power') {
      return { state: action.state };
    }

    return { state: true, brightness: action.brightness };
  }

  private formatLightingActionRequest(action: LightingAction): string {
    if (action.type === 'power') {
      return `power request: ${action.state ? 'ON' : 'OFF'}`;
    }

    return `brightness request: ${action.brightness}%`;
  }

  private formatLightingActionAccepted(action: LightingAction, response: LightingChangeResponse): string {
    if (action.type === 'power') {
      return `power request accepted: acceptId=${response.acceptId ?? '-'}`;
    }

    return `brightness request accepted: acceptId=${response.acceptId ?? '-'}`;
  }

  private formatLightingActionSkipped(action: LightingAction): string {
    if (action.type === 'power') {
      return `power request ${action.state ? 'ON' : 'OFF'} confirmation skipped`;
    }

    return `brightness request ${action.brightness}% confirmation skipped`;
  }

  private formatLightingActionComplete(action: LightingAction): string {
    if (action.type === 'power') {
      return `switched ${action.state ? 'ON' : 'OFF'}`;
    }

    return `brightness set to ${action.brightness}%`;
  }

  private formatLightingActionFailed(action: LightingAction): string {
    if (action.type === 'power') {
      return 'state update failed';
    }

    return 'brightness update failed';
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
