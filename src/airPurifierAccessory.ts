import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AirPurifierStatus, CheckResult, OperationResponse } from './aiseg2Client';
import { AirPurifierDevice } from './devices';
import { Aiseg2Platform } from './platform';


enum AirPurifierMode {
  Stop = '0x40',
  Auto = '0x41',
  Weak = '0x42',
  Medium = '0x43',
  Strong = '0x44',
  Turbo = '0x45',
  Airy = '0x46',
  Eco = '0x47',
}

const EXTRA_MODE_SWITCHES = [
  {
    subtype: 'airy',
    name: 'エアミー',
    mode: AirPurifierMode.Airy,
  },
  {
    subtype: 'eco',
    name: '省エネ',
    mode: AirPurifierMode.Eco,
  },
];

export class AirPurifierAccessory {
  private readonly service: Service;
  private readonly smellService: Service;
  private readonly pm25Service: Service;
  private readonly dustService: Service;
  private readonly modeSwitchServices = new Map<AirPurifierMode, Service>();
  private readonly device: AirPurifierDevice;
  private pendingMode?: AirPurifierMode;
  private queuedMode?: AirPurifierMode;
  private modeActionSequence = 0;

  private state = {
    active: 0,
    currentState: 0,
    targetState: 1,
    rotationSpeed: 0,
    mode: AirPurifierMode.Stop,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirPurifierDevice;

    this.platform.configureAccessoryInformation(
      this.accessory,
      this.platform.client.echonetEndpointForAirPurifier(this.device)
        ? 'AiSEG2 Air Purifier (ECHONET Lite)'
        : 'AiSEG2 Air Purifier',
      this.device.uuidSeed,
    );

    const existingService = this.accessory.getService(this.platform.Service.AirPurifier);
    const serviceName = this.platform.formatHomeKitName(this.device.displayName);
    this.service = existingService || this.accessory.addService(this.platform.Service.AirPurifier, serviceName);
    if (!existingService) {
      this.service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(() => this.state.active);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(() => this.state.currentState);
    this.service.getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onSet(this.setTargetState.bind(this))
      .onGet(() => this.state.targetState);
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 25,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(() => this.state.rotationSpeed);

    this.smellService = this.getAirQualityService('smell', `${this.device.displayName} ニオイ`);
    this.pm25Service = this.getAirQualityService('pm25', `${this.device.displayName} PM2.5`);
    this.dustService = this.getAirQualityService('dust', `${this.device.displayName} ハウスダスト`);
    this.removeLegacyAutoModeSwitch();
    for (const modeSwitch of EXTRA_MODE_SWITCHES) {
      this.modeSwitchServices.set(
        modeSwitch.mode,
        this.getModeSwitchService(modeSwitch.subtype, `${this.device.displayName} ${modeSwitch.name}`, modeSwitch.mode),
      );
    }
    this.configureGroupedServices();

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air purifier '${this.device.displayName}': ${this.formatError(error)}`);
    });

    this.platform.registerInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air purifier '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(force = false): Promise<void> {
    const status = await this.platform.client.getAirPurifierStatus(this.device, force, force ? 'action' : 'normal');
    this.applyStatus(status);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.setMode(active ? this.defaultAutomaticMode() : AirPurifierMode.Stop);
  }

  async setTargetState(value: CharacteristicValue): Promise<void> {
    const mode = Number(value) === this.platform.Characteristic.TargetAirPurifierState.AUTO
      ? this.defaultAutomaticMode()
      : AirPurifierMode.Medium;
    await this.setMode(mode);
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const speed = Number(value);
    if (!Number.isFinite(speed)) {
      throw this.platform.invalidValueError();
    }

    await this.setMode(this.modeFromRotationSpeed(speed));
  }

  async setModeSwitch(mode: AirPurifierMode, value: CharacteristicValue): Promise<void> {
    if (value) {
      await this.setMode(mode);
      return;
    }

    if (this.state.mode === mode) {
      await this.setMode(AirPurifierMode.Stop);
      return;
    }

    this.platform.log.info(`${this.device.displayName} mode switch request ignored: ${this.formatMode(mode)} is not active`);
  }

  private async setMode(mode: AirPurifierMode): Promise<void> {
    this.platform.log.info(
      `${this.device.displayName} mode request: target=${this.formatMode(mode)}, current=${this.formatMode(this.state.mode)}`,
    );

    if (this.pendingMode !== undefined) {
      if (this.pendingMode !== mode) {
        this.queuedMode = mode;
        this.applyModeState(mode);
        this.platform.log.info(
          `${this.device.displayName} mode request queued: ${this.formatMode(mode)} ` +
          `while ${this.formatMode(this.pendingMode)} is still pending`,
        );
        return;
      }

      this.applyModeState(this.pendingMode);
      this.platform.log.warn(
        `${this.device.displayName} mode request ignored while ${this.formatMode(this.pendingMode)} is still pending`,
      );
      return;
    }

    if (this.state.mode === mode) {
      this.platform.log.info(`${this.device.displayName} mode request ignored: already ${this.formatMode(mode)}`);
      return;
    }

    const actionId = this.beginPendingMode(mode);
    this.applyModeState(mode);

    try {
      const token = this.platform.client.echonetEndpointForAirPurifier(this.device)
        ? ''
        : await this.platform.client.getAirPurifierControlToken(this.device);
      const response = await this.platform.client.changeAirPurifierMode(this.device, token, mode);
      this.platform.log.info(
        `${this.device.displayName} mode request accepted: target=${this.formatMode(mode)}, ` +
        `transport=${response.transport || 'AiSEG2'}${response.endpoint ? ` endpoint=${response.endpoint}` : ''}, ` +
        `acceptId=${response.acceptId ?? '-'}` +
        (response.fallbackReason ? `, fallback=${response.fallbackReason}` : ''),
      );

      this.applyModeState(mode);
      this.monitorModeAction(actionId, mode, response, response.token || token);
      if (this.queuedMode !== undefined) {
        this.clearPendingMode(actionId);
        this.runQueuedMode();
      }
    } catch (error) {
      this.clearPendingMode(actionId);
      this.platform.log.error(`${this.device.displayName} mode request failed: ${this.formatError(error)}`);
      await this.updateStatus(true);
      this.runQueuedMode();
      throw this.platform.homeKitError(error);
    }
  }

  private monitorModeAction(
    actionId: number,
    mode: AirPurifierMode,
    response: OperationResponse,
    token: string,
  ): void {
    void this.confirmAcceptedModeAction(actionId, mode, response, token).catch(error => {
      this.clearPendingMode(actionId);
      this.platform.log.error(`${this.device.displayName} post-mode refresh failed: ${this.formatError(error)}`);
      this.updateStatus(true).catch(refreshError => {
        this.platform.log.error(`${this.device.displayName} post-mode recovery refresh failed: ${this.formatError(refreshError)}`);
      });
    }).finally(() => {
      this.clearPendingMode(actionId);
      this.runQueuedMode();
    });
  }

  private async confirmAcceptedModeAction(
    actionId: number,
    mode: AirPurifierMode,
    response: OperationResponse,
    token: string,
  ): Promise<void> {
    await this.waitForAcceptedChange(response, token);
    if (actionId !== this.modeActionSequence) {
      return;
    }

    if (this.queuedMode !== undefined) {
      return;
    }

    await this.confirmMode(actionId, mode);
  }

  private applyStatus(status: AirPurifierStatus): void {
    const actualMode = this.modeFromStatus(status.mode);
    if (this.pendingMode !== undefined && actualMode !== this.pendingMode) {
      this.updateAirQualityServices(status);
      this.applyModeState(this.pendingMode);
      return;
    }

    this.state.active = status.active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.state.currentState = status.active
      ? this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
    this.state.targetState = this.isAutomaticMode(status.mode)
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
    this.state.rotationSpeed = this.rotationSpeedFromMode(status.mode);
    this.state.mode = this.modeFromStatus(status.mode);

    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState, this.state.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState, this.state.targetState);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
    this.updateAirQualityServices(status);
    this.updateModeSwitches();
  }

  private applyModeState(mode: AirPurifierMode): void {
    this.state.active = mode === AirPurifierMode.Stop
      ? this.platform.Characteristic.Active.INACTIVE
      : this.platform.Characteristic.Active.ACTIVE;
    this.state.currentState = mode === AirPurifierMode.Stop
      ? this.platform.Characteristic.CurrentAirPurifierState.INACTIVE
      : this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    this.state.targetState = this.isAutomaticMode(mode)
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
    this.state.rotationSpeed = this.rotationSpeedFromMode(mode);
    this.state.mode = mode;

    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState, this.state.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState, this.state.targetState);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
    this.updateModeSwitches();
  }

  private modeFromRotationSpeed(speed: number): AirPurifierMode {
    if (speed <= 0) {
      return AirPurifierMode.Stop;
    }

    if (speed <= 25) {
      return AirPurifierMode.Weak;
    }

    if (speed <= 50) {
      return AirPurifierMode.Medium;
    }

    if (speed <= 75) {
      return AirPurifierMode.Strong;
    }

    return AirPurifierMode.Turbo;
  }

  private rotationSpeedFromMode(mode: string): number {
    switch (mode) {
      case AirPurifierMode.Weak:
        return 25;
      case AirPurifierMode.Medium:
        return 50;
      case AirPurifierMode.Strong:
        return 75;
      case AirPurifierMode.Turbo:
        return 100;
      case AirPurifierMode.Auto:
      case AirPurifierMode.Airy:
      case AirPurifierMode.Eco:
        return 50;
      default:
        return 0;
    }
  }

  private isAutomaticMode(mode: string): boolean {
    return mode === AirPurifierMode.Auto || mode === AirPurifierMode.Airy || mode === AirPurifierMode.Eco;
  }

  private defaultAutomaticMode(): AirPurifierMode {
    if (this.state.mode === AirPurifierMode.Airy || this.state.mode === AirPurifierMode.Eco) {
      return this.state.mode;
    }

    return AirPurifierMode.Airy;
  }

  private modeFromStatus(mode: string): AirPurifierMode {
    if (Object.values(AirPurifierMode).includes(mode as AirPurifierMode)) {
      return mode as AirPurifierMode;
    }

    return AirPurifierMode.Stop;
  }

  private getAirQualityService(subtype: string, name: string): Service {
    const serviceName = this.platform.formatHomeKitName(name);
    const existingService = this.accessory.getServiceById(this.platform.Service.AirQualitySensor, subtype);
    const service = existingService ||
      this.accessory.addService(this.platform.Service.AirQualitySensor, serviceName, subtype);
    if (!existingService) {
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }

    return service;
  }

  private getModeSwitchService(subtype: string, name: string, mode: AirPurifierMode): Service {
    const formattedName = this.platform.formatHomeKitName(name);
    const existingService = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
    const service = existingService || this.accessory.addService(this.platform.Service.Switch, formattedName, subtype);
    if (!existingService) {
      service.displayName = formattedName;
      service.setCharacteristic(this.platform.Characteristic.Name, formattedName);
    }
    service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setModeSwitch.bind(this, mode))
      .onGet(() => this.state.mode === mode);

    return service;
  }

  private removeLegacyAutoModeSwitch(): void {
    const legacyService = this.accessory.getServiceById(this.platform.Service.Switch, 'auto');
    if (legacyService) {
      this.accessory.removeService(legacyService);
    }
  }

  private updateModeSwitches(): void {
    for (const [mode, service] of this.modeSwitchServices) {
      service.updateCharacteristic(this.platform.Characteristic.On, this.state.mode === mode);
    }
  }

  private configureGroupedServices(): void {
    this.platform.configureGroupedService(
      this.service,
      [
        this.smellService,
        this.pm25Service,
        this.dustService,
        ...this.modeSwitchServices.values(),
      ],
      this.platform.groupAirPurifierSensors,
    );
  }

  private updateAirQualityServices(status: AirPurifierStatus): void {
    this.updateAirQualityService(this.smellService, status.smellLevel);
    this.updateAirQualityService(this.pm25Service, status.pm25Level);
    this.updateAirQualityService(this.dustService, status.dustLevel);
  }

  private updateAirQualityService(service: Service, level: number | undefined): void {
    service.updateCharacteristic(this.platform.Characteristic.AirQuality, this.airQualityFromLevel(level));
  }

  private airQualityFromLevel(level: number | undefined): number {
    if (level === undefined) {
      return this.platform.Characteristic.AirQuality.UNKNOWN;
    }

    switch (Math.max(0, Math.min(4, level))) {
      case 0:
        return this.platform.Characteristic.AirQuality.EXCELLENT;
      case 1:
        return this.platform.Characteristic.AirQuality.GOOD;
      case 2:
        return this.platform.Characteristic.AirQuality.FAIR;
      case 3:
        return this.platform.Characteristic.AirQuality.INFERIOR;
      default:
        return this.platform.Characteristic.AirQuality.POOR;
    }
  }

  private async waitForAcceptedChange(response: OperationResponse, token: string): Promise<void> {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      throw new Error(`${this.device.displayName} update submission failed: ${this.platform.safeJson(response)}`);
    }

    const acceptId = Number(response.acceptId);
    if (!Number.isInteger(acceptId)) {
      return;
    }

    for (let count = 0; count < 3; count++) {
      await this.delay(1000);
      const result = await this.platform.client.checkAirPurifierChange(acceptId, this.device, token);

      if (result === CheckResult.OK) {
        return;
      }

      if (result === CheckResult.Invalid) {
        this.platform.log.debug(
          `${this.device.displayName} operation status expired for acceptId=${acceptId}; confirming by current state`,
        );
        return;
      }
    }

    this.platform.log.debug(
      `${this.device.displayName} operation status still pending for acceptId=${acceptId}; confirming by current state`,
    );
  }

  private async confirmMode(actionId: number, mode: AirPurifierMode): Promise<void> {
    let lastMode: AirPurifierMode | undefined;

    for (let count = 0; count < 10; count++) {
      if (actionId !== this.modeActionSequence || this.queuedMode !== undefined) {
        return;
      }

      await this.delay(1000);
      if (actionId !== this.modeActionSequence || this.queuedMode !== undefined) {
        return;
      }

      const status = await this.platform.client.getAirPurifierStatus(this.device, true, 'action');
      if (actionId !== this.modeActionSequence || this.queuedMode !== undefined) {
        return;
      }

      lastMode = this.modeFromStatus(status.mode);

      if (lastMode === mode) {
        this.applyStatus(status);
        this.platform.log.info(`${this.device.displayName} mode confirmed: ${this.formatMode(mode)}`);
        return;
      }

      this.updateAirQualityServices(status);
      this.applyModeState(mode);
    }

    throw new Error(`mode confirmation timed out: target=${this.formatMode(mode)}, current=${this.formatMode(lastMode)}`);
  }

  private beginPendingMode(mode: AirPurifierMode): number {
    const actionId = ++this.modeActionSequence;
    this.pendingMode = mode;
    return actionId;
  }

  private clearPendingMode(actionId: number): void {
    if (actionId === this.modeActionSequence) {
      this.pendingMode = undefined;
    }
  }

  private runQueuedMode(): void {
    if (this.queuedMode === undefined) {
      return;
    }

    const mode = this.queuedMode;
    this.queuedMode = undefined;
    void this.setMode(mode).catch(error => {
      this.platform.log.error(`${this.device.displayName} queued mode request failed: ${this.formatError(error)}`);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private formatMode(mode: AirPurifierMode | undefined): string {
    switch (mode) {
      case AirPurifierMode.Stop:
        return 'stop';
      case AirPurifierMode.Auto:
        return 'auto';
      case AirPurifierMode.Weak:
        return 'weak';
      case AirPurifierMode.Medium:
        return 'medium';
      case AirPurifierMode.Strong:
        return 'strong';
      case AirPurifierMode.Turbo:
        return 'turbo';
      case AirPurifierMode.Airy:
        return 'airme';
      case AirPurifierMode.Eco:
        return 'eco';
      default:
        return 'unknown';
    }
  }
}
