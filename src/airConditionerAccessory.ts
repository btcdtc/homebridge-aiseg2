import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  AirConditionerCapabilities,
  AirConditionerFanMode,
  AirConditionerMode,
  AirConditionerOperationResponse,
  AirConditionerStatus,
  CheckResult,
} from './aiseg2Client';
import { AirConditionerControlOption, AirConditionerDevice } from './devices';
import { Aiseg2Platform } from './platform';


type AirConditionerAction =
  | {
    kind: 'mode';
    mode: string;
  }
  | {
    kind: 'temperature';
    temperature: number;
  }
  | {
    kind: 'fanMode';
    fanMode: string;
  };

interface RotationSpeedProps {
  minValue: number;
  maxValue: number;
  minStep: number;
  validValues?: number[];
}

const DEFAULT_AIRCON_MODES: AirConditionerControlOption[] = [
  { value: AirConditionerMode.Stop, label: '停止', disabled: false },
  { value: AirConditionerMode.Auto, label: '自動', disabled: false },
  { value: AirConditionerMode.Cool, label: '冷房', disabled: false },
  { value: AirConditionerMode.Heat, label: '暖房', disabled: false },
];

const SPECIAL_MODE_SWITCHES = [
  AirConditionerMode.Dry,
  AirConditionerMode.Fan,
  AirConditionerMode.Humidify,
  AirConditionerMode.HumidifyHeat,
];

export class AirConditionerAccessory {
  private readonly service: Service;
  private readonly device: AirConditionerDevice;
  private readonly capabilities: AirConditionerCapabilities;
  private indoorHumidityService?: Service;
  private outdoorTemperatureService?: Service;
  private fanService?: Service;
  private humidifierService?: Service;
  private readonly modeSwitchServices = new Map<string, Service>();
  private pendingAction?: AirConditionerAction;
  private queuedAction?: AirConditionerAction;
  private actionSequence = 0;

  private state = {
    mode: AirConditionerMode.Stop as string,
    active: 0,
    currentHeaterCoolerState: 0,
    targetHeaterCoolerState: 0,
    currentTemperature: 20,
    targetTemperature: 25,
    currentHumidity: undefined as number | undefined,
    outdoorTemperature: undefined as number | undefined,
    fanMode: AirConditionerFanMode.Auto as string,
    rotationSpeed: 0,
    fanActive: 0,
    fanCurrentState: 0,
    fanTargetState: 1,
    humidifierActive: 0,
    currentHumidifierDehumidifierState: 0,
    targetHumidifierDehumidifierState: 2,
    minTemperature: 16,
    maxTemperature: 30,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as AirConditionerDevice;
    this.capabilities = this.capabilitiesFromDevice();
    this.state.currentTemperature = this.device.currentTemperature ?? this.state.currentTemperature;
    this.state.targetTemperature = this.device.targetTemperature ?? this.capabilities.targetTemperature ?? this.state.targetTemperature;
    this.state.currentHumidity = this.device.currentHumidity;
    this.state.outdoorTemperature = this.device.outdoorTemperature;
    this.state.fanMode = this.device.fanMode || this.capabilities.currentFanMode || this.state.fanMode;
    this.state.minTemperature = this.device.minTemperature ?? this.capabilities.minTemperature ?? this.state.minTemperature;
    this.state.maxTemperature = this.device.maxTemperature ?? this.capabilities.maxTemperature ?? this.state.maxTemperature;
    this.state.targetHumidifierDehumidifierState = this.defaultHumidifierTargetState();

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Air Conditioner')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    const legacyThermostat = this.accessory.getService(this.platform.Service.Thermostat);
    if (legacyThermostat) {
      this.accessory.removeService(legacyThermostat);
    }

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));
    this.configureHeaterCoolerService();
    this.fanService = this.configureFanService();
    this.humidifierService = this.configureHumidifierService();
    this.configureModeSwitchServices();

    this.applyStatus({
      state: this.device.state || '0x31',
      mode: this.device.mode || AirConditionerMode.Auto,
      modeLabel: this.device.modeLabel,
      fanMode: this.device.fanMode,
      fanModeLabel: this.device.fanModeLabel,
      active: this.device.state === '0x30',
      currentTemperature: this.device.currentTemperature,
      targetTemperature: this.device.targetTemperature,
      currentHumidity: this.device.currentHumidity,
      outdoorTemperature: this.device.outdoorTemperature,
    });

    this.updateStatus().catch(error => {
      this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update air conditioner '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(force = false): Promise<void> {
    const status = await this.platform.client.getAirConditionerStatus(this.device, force);
    this.applyStatus(status);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.setMode(active ? this.modeForTargetHeaterCoolerState(this.state.targetHeaterCoolerState) : AirConditionerMode.Stop);
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue): Promise<void> {
    const targetState = Number(value);
    this.state.targetHeaterCoolerState = targetState;
    await this.setMode(this.modeForTargetHeaterCoolerState(targetState));
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const temperature = this.normalizeTemperature(value);
    await this.runAction({ kind: 'temperature', temperature });
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const fanMode = this.fanModeFromRotationSpeed(Number(value));
    await this.runAction({ kind: 'fanMode', fanMode });
  }

  async setFanActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    if (active) {
      await this.setMode(AirConditionerMode.Fan);
      return;
    }

    if (this.state.mode === AirConditionerMode.Fan) {
      await this.setMode(AirConditionerMode.Stop);
      return;
    }

    this.platform.log.info(`${this.device.displayName} fan mode request ignored: fan mode is not active`);
    this.syncHomeKitState();
  }

  async setFanTargetState(value: CharacteristicValue): Promise<void> {
    const fanMode = Number(value) === this.platform.Characteristic.TargetFanState.AUTO
      ? AirConditionerFanMode.Auto
      : this.firstManualFanMode();
    await this.runAction({ kind: 'fanMode', fanMode });
  }

  async setHumidifierDehumidifierActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    if (active) {
      await this.setMode(this.modeForHumidifierTargetState());
      return;
    }

    if (this.state.mode === AirConditionerMode.HumidifyHeat) {
      await this.setMode(this.supportsMode(AirConditionerMode.Heat) ? AirConditionerMode.Heat : AirConditionerMode.Stop);
      return;
    }

    if (this.isHumidityMode(this.state.mode)) {
      await this.setMode(AirConditionerMode.Stop);
      return;
    }

    this.platform.log.info(`${this.device.displayName} humidity mode request ignored: humidity mode is not active`);
    this.syncHomeKitState();
  }

  async setTargetHumidifierDehumidifierState(value: CharacteristicValue): Promise<void> {
    this.state.targetHumidifierDehumidifierState = Number(value);
    this.humidifierService?.updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.state.targetHumidifierDehumidifierState,
    );

    if (this.state.humidifierActive === this.platform.Characteristic.Active.ACTIVE) {
      await this.setMode(this.modeForHumidifierTargetState());
    }
  }

  async setModeSwitch(mode: string, value: CharacteristicValue): Promise<void> {
    if (value) {
      await this.setMode(mode);
      return;
    }

    if (this.state.mode === mode) {
      await this.setMode(mode === AirConditionerMode.HumidifyHeat && this.supportsMode(AirConditionerMode.Heat)
        ? AirConditionerMode.Heat
        : AirConditionerMode.Stop);
      return;
    }

    this.platform.log.info(`${this.device.displayName} mode switch request ignored: ${this.formatMode(mode)} is not active`);
    this.updateModeSwitches();
  }

  private async setMode(mode: string): Promise<void> {
    if (!this.supportsMode(mode)) {
      this.platform.log.warn(`${this.device.displayName} mode request rejected: ${this.formatMode(mode)} is not supported`);
      this.syncHomeKitState();
      return;
    }

    await this.runAction({ kind: 'mode', mode });
  }

  private async runAction(action: AirConditionerAction): Promise<void> {
    this.platform.log.info(
      `${this.device.displayName} ${this.actionLabel(action)} request: current=${this.currentActionState(action)}`,
    );

    if (this.pendingAction) {
      if (!this.sameAction(this.pendingAction, action)) {
        this.queuedAction = action;
        this.applyOptimisticAction(action);
        this.platform.log.info(
          `${this.device.displayName} ${this.actionLabel(action)} request queued: ` +
          `${this.actionTarget(action)} while ${this.actionLabel(this.pendingAction)} is still pending`,
        );
        return;
      }

      this.applyOptimisticAction(this.pendingAction);
      this.platform.log.warn(
        `${this.device.displayName} ${this.actionLabel(action)} request ignored while ${this.actionLabel(this.pendingAction)} is pending`,
      );
      return;
    }

    if (this.actionAlreadyCurrent(action)) {
      this.applyOptimisticAction(action);
      this.platform.log.info(
        `${this.device.displayName} ${this.actionLabel(action)} request ignored: already ${this.actionTarget(action)}`,
      );
      return;
    }

    const actionId = this.beginPendingAction(action);
    this.applyOptimisticAction(action);

    try {
      const response = await this.submitAction(action);
      this.platform.log.info(
        `${this.device.displayName} ${this.actionLabel(action)} request accepted: ` +
        `target=${this.actionTarget(action)}, acceptId=${response.acceptId ?? '-'}`,
      );
      this.monitorAction(actionId, action, response);
      if (this.queuedAction) {
        this.clearPendingAction(actionId);
        this.runQueuedAction();
      }
    } catch (error) {
      this.clearPendingAction(actionId);
      this.platform.log.error(`${this.device.displayName} ${this.actionLabel(action)} request failed: ${this.formatError(error)}`);
      await this.updateStatus(true);
      this.runQueuedAction();
      throw error;
    }
  }

  private monitorAction(
    actionId: number,
    action: AirConditionerAction,
    response: AirConditionerOperationResponse,
  ): void {
    void this.confirmAcceptedAction(actionId, action, response).catch(error => {
      this.clearPendingAction(actionId);
      this.platform.log.error(`${this.device.displayName} post-${this.actionLabel(action)} refresh failed: ${this.formatError(error)}`);
      this.updateStatus(true).catch(refreshError => {
        this.platform.log.error(
          `${this.device.displayName} post-${this.actionLabel(action)} recovery refresh failed: ${this.formatError(refreshError)}`,
        );
      });
    }).finally(() => {
      this.clearPendingAction(actionId);
      this.runQueuedAction();
    });
  }

  private async confirmAcceptedAction(
    actionId: number,
    action: AirConditionerAction,
    response: AirConditionerOperationResponse,
  ): Promise<void> {
    await this.waitForAcceptedChange(response);
    if (actionId !== this.actionSequence || this.queuedAction) {
      return;
    }

    await this.confirmActionState(actionId, action);
  }

  private async submitAction(action: AirConditionerAction): Promise<AirConditionerOperationResponse> {
    switch (action.kind) {
      case 'mode':
        return this.platform.client.changeAirConditionerMode(this.device, action.mode);
      case 'temperature':
        return this.platform.client.changeAirConditionerTemperature(this.device, action.temperature);
      case 'fanMode':
        return this.platform.client.changeAirConditionerFanMode(this.device, action.fanMode);
    }
  }

  private applyStatus(status: AirConditionerStatus): void {
    if (this.pendingAction && !this.actionMatchesStatus(this.pendingAction, status)) {
      this.applyMeasurements(status);
      return;
    }

    const nativeTarget = this.nativeTargetStateForMode(status.mode);
    if (nativeTarget !== undefined) {
      this.state.targetHeaterCoolerState = nativeTarget;
    }
    this.state.mode = status.active ? status.mode : AirConditionerMode.Stop;

    if (status.fanMode) {
      this.state.fanMode = status.fanMode;
    }

    this.applyMeasurements(status);
    this.syncHomeKitState();
  }

  private applyMeasurements(status: AirConditionerStatus): void {
    if (status.currentTemperature !== undefined) {
      this.state.currentTemperature = status.currentTemperature;
    }

    if (status.targetTemperature !== undefined) {
      this.state.targetTemperature = status.targetTemperature;
    }

    if (status.currentHumidity !== undefined) {
      this.state.currentHumidity = status.currentHumidity;
    }

    if (status.outdoorTemperature !== undefined) {
      this.state.outdoorTemperature = status.outdoorTemperature;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    this.updateTemperatureTargets();
    this.applySupplementalServices(this.state.currentHumidity, this.state.outdoorTemperature);
  }

  private applyOptimisticAction(action: AirConditionerAction): void {
    switch (action.kind) {
      case 'mode': {
        const nativeTarget = this.nativeTargetStateForMode(action.mode);
        if (nativeTarget !== undefined) {
          this.state.targetHeaterCoolerState = nativeTarget;
        }
        this.state.mode = action.mode;
        break;
      }
      case 'temperature':
        this.state.targetTemperature = action.temperature;
        break;
      case 'fanMode':
        this.state.fanMode = action.fanMode;
        break;
    }

    this.syncHomeKitState();
  }

  private syncHomeKitState(): void {
    this.state.active = this.heaterCoolerActiveForMode(this.state.mode)
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.state.currentHeaterCoolerState = this.currentHeaterCoolerStateForMode(this.state.mode);
    this.state.rotationSpeed = this.rotationSpeedFromFanMode(this.state.fanMode);
    this.state.fanActive = this.state.mode === AirConditionerMode.Fan
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.state.fanCurrentState = this.state.fanActive === this.platform.Characteristic.Active.ACTIVE
      ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
      : this.platform.Characteristic.CurrentFanState.INACTIVE;
    this.state.fanTargetState = this.state.fanMode === AirConditionerFanMode.Auto
      ? this.platform.Characteristic.TargetFanState.AUTO
      : this.platform.Characteristic.TargetFanState.MANUAL;
    this.state.humidifierActive = this.isHumidityMode(this.state.mode)
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.state.currentHumidifierDehumidifierState = this.currentHumidifierDehumidifierStateForMode(this.state.mode);
    const humidityTarget = this.targetHumidifierDehumidifierStateForMode(this.state.mode);
    if (humidityTarget !== undefined) {
      this.state.targetHumidifierDehumidifierState = humidityTarget;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.state.currentHeaterCoolerState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.state.targetHeaterCoolerState);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
    this.updateTemperatureTargets();

    if (this.fanService) {
      this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.state.fanActive);
      this.fanService.updateCharacteristic(this.platform.Characteristic.CurrentFanState, this.state.fanCurrentState);
      this.fanService.updateCharacteristic(this.platform.Characteristic.TargetFanState, this.state.fanTargetState);
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
    }

    if (this.humidifierService) {
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, this.state.humidifierActive);
      this.humidifierService.updateCharacteristic(
        this.platform.Characteristic.CurrentHumidifierDehumidifierState,
        this.state.currentHumidifierDehumidifierState,
      );
      this.humidifierService.updateCharacteristic(
        this.platform.Characteristic.TargetHumidifierDehumidifierState,
        this.state.targetHumidifierDehumidifierState,
      );
      this.humidifierService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        this.state.currentHumidity ?? 50,
      );
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeed);
    }

    this.updateModeSwitches();
    this.configureGroupedServices();
  }

  private updateTemperatureTargets(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.state.targetTemperature);
    this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.state.targetTemperature);
  }

  private configureHeaterCoolerService(): void {
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(() => this.state.active);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.state.currentHeaterCoolerState);
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: this.targetHeaterCoolerValidValues(),
      })
      .onSet(this.setTargetHeaterCoolerState.bind(this))
      .onGet(() => this.state.targetHeaterCoolerState);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTemperature);
    this.configureTemperatureCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature);
    this.configureTemperatureCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature);
    this.configureRotationSpeedCharacteristic(this.service);
    this.service.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );
  }

  private configureTemperatureCharacteristic(characteristic: typeof this.platform.Characteristic.CoolingThresholdTemperature): void {
    this.service.getCharacteristic(characteristic)
      .setProps({
        minValue: this.state.minTemperature,
        maxValue: this.state.maxTemperature,
        minStep: 1,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(() => this.state.targetTemperature);
  }

  private configureRotationSpeedCharacteristic(service: Service): void {
    service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps(this.rotationSpeedProps())
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(() => this.state.rotationSpeed);
  }

  private configureFanService(): Service | undefined {
    const existingService = this.accessory.getServiceById(this.platform.Service.Fanv2, 'fan-mode');
    if (!this.supportsMode(AirConditionerMode.Fan)) {
      if (existingService) {
        this.accessory.removeService(existingService);
      }
      return undefined;
    }

    const name = this.platform.formatHomeKitName(`${this.device.displayName} 送風`);
    const service = existingService || this.accessory.addService(this.platform.Service.Fanv2, name, 'fan-mode');
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this))
      .onGet(() => this.state.fanActive);
    service.getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(() => this.state.fanCurrentState);
    service.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onSet(this.setFanTargetState.bind(this))
      .onGet(() => this.state.fanTargetState);
    this.configureRotationSpeedCharacteristic(service);

    return service;
  }

  private configureHumidifierService(): Service | undefined {
    const existingService = this.accessory.getServiceById(this.platform.Service.HumidifierDehumidifier, 'humidity-mode');
    const validValues = this.humidifierTargetValidValues();
    if (!this.state.currentHumidity && validValues.length === 0) {
      if (existingService) {
        this.accessory.removeService(existingService);
      }
      return undefined;
    }

    if (validValues.length === 0) {
      if (existingService) {
        this.accessory.removeService(existingService);
      }
      return undefined;
    }

    const name = this.platform.formatHomeKitName(`${this.device.displayName} 加湿 除湿`);
    const service = existingService || this.accessory.addService(this.platform.Service.HumidifierDehumidifier, name, 'humidity-mode');
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setHumidifierDehumidifierActive.bind(this))
      .onGet(() => this.state.humidifierActive);
    service.getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(() => this.state.currentHumidifierDehumidifierState);
    service.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({ validValues })
      .onSet(this.setTargetHumidifierDehumidifierState.bind(this))
      .onGet(() => this.state.targetHumidifierDehumidifierState);
    service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.state.currentHumidity ?? 50);
    this.configureRotationSpeedCharacteristic(service);

    return service;
  }

  private configureModeSwitchServices(): void {
    for (const mode of SPECIAL_MODE_SWITCHES) {
      const subtype = this.modeSwitchSubtype(mode);
      const existingService = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
      if (!this.supportsMode(mode)) {
        if (existingService) {
          this.accessory.removeService(existingService);
        }
        continue;
      }

      const name = this.platform.formatHomeKitName(`${this.device.displayName} ${this.formatMode(mode)}`);
      const service = existingService || this.accessory.addService(this.platform.Service.Switch, name, subtype);
      service.setCharacteristic(this.platform.Characteristic.Name, name);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setModeSwitch.bind(this, mode))
        .onGet(() => this.state.mode === mode);
      this.modeSwitchServices.set(mode, service);
    }
  }

  private applySupplementalServices(currentHumidity: number | undefined, outdoorTemperature: number | undefined): void {
    if (currentHumidity !== undefined) {
      this.ensureIndoorHumidityService()
        .updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, currentHumidity);
    }

    if (outdoorTemperature !== undefined) {
      this.ensureOutdoorTemperatureService()
        .updateCharacteristic(this.platform.Characteristic.CurrentTemperature, outdoorTemperature);
    }

    if (this.humidifierService) {
      this.humidifierService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        currentHumidity ?? 50,
      );
    }

    this.configureGroupedServices();
  }

  private ensureIndoorHumidityService(): Service {
    if (!this.indoorHumidityService) {
      const name = this.platform.formatHomeKitName(`${this.device.displayName} 室内湿度`);
      this.indoorHumidityService = this.accessory.getServiceById(this.platform.Service.HumiditySensor, 'indoor-humidity') ||
        this.accessory.addService(this.platform.Service.HumiditySensor, name, 'indoor-humidity');
      this.indoorHumidityService.setCharacteristic(this.platform.Characteristic.Name, name);
    }

    return this.indoorHumidityService;
  }

  private ensureOutdoorTemperatureService(): Service {
    if (!this.outdoorTemperatureService) {
      const name = this.platform.formatHomeKitName(`${this.device.displayName} 室外温度`);
      this.outdoorTemperatureService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'outdoor-temperature') ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, name, 'outdoor-temperature');
      this.outdoorTemperatureService.setCharacteristic(this.platform.Characteristic.Name, name);
    }

    return this.outdoorTemperatureService;
  }

  private configureGroupedServices(): void {
    const linkedServices = [
      this.indoorHumidityService,
      this.outdoorTemperatureService,
      this.fanService,
      this.humidifierService,
      ...this.modeSwitchServices.values(),
    ].filter((service): service is Service => service !== undefined);

    this.platform.configureGroupedService(this.service, linkedServices, this.platform.groupAirConditionerSensors);
  }

  private updateModeSwitches(): void {
    for (const [mode, service] of this.modeSwitchServices) {
      service.updateCharacteristic(this.platform.Characteristic.On, this.state.mode === mode);
    }
  }

  private async waitForAcceptedChange(response: AirConditionerOperationResponse): Promise<void> {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      const safeResponse: Partial<AirConditionerOperationResponse> = { ...response };
      delete safeResponse.token;
      throw new Error(`${this.device.displayName} update submission failed: ${JSON.stringify(safeResponse)}`);
    }

    const acceptId = Number(response.acceptId);
    if (!Number.isInteger(acceptId)) {
      return;
    }

    for (let count = 0; count < 8; count++) {
      await this.delay(1000);
      const result = await this.platform.client.checkAirConditionerChange(acceptId, this.device, response.token);

      if (result === CheckResult.OK) {
        return;
      }

      if (result === CheckResult.Invalid) {
        break;
      }
    }

    throw new Error(`Timed out waiting for '${this.device.displayName}' to update`);
  }

  private async confirmActionState(actionId: number, action: AirConditionerAction): Promise<void> {
    let lastStatus: AirConditionerStatus | undefined;

    for (let count = 0; count < 12; count++) {
      if (actionId !== this.actionSequence || this.queuedAction) {
        return;
      }

      await this.delay(1000);
      if (actionId !== this.actionSequence || this.queuedAction) {
        return;
      }

      const status = await this.platform.client.getAirConditionerStatus(this.device, true);
      if (actionId !== this.actionSequence || this.queuedAction) {
        return;
      }

      lastStatus = status;

      if (this.actionMatchesStatus(action, status)) {
        this.applyStatus(status);
        this.platform.log.info(`${this.device.displayName} ${this.actionLabel(action)} state confirmed: ${this.actionTarget(action)}`);
        return;
      }

      this.applyMeasurements(status);
    }

    if (lastStatus) {
      this.applyMeasurements(lastStatus);
    }
    throw new Error(`Timed out waiting for '${this.device.displayName}' to report ${this.actionTarget(action)}`);
  }

  private beginPendingAction(action: AirConditionerAction): number {
    const actionId = ++this.actionSequence;
    this.pendingAction = action;
    return actionId;
  }

  private clearPendingAction(actionId: number): void {
    if (actionId === this.actionSequence) {
      this.pendingAction = undefined;
    }
  }

  private runQueuedAction(): void {
    if (!this.queuedAction) {
      return;
    }

    const action = this.queuedAction;
    this.queuedAction = undefined;
    void this.runAction(action).catch(error => {
      this.platform.log.error(`${this.device.displayName} queued ${this.actionLabel(action)} request failed: ${this.formatError(error)}`);
    });
  }

  private actionMatchesStatus(action: AirConditionerAction, status: AirConditionerStatus): boolean {
    switch (action.kind) {
      case 'mode':
        return action.mode === AirConditionerMode.Stop
          ? !status.active
          : status.active && status.mode === action.mode;
      case 'temperature':
        return status.targetTemperature === undefined || status.targetTemperature === action.temperature;
      case 'fanMode':
        return status.fanMode === undefined || status.fanMode === action.fanMode;
    }
  }

  private actionAlreadyCurrent(action: AirConditionerAction): boolean {
    switch (action.kind) {
      case 'mode':
        return this.state.mode === action.mode;
      case 'temperature':
        return this.state.targetTemperature === action.temperature;
      case 'fanMode':
        return this.state.fanMode === action.fanMode;
    }
  }

  private sameAction(left: AirConditionerAction, right: AirConditionerAction): boolean {
    if (left.kind !== right.kind) {
      return false;
    }

    return this.actionTarget(left) === this.actionTarget(right);
  }

  private currentActionState(action: AirConditionerAction): string {
    switch (action.kind) {
      case 'mode':
        return this.formatMode(this.state.mode);
      case 'temperature':
        return `${this.state.targetTemperature}C`;
      case 'fanMode':
        return this.formatFanMode(this.state.fanMode);
    }
  }

  private actionTarget(action: AirConditionerAction): string {
    switch (action.kind) {
      case 'mode':
        return this.formatMode(action.mode);
      case 'temperature':
        return `${action.temperature}C`;
      case 'fanMode':
        return this.formatFanMode(action.fanMode);
    }
  }

  private actionLabel(action: AirConditionerAction): string {
    switch (action.kind) {
      case 'mode':
        return 'mode';
      case 'temperature':
        return 'temperature';
      case 'fanMode':
        return 'fan speed';
    }
  }

  private capabilitiesFromDevice(): AirConditionerCapabilities {
    return {
      modes: this.device.availableModes?.length ? this.device.availableModes : DEFAULT_AIRCON_MODES,
      fanModes: this.device.availableFanModes || [],
      currentFanMode: this.device.fanMode,
      minTemperature: this.device.minTemperature,
      maxTemperature: this.device.maxTemperature,
      targetTemperature: this.device.targetTemperature,
    };
  }

  private supportedModes(): AirConditionerControlOption[] {
    return this.capabilities.modes.filter(mode => !mode.disabled);
  }

  private supportedFanModes(): AirConditionerControlOption[] {
    return this.capabilities.fanModes.filter(mode => !mode.disabled);
  }

  private supportsMode(mode: string): boolean {
    return this.supportedModes().some(option => option.value === mode);
  }

  private targetHeaterCoolerValidValues(): number[] {
    const validValues: number[] = [];
    if (this.supportsMode(AirConditionerMode.Auto)) {
      validValues.push(this.platform.Characteristic.TargetHeaterCoolerState.AUTO);
    }
    if (this.supportsMode(AirConditionerMode.Heat)) {
      validValues.push(this.platform.Characteristic.TargetHeaterCoolerState.HEAT);
    }
    if (this.supportsMode(AirConditionerMode.Cool)) {
      validValues.push(this.platform.Characteristic.TargetHeaterCoolerState.COOL);
    }

    return validValues.length
      ? validValues
      : [
        this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
        this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
        this.platform.Characteristic.TargetHeaterCoolerState.COOL,
      ];
  }

  private humidifierTargetValidValues(): number[] {
    const validValues: number[] = [];
    if (this.supportsMode(AirConditionerMode.Humidify) || this.supportsMode(AirConditionerMode.HumidifyHeat)) {
      validValues.push(this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER);
    }
    if (this.supportsMode(AirConditionerMode.Dry)) {
      validValues.push(this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
    }

    return validValues;
  }

  private defaultHumidifierTargetState(): number {
    return this.supportsMode(AirConditionerMode.Dry)
      ? this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER
      : this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }

  private modeForTargetHeaterCoolerState(targetState: number): string {
    switch (targetState) {
      case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
        return AirConditionerMode.Cool;
      case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
        return AirConditionerMode.Heat;
      default:
        return AirConditionerMode.Auto;
    }
  }

  private nativeTargetStateForMode(mode: string): number | undefined {
    switch (mode) {
      case AirConditionerMode.Auto:
        return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
      case AirConditionerMode.Cool:
        return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      case AirConditionerMode.Heat:
      case AirConditionerMode.HumidifyHeat:
        return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
      default:
        return undefined;
    }
  }

  private heaterCoolerActiveForMode(mode: string): boolean {
    return mode === AirConditionerMode.Auto ||
      mode === AirConditionerMode.Cool ||
      mode === AirConditionerMode.Heat ||
      mode === AirConditionerMode.HumidifyHeat;
  }

  private currentHeaterCoolerStateForMode(mode: string): number {
    if (!this.heaterCoolerActiveForMode(mode)) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    switch (mode) {
      case AirConditionerMode.Cool:
        return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
      case AirConditionerMode.Heat:
      case AirConditionerMode.HumidifyHeat:
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      default:
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  }

  private isHumidityMode(mode: string): boolean {
    return mode === AirConditionerMode.Dry ||
      mode === AirConditionerMode.Humidify ||
      mode === AirConditionerMode.HumidifyHeat;
  }

  private modeForHumidifierTargetState(): string {
    if (this.state.targetHumidifierDehumidifierState === this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER) {
      return this.supportsMode(AirConditionerMode.Humidify)
        ? AirConditionerMode.Humidify
        : AirConditionerMode.HumidifyHeat;
    }

    return AirConditionerMode.Dry;
  }

  private currentHumidifierDehumidifierStateForMode(mode: string): number {
    switch (mode) {
      case AirConditionerMode.Dry:
        return this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
      case AirConditionerMode.Humidify:
      case AirConditionerMode.HumidifyHeat:
        return this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
      default:
        return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }
  }

  private targetHumidifierDehumidifierStateForMode(mode: string): number | undefined {
    switch (mode) {
      case AirConditionerMode.Dry:
        return this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;
      case AirConditionerMode.Humidify:
      case AirConditionerMode.HumidifyHeat:
        return this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
      default:
        return undefined;
    }
  }

  private rotationSpeedProps(): RotationSpeedProps {
    const validValues = this.supportedFanModes()
      .map(option => this.rotationSpeedFromFanMode(option.value))
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((left, right) => left - right);

    return {
      minValue: 0,
      maxValue: 100,
      minStep: validValues.length > 2 ? 100 / (validValues.length - 1) : 25,
      validValues: validValues.length ? validValues : undefined,
    };
  }

  private rotationSpeedFromFanMode(mode: string): number {
    if (mode === AirConditionerFanMode.Auto) {
      return 0;
    }

    const levels = this.manualFanModes();
    const index = levels.findIndex(option => option.value === mode);
    if (index < 0 || levels.length === 0) {
      return 0;
    }

    return Math.round(((index + 1) / levels.length) * 100);
  }

  private fanModeFromRotationSpeed(speed: number): string {
    if (!Number.isFinite(speed)) {
      throw new Error(`Invalid air conditioner fan speed '${speed}'`);
    }

    if (speed <= 0 && this.supportedFanModes().some(option => option.value === AirConditionerFanMode.Auto)) {
      return AirConditionerFanMode.Auto;
    }

    const levels = this.manualFanModes();
    if (levels.length === 0) {
      return AirConditionerFanMode.Auto;
    }

    const index = Math.max(0, Math.min(levels.length - 1, Math.round((Math.max(1, speed) / 100) * levels.length) - 1));
    return levels[index].value;
  }

  private firstManualFanMode(): string {
    return this.manualFanModes()[0]?.value || AirConditionerFanMode.Auto;
  }

  private manualFanModes(): AirConditionerControlOption[] {
    return this.supportedFanModes()
      .filter(option => option.value !== AirConditionerFanMode.Auto)
      .sort((left, right) => Number.parseInt(left.value, 16) - Number.parseInt(right.value, 16));
  }

  private normalizeTemperature(value: CharacteristicValue): number {
    const temperature = Math.round(Number(value));
    if (!Number.isFinite(temperature)) {
      throw new Error(`Invalid target temperature '${value}'`);
    }

    return Math.max(this.state.minTemperature, Math.min(this.state.maxTemperature, temperature));
  }

  private formatMode(mode: string): string {
    return this.supportedModes().find(option => option.value === mode)?.label || mode;
  }

  private formatFanMode(mode: string): string {
    return this.supportedFanModes().find(option => option.value === mode)?.label || mode;
  }

  private modeSwitchSubtype(mode: string): string {
    return `mode-${mode.toLowerCase()}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
