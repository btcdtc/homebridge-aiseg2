import { request as httpRequest, RequestOptions } from 'urllib';
import { load as loadHtml } from 'cheerio';

import {
  Aiseg2DeviceSummary,
  Aiseg2DeviceType,
  AirConditionerControlOption,
  AirConditionerDevice,
  AirEnvironmentSensorDevice,
  AirPurifierDevice,
  ContactSensorDevice,
  DoorLockDevice,
  EcocuteDevice,
  LightingDevice,
  ShutterDevice,
  SmokeSensorDevice,
  displayNameFromSummary,
  uuidSeedFor,
} from './devices';
import {
  EchonetLiteClient,
  EchonetLiteEndpoint,
  bufferFromHexByte,
  formatEndpoint,
  normalizeEoj,
} from './echonetLiteClient';
import { EchonetLiteNode } from './echonetLiteDiscovery';


export enum CheckResult {
  OK = '0',
  InProgress = '1',
  Invalid = '2',
}

export interface LightingStatus {
  state: boolean;
  dimmable: boolean;
  brightness?: number;
}

export interface AirConditionerStatus {
  state: string;
  mode: string;
  modeLabel?: string;
  fanMode?: string;
  fanModeLabel?: string;
  active: boolean;
  currentTemperature?: number;
  targetTemperature?: number;
  coolingTargetTemperature?: number;
  heatingTargetTemperature?: number;
  currentHumidity?: number;
  outdoorTemperature?: number;
}

export enum AirConditionerMode {
  Auto = '0x41',
  Cool = '0x42',
  Heat = '0x43',
  Dry = '0x44',
  Fan = '0x45',
  Stop = '0x49',
  Humidify = '0x4A',
  HumidifyHeat = '0x4B',
}

export enum AirConditionerFanMode {
  Auto = '0x41',
  Level1 = '0x31',
  Level2 = '0x32',
  Level3 = '0x33',
  Level4 = '0x34',
  Level5 = '0x35',
  Level6 = '0x36',
  Level7 = '0x37',
  Level8 = '0x38',
}

export interface AirConditionerCapabilities {
  modes: AirConditionerControlOption[];
  fanModes: AirConditionerControlOption[];
  currentMode?: string;
  currentFanMode?: string;
  minTemperature?: number;
  maxTemperature?: number;
  targetTemperature?: number;
  coolingTargetTemperature?: number;
  heatingTargetTemperature?: number;
}

export interface ShutterStatus {
  state: string;
  openState: string;
  condition: string;
  position: number;
  transport?: ControlTransport;
  endpoint?: string;
  fallbackReason?: string;
}

export interface AirPurifierStatus {
  state: string;
  mode: string;
  active: boolean;
  smellLevel?: number;
  pm25Level?: number;
  dustLevel?: number;
  transport?: ControlTransport;
  endpoint?: string;
  fallbackReason?: string;
}

export interface AirEnvironmentStatus {
  temperature?: number;
  humidity?: number;
}

export enum EcocuteWaterHeatingMode {
  Auto = '0x41',
  ManualHeating = '0x42',
  ManualStop = '0x43',
}

export interface EcocuteStatus {
  operationState: string;
  waterHeatingMode?: string;
  waterHeatingStatus?: string;
  tankMode?: string;
  daytimeReheating?: boolean;
  bathAuto?: boolean;
  tankTemperature?: number;
  suppliedWaterTemperature?: number;
  bathWaterTemperature?: number;
  remainingWaterLiters?: number;
  tankCapacityLiters?: number;
  hotWaterSupplyStatus?: string;
  bathOperationStatus?: string;
  bathWaterVolume?: number;
  transport?: ControlTransport;
  endpoint?: string;
}

export interface EnergyStatus {
  solarEndpoint?: string;
  solarOperationState?: string;
  solarGenerationWatts?: number;
  solarRatedPowerWatts?: number;
  solarCumulativeGeneratedKwh?: number;
  solarCumulativeSoldKwh?: number;
  batteryEndpoint?: string;
  batteryOperationState?: string;
  batteryWorkingStatus?: string;
  batteryOperationMode?: string;
  batteryPercent?: number;
  batteryPowerWatts?: number;
  batteryCharging?: boolean;
  batteryDischarging?: boolean;
  batteryStandby?: boolean;
  batteryCumulativeChargingKwh?: number;
  batteryCumulativeDischargingKwh?: number;
  gridEndpoint?: string;
  gridSource?: string;
  gridPowerWatts?: number;
  gridCumulativeNormalKwh?: number;
  gridCumulativeReverseKwh?: number;
  errors?: Record<string, string>;
}

export interface EchonetDeviceMetadata {
  endpoint: string;
  manufacturerCode?: string;
  manufacturerName?: string;
  productCode?: string;
}

export interface DoorLockStatus {
  lockVal: string;
  statecmd: string;
  secured: boolean | undefined;
  transport?: ControlTransport;
  endpoint?: string;
  fallbackReason?: string;
}

export interface ContactSensorStatus {
  contactDetected: boolean;
  lowBattery: boolean;
  locked?: boolean;
}

export interface SmokeSensorStatus {
  smokeDetected: boolean;
  lowBattery: boolean;
}

export interface OperationResponse {
  result?: string | number;
  acceptId?: number | string;
  errorInfo?: string | number;
  token?: string;
  transport?: ControlTransport;
  endpoint?: string;
  fallbackReason?: string;
}

export interface AirConditionerOperationResponse extends OperationResponse {
  token: string;
}

export type LightingChangeResponse = OperationResponse;

export interface ShutterOperationResponse extends OperationResponse {
  operationPage: string;
  command: string;
}

interface LightingPanelData {
  id?: string | number;
  nodeId?: string;
  eoj?: string;
  type?: string;
  deviceId?: string;
  state?: string;
  modulate_hidden?: string;
  modulate_level?: number | string;
}

interface LightingAutoUpdateResponse {
  panelData?: LightingPanelData[];
}

interface AirConditionerAutoUpdateResponse {
  links?: AirConditionerPanelData[];
}

interface AirConditionerPanelData {
  nodeId: string;
  eoj: string;
  type: string;
  name?: string;
  state?: string;
  state_str?: string;
  mode?: string;
  temp?: string;
  inner?: string;
  outer?: string;
  humidity?: string;
}

interface AirConditionerModifyItem {
  id_str?: string;
  current?: {
    value?: string;
    value_str?: string;
  };
  after?: {
    value?: string;
    value_str?: string;
  } | null;
}

interface AirConditionerDetailUpdateResponse extends AirConditionerPanelData {
  modify_items?: AirConditionerModifyItem[];
}

interface ShutterPanelData {
  nodeId: string;
  eoj: string;
  type: string;
  name: string;
  state?: string;
  entry?: string;
  condition?: string;
  shutter?: {
    openState?: string;
    type?: string;
    version?: string;
  };
}

interface ShutterAutoUpdateResponse {
  arrayControlDevInfo?: string;
}

interface AirPurifierPageData {
  nodeId: string;
  eoj: string;
  type: string;
  name: string;
  state?: string;
  airclean?: {
    mode?: string;
    type?: string;
    dust?: string;
    pm25?: string;
    smell?: string;
  };
}

interface AirEnvironmentDeviceData {
  nodeId?: string;
  eoj?: string;
  type: string;
  nodeIdentNum?: string;
  devId?: string;
}

interface AirEnvironmentAutoUpdateResponse {
  region_Info?: string;
  code?: string;
  dispInfo?: string[];
  color?: string[];
}

interface LockupStatusResponse {
  arrayElDevList: LockupDoorData[];
  arrayOcDevList: LockupContactData[];
}

interface LockupDoorData {
  devName: string;
  lockVal?: string;
  nodeId: string;
  eoj: string;
  devType: string;
  statecmd?: string;
  cacheValid?: string;
}

interface LockupContactData {
  devName: string;
  wSensorVal?: string;
  lockVal?: string;
  batteryUHF?: string;
  regNo: number;
  nodeId: string;
  eoj: string;
  devType: string;
}

interface FireAlarmPageData {
  nodeId: string;
  eoj: string;
  arrayRegDevList: FireAlarmDeviceData[];
}

interface FireAlarmDeviceData {
  color?: string;
  name: string;
  time?: string;
  battVisible?: string;
  nodeId: string;
  eoj: string;
  equipIndex: string;
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

export type RequestPriority = 'normal' | 'action';
export type ControlTransport = 'AiSEG2' | 'ECHONET Lite';

export interface EchonetControlOptions {
  enabled: boolean;
  preferShutters: boolean;
  preferDoorLocks: boolean;
  preferAirPurifiers: boolean;
  preferEcocutes: boolean;
  fallbackToAiseg: boolean;
  doorLockHosts: Record<string, string>;
}

type QueuedRequest = () => Promise<void>;

const DEVICE_LIST_PATH = '/page/devices/device/32';
const LIGHTING_PAGE_PATH = '/page/devices/device/32i1?page=1';
const LIGHTING_AUTO_UPDATE_PATH = '/data/devices/device/32i1/auto_update';
const LIGHTING_CHANGE_PATH = '/action/devices/device/32i1/change';
const LIGHTING_CHECK_PATH = '/data/devices/device/32i1/check';
const AIRCON_PAGE_PATH = '/page/devices/device/321?page=1&individual_page=1';
const AIRCON_AUTO_UPDATE_PATH = '/data/devices/device/321/auto_update';
const AIRCON_CHANGE_PATH = '/action/devices/device/321/change';
const AIRCON_DETAIL_PAGE_PATH = '/page/devices/device/3211';
const AIRCON_DETAIL_UPDATE_PATH = '/data/devices/device/3211/update';
const AIRCON_DETAIL_CHANGE_PATH = '/action/devices/device/3211/change';
const AIRCON_DETAIL_CHECK_PATH = '/action/devices/device/3211/check';
const SHUTTER_PAGE_PATH = '/page/devices/device/325?page=2';
const SHUTTER_AUTO_UPDATE_PATH = '/data/devices/device/325/auto_update';
const LOCKUP_PAGE_PATH = '/page/lockup/8';
const LOCKUP_AUTO_UPDATE_PATH = '/data/lockup/8/auto_update';
const LOCKUP_CHANGE_PATH = '/action/lockup/8/change';
const LOCKUP_CHECK_PATH = '/action/lockup/8/check';
const FIRE_ALARM_AUTO_UPDATE_PATH = '/data/devices/device/32h/auto_update';
const AIR_PURIFIER_OPERATION_PATH = '/action/devices/device/327/operation';
const AIR_PURIFIER_STATUS_PATH = '/action/devices/device/327/get_operation_status';
const AIR_ENVIRONMENT_DEVICE_PAGE_PATH = '/page/airenvironment/43';
const AIR_ENVIRONMENT_DEVICE_AUTO_UPDATE_PATH = '/data/airenvironment/43/auto_update';
const MAX_QUEUED_REQUESTS = 100;
const PANASONIC_AIR_PURIFIER_MODE_EPC = 0xf0;
const STANDARD_AIR_PURIFIER_AIRFLOW_EPC = 0xa0;
const AIR_PURIFIER_MODE_STOP = '0x40';
const AIR_PURIFIER_MODE_AUTO = '0x41';
const AIR_PURIFIER_MODE_WEAK = '0x42';
const AIR_PURIFIER_MODE_MEDIUM = '0x43';
const AIR_PURIFIER_MODE_STRONG = '0x44';
const AIR_PURIFIER_MODE_TURBO = '0x45';

const FORM_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded',
};

export class Aiseg2Client {
  private deviceSummaryCache?: CachedValue<Aiseg2DeviceSummary[]>;
  private lightingDeviceCache?: CachedValue<LightingDevice[]>;
  private lightingPanelCache?: CachedValue<LightingPanelData[]>;
  private lightingPanelInflight?: Promise<LightingPanelData[]>;
  private airConditionerPanelCache?: CachedValue<AirConditionerPanelData[]>;
  private airConditionerPanelInflight?: Promise<AirConditionerPanelData[]>;
  private airConditionerCapabilitiesCache = new Map<string, CachedValue<AirConditionerCapabilities>>();
  private airConditionerCapabilitiesInflight = new Map<string, Promise<AirConditionerCapabilities>>();
  private airConditionerDetailCache = new Map<string, CachedValue<AirConditionerDetailUpdateResponse>>();
  private airConditionerDetailInflight = new Map<string, Promise<AirConditionerDetailUpdateResponse>>();
  private lockupCache?: CachedValue<LockupStatusResponse>;
  private lockupInflight?: Promise<LockupStatusResponse>;
  private shutterCache?: CachedValue<ShutterPanelData[]>;
  private shutterInflight?: Promise<ShutterPanelData[]>;
  private smokeCache = new Map<string, CachedValue<FireAlarmPageData>>();
  private smokeInflight = new Map<string, Promise<FireAlarmPageData>>();
  private airPurifierCache = new Map<string, CachedValue<AirPurifierPageData>>();
  private airPurifierInflight = new Map<string, Promise<AirPurifierPageData>>();
  private airPurifierSensorStatusCache = new Map<string, Pick<AirPurifierStatus, 'smellLevel' | 'pm25Level' | 'dustLevel'>>();
  private airEnvironmentDeviceCache?: CachedValue<AirEnvironmentSensorDevice[]>;
  private airEnvironmentStatusCache?: CachedValue<Map<string, AirEnvironmentStatus>>;
  private airEnvironmentStatusInflight?: Promise<Map<string, AirEnvironmentStatus>>;
  private pageTokenCache = new Map<string, CachedValue<string>>();
  private readonly actionRequestQueue: QueuedRequest[] = [];
  private readonly normalRequestQueue: QueuedRequest[] = [];
  private readonly echonetClient = new EchonetLiteClient();
  private echonetOptions: EchonetControlOptions = {
    enabled: false,
    preferShutters: false,
    preferDoorLocks: false,
    preferAirPurifiers: false,
    preferEcocutes: false,
    fallbackToAiseg: false,
    doorLockHosts: {},
  };

  private echonetNodes: EchonetLiteNode[] = [];

  private activeRequestCount = 0;

  constructor(
    private readonly host: string,
    private readonly password: string,
  ) {}

  configureEchonet(options: Partial<EchonetControlOptions>): void {
    this.echonetOptions = {
      enabled: options.enabled ?? false,
      preferShutters: options.preferShutters ?? true,
      preferDoorLocks: options.preferDoorLocks ?? true,
      preferAirPurifiers: options.preferAirPurifiers ?? true,
      preferEcocutes: options.preferEcocutes ?? true,
      fallbackToAiseg: options.fallbackToAiseg ?? false,
      doorLockHosts: options.doorLockHosts ?? {},
    };
  }

  setEchonetNodes(nodes: EchonetLiteNode[]): void {
    this.echonetNodes = nodes;
  }

  echonetEndpointForShutter(device: ShutterDevice): EchonetLiteEndpoint | undefined {
    if (!this.echonetOptions.enabled || !this.echonetOptions.preferShutters) {
      return undefined;
    }

    return this.findEchonetEndpoint(['0x0261', '0x0263'], normalizeEoj(device.eoj));
  }

  echonetSupportsShutterPosition(device: ShutterDevice): boolean {
    const endpoint = this.echonetEndpointForShutter(device);
    return endpoint ? this.canSetEchonetShutterPosition(endpoint, 50) : false;
  }

  echonetSupportsTimedShutterPosition(device: ShutterDevice): boolean {
    const endpoint = this.echonetEndpointForShutter(device);
    return endpoint ? this.canSetTimedEchonetShutterPosition(endpoint) : false;
  }

  echonetEndpointForAirPurifier(device: AirPurifierDevice): EchonetLiteEndpoint | undefined {
    if (!this.echonetOptions.enabled || !this.echonetOptions.preferAirPurifiers) {
      return undefined;
    }

    return this.findEchonetEndpoint(['0x0135'], normalizeEoj(device.eoj));
  }

  echonetEndpointForEcocute(device: EcocuteDevice): EchonetLiteEndpoint | undefined {
    if (!this.echonetOptions.enabled || !this.echonetOptions.preferEcocutes) {
      return undefined;
    }

    return this.echonetEndpointForEcocuteStatus(device);
  }

  echonetEndpointForEcocuteStatus(device: EcocuteDevice): EchonetLiteEndpoint | undefined {
    return this.findEchonetEndpoint(['0x026b'], normalizeEoj(device.eoj));
  }

  echonetEndpointForHomeSolar(): EchonetLiteEndpoint | undefined {
    return this.findEchonetEndpoint(['0x0279']);
  }

  echonetEndpointForStorageBattery(): EchonetLiteEndpoint | undefined {
    return this.findEchonetEndpoint(['0x027d']);
  }

  echonetEndpointForMultipleInputPcs(): EchonetLiteEndpoint | undefined {
    return this.findEchonetEndpoint(['0x02a5']);
  }

  echonetProductCodeForEcocute(device: EcocuteDevice): string | undefined {
    return this.echonetMetadataForEcocute(device)?.productCode;
  }

  echonetMetadataForEcocute(device: EcocuteDevice): EchonetDeviceMetadata | undefined {
    const endpoint = this.echonetEndpointForEcocuteStatus(device);
    const object = endpoint ? this.findEchonetObject(endpoint) : undefined;
    if (!endpoint || !object) {
      return undefined;
    }

    return {
      endpoint: formatEndpoint(endpoint),
      manufacturerCode: object.manufacturerCode,
      manufacturerName: object.manufacturerName,
      productCode: object.productCode?.trim() || undefined,
    };
  }

  ecocuteCanGet(device: EcocuteDevice, epc: number): boolean {
    const endpoint = this.echonetEndpointForEcocuteStatus(device);
    if (!endpoint) {
      return false;
    }

    return this.echonetObjectHasProperty(endpoint, 'getProperties', epc);
  }

  ecocuteCanSet(device: EcocuteDevice, epc: number): boolean {
    const endpoint = this.echonetEndpointForEcocuteStatus(device);
    if (!endpoint) {
      return false;
    }

    return this.echonetObjectHasProperty(endpoint, 'setProperties', epc);
  }

  echonetEndpointForDoorLock(device: DoorLockDevice): EchonetLiteEndpoint | undefined {
    if (!this.echonetOptions.enabled || !this.echonetOptions.preferDoorLocks) {
      return undefined;
    }

    const configuredHost = this.echonetOptions.doorLockHosts[device.displayName] ||
      this.echonetOptions.doorLockHosts[this.cleanDeviceName(device.displayName)];
    if (configuredHost) {
      return this.findEchonetEndpoint(['0x05fd'], undefined, configuredHost);
    }

    const endpoints = this.findEchonetEndpoints(['0x05fd'])
      .filter(endpoint => endpoint.productCode?.includes('HF-JA') || endpoint.object.eoj === '0x05fd01');

    if (endpoints.length !== 1) {
      return undefined;
    }

    return {
      host: endpoints[0].node.host,
      eoj: endpoints[0].object.eoj,
    };
  }

  async getDeviceSummaries(): Promise<Aiseg2DeviceSummary[]> {
    const now = Date.now();
    if (this.deviceSummaryCache && this.deviceSummaryCache.expiresAt > now) {
      return this.deviceSummaryCache.value;
    }

    const html = await this.requestText(DEVICE_LIST_PATH);
    const value = this.extractInitArgument<Aiseg2DeviceSummary[]>(html, 4);

    this.deviceSummaryCache = {
      value,
      expiresAt: now + 60000,
    };

    return value;
  }

  async getLightingDevices(): Promise<LightingDevice[]> {
    const now = Date.now();
    if (this.lightingDeviceCache && this.lightingDeviceCache.expiresAt > now) {
      return this.lightingDeviceCache.value;
    }

    const html = await this.requestText(LIGHTING_PAGE_PATH);
    const $ = loadHtml(html);
    const devices: LightingDevice[] = [];

    $('.panel').each((index, element) => {
      const deviceId = $(element).attr('deviceid') || '';
      if (!deviceId) {
        return;
      }

      const device: LightingDevice = {
        kind: 'lighting',
        displayName: $($(element).find('.lighting_title')[0]).text().trim(),
        nodeId: $(element).attr('nodeid') || '',
        eoj: $(element).attr('eoj') || '',
        type: $(element).attr('type') || '',
        nodeIdentNum: $(element).attr('nodeidentnum') || '',
        deviceId,
        uuidSeed: deviceId,
      };

      devices.push(device);
    });

    this.lightingDeviceCache = {
      value: devices,
      expiresAt: now + 60000,
    };

    return devices;
  }

  async getAirConditionerDevices(): Promise<AirConditionerDevice[]> {
    return (await this.getDeviceSummaries())
      .filter(device => device.type === Aiseg2DeviceType.AirConditioner)
      .map(summary => ({
        kind: 'airConditioner',
        displayName: displayNameFromSummary(summary),
        nodeId: summary.nodeId,
        eoj: summary.eoj,
        type: summary.type,
        uuidSeed: uuidSeedFor({
          kind: 'airConditioner',
          nodeId: summary.nodeId,
          eoj: summary.eoj,
          type: summary.type,
        }),
      }));
  }

  async getShutterDevices(): Promise<ShutterDevice[]> {
    return (await this.getShutterPanelData(true)).map(data => ({
      kind: 'shutter',
      displayName: data.name,
      nodeId: data.nodeId,
      eoj: data.eoj,
      type: data.type,
      uuidSeed: uuidSeedFor({
        kind: 'shutter',
        nodeId: data.nodeId,
        eoj: data.eoj,
        type: data.type,
      }),
      state: data.state,
      openState: data.shutter?.openState,
      shutterType: data.shutter?.type,
      condition: data.condition,
    }));
  }

  async getAirPurifierDevices(): Promise<AirPurifierDevice[]> {
    return (await this.getDeviceSummaries())
      .filter(device => device.type === Aiseg2DeviceType.AirPurifier)
      .map(summary => ({
        kind: 'airPurifier',
        displayName: displayNameFromSummary(summary),
        nodeId: summary.nodeId,
        eoj: summary.eoj,
        type: summary.type,
        uuidSeed: uuidSeedFor({
          kind: 'airPurifier',
          nodeId: summary.nodeId,
          eoj: summary.eoj,
          type: summary.type,
        }),
      }));
  }

  async getEcocuteDevices(): Promise<EcocuteDevice[]> {
    return (await this.getDeviceSummaries())
      .filter(device => device.type === Aiseg2DeviceType.Ecocute)
      .map(summary => ({
        kind: 'ecocute',
        displayName: displayNameFromSummary(summary),
        nodeId: summary.nodeId,
        eoj: summary.eoj,
        type: summary.type,
        uuidSeed: uuidSeedFor({
          kind: 'ecocute',
          nodeId: summary.nodeId,
          eoj: summary.eoj,
          type: summary.type,
        }),
      }));
  }

  async getAirEnvironmentSensorDevices(): Promise<AirEnvironmentSensorDevice[]> {
    const now = Date.now();
    if (this.airEnvironmentDeviceCache && this.airEnvironmentDeviceCache.expiresAt > now) {
      return this.airEnvironmentDeviceCache.value;
    }

    const html = await this.requestText(AIR_ENVIRONMENT_DEVICE_PAGE_PATH);
    const deviceInfo = this.extractScriptVariable<AirEnvironmentDeviceData[]>(html, 'deviceInfo');
    const names = this.extractAirEnvironmentDeviceNames(html);
    const devices: AirEnvironmentSensorDevice[] = [];

    deviceInfo.forEach((device, deviceIndex) => {
      if (device.type !== Aiseg2DeviceType.AirEnvironmentSensor || !device.nodeId || !device.eoj) {
        return;
      }

      const displayName = names.get(this.airEnvironmentDeviceKey(device)) || '温湿センサ';
      const uuidSuffix = this.airEnvironmentUuidSuffix(displayName);
      devices.push({
        kind: 'airEnvironmentSensor',
        displayName,
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        deviceIndex,
        nodeIdentNum: device.nodeIdentNum || '',
        devId: device.devId,
        uuidSeed: uuidSeedFor({
          kind: 'airEnvironmentSensor',
          nodeId: device.nodeId,
          eoj: device.eoj,
          type: device.type,
        }, uuidSuffix),
      });
    });

    this.airEnvironmentDeviceCache = {
      value: devices,
      expiresAt: now + 60000,
    };

    return devices;
  }

  async getDoorLockDevices(): Promise<DoorLockDevice[]> {
    const status = await this.getLockupStatus(true);
    return status.arrayElDevList.map(device => ({
      kind: 'doorLock',
      displayName: this.cleanDeviceName(device.devName),
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.devType,
      uuidSeed: uuidSeedFor({
        kind: 'doorLock',
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.devType,
      }),
      lockVal: device.lockVal,
      statecmd: device.statecmd,
    }));
  }

  async getContactSensorDevices(): Promise<ContactSensorDevice[]> {
    const status = await this.getLockupStatus(true);
    return status.arrayOcDevList.map(device => ({
      kind: 'contactSensor',
      displayName: this.cleanDeviceName(device.devName),
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.devType,
      regNo: device.regNo,
      uuidSeed: uuidSeedFor({
        kind: 'contactSensor',
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.devType,
      }, String(device.regNo)),
      lockVal: device.lockVal,
      wSensorVal: device.wSensorVal,
      batteryUHF: device.batteryUHF,
    }));
  }

  async getSmokeSensorDevices(): Promise<SmokeSensorDevice[]> {
    const fireAlarmSummaries = (await this.getDeviceSummaries())
      .filter(device => device.type === Aiseg2DeviceType.FireAlarm);
    const devices: SmokeSensorDevice[] = [];

    for (const summary of fireAlarmSummaries) {
      const page = await this.getFireAlarmPageData(summary.nodeId, summary.eoj, true);
      for (const alarm of page.arrayRegDevList) {
        devices.push({
          kind: 'smokeSensor',
          displayName: alarm.name,
          nodeId: alarm.nodeId,
          eoj: alarm.eoj,
          type: summary.type,
          equipIndex: alarm.equipIndex,
          uuidSeed: uuidSeedFor({
            kind: 'smokeSensor',
            nodeId: alarm.nodeId,
            eoj: alarm.eoj,
            type: summary.type,
          }, alarm.equipIndex),
          color: alarm.color,
          time: alarm.time,
          battVisible: alarm.battVisible,
        });
      }
    }

    return devices;
  }

  async getLightingStatus(
    device: LightingDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<LightingStatus> {
    const statuses = await this.getLightingPanelData(force, priority);
    const panel = statuses.find(item => item.deviceId === device.deviceId) ||
      statuses.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);
    if (!panel) {
      throw new Error(`AiSEG2 did not return panel data for '${device.displayName}'`);
    }

    const dimmable = panel.modulate_hidden !== 'hidden';
    const status: LightingStatus = {
      state: panel.state === 'on',
      dimmable,
    };

    if (dimmable) {
      const level = Number(panel.modulate_level);
      if (Number.isFinite(level)) {
        status.brightness = Math.max(0, Math.min(100, level * 20));
      }
    }

    return status;
  }

  async getAirConditionerStatus(
    device: AirConditionerDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirConditionerStatus> {
    const statuses = await this.getAirConditionerPanelData(force, priority);
    const panelStatus = statuses.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);

    if (!panelStatus) {
      throw new Error(`AiSEG2 did not return air conditioner data for '${device.displayName}'`);
    }

    const detailStatus = force
      ? await this.getAirConditionerDetailStatus(device, true, priority).catch(() => undefined)
      : undefined;
    const modeItem = this.airConditionerModifyItem(detailStatus, 's_item_mode');
    const fanItem = this.airConditionerModifyItem(detailStatus, 's_img_ac');
    const source = detailStatus || panelStatus;

    const mode = source.mode || modeItem?.current?.value || AirConditionerMode.Auto;
    const targetTemperature = this.parseTemperature(source.temp);

    return {
      state: source.state || '0x31',
      mode,
      modeLabel: this.cleanDeviceName(modeItem?.current?.value_str || source.state_str || ''),
      fanMode: fanItem?.current?.value || undefined,
      fanModeLabel: this.cleanDeviceName(fanItem?.current?.value_str || ''),
      active: source.state === '0x30',
      currentTemperature: this.parseTemperature(source.inner),
      targetTemperature,
      ...this.airConditionerModeTargetTemperatures(mode, targetTemperature),
      currentHumidity: this.parseHumidity(source.humidity),
      outdoorTemperature: this.parseTemperature(source.outer),
    };
  }

  async getAirConditionerCapabilities(device: AirConditionerDevice, force = false): Promise<AirConditionerCapabilities> {
    const key = this.airConditionerKey(device);
    const now = Date.now();
    const cached = this.airConditionerCapabilitiesCache.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.airConditionerCapabilitiesInflight.get(key);
    if (!force && inflight) {
      return inflight;
    }

    const request = this.fetchAirConditionerCapabilities(device, key, now).finally(() => {
      this.airConditionerCapabilitiesInflight.delete(key);
    });
    this.airConditionerCapabilitiesInflight.set(key, request);

    return request;
  }

  async getShutterStatus(
    device: ShutterDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<ShutterStatus> {
    const endpoint = this.echonetEndpointForShutter(device);
    if (endpoint) {
      try {
        return await this.getEchonetShutterStatus(endpoint);
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.getAisegShutterStatus(device, force, priority);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.getAisegShutterStatus(device, force, priority);
  }

  private async getAisegShutterStatus(
    device: ShutterDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<ShutterStatus> {
    const statuses = await this.getShutterPanelData(force, priority);
    const status = statuses.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);

    if (!status) {
      throw new Error(`AiSEG2 did not return shutter data for '${device.displayName}'`);
    }

    return {
      state: status.state || '0x31',
      openState: status.shutter?.openState || '',
      condition: status.condition || '',
      position: this.shutterPosition(status),
      transport: 'AiSEG2',
    };
  }

  async getAirPurifierStatus(
    device: AirPurifierDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirPurifierStatus> {
    const endpoint = this.echonetEndpointForAirPurifier(device);
    if (endpoint) {
      try {
        const aisegStatus = await this.getAisegAirPurifierStatus(device, force, priority);
        return {
          ...aisegStatus,
          endpoint: formatEndpoint(endpoint),
        };
      } catch (aisegError) {
        try {
          const direct = await this.getEchonetAirPurifierStatus(endpoint);
          const cachedSensors = this.airPurifierSensorStatusCache.get(this.airPurifierKey(device));
          return {
            ...direct,
            ...cachedSensors,
            fallbackReason: `AiSEG2 status failed: ${this.formatError(aisegError)}`,
          };
        } catch (echonetError) {
          throw new Error(
            `AiSEG2 status failed: ${this.formatError(aisegError)}; ` +
            `ECHONET Lite status failed: ${this.formatError(echonetError)}`,
          );
        }
      }
    }

    return this.getAisegAirPurifierStatus(device, force, priority);
  }

  private async getAisegAirPurifierStatus(
    device: AirPurifierDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirPurifierStatus> {
    const page = await this.getAirPurifierPageData(device, force, priority);
    const mode = page.airclean?.mode || '0x40';

    const status: AirPurifierStatus = {
      state: page.state || '0x31',
      mode,
      active: page.state === '0x30' && mode !== '0x40',
      smellLevel: this.parseAircleanLevel(page.airclean?.smell),
      pm25Level: this.parseAircleanLevel(page.airclean?.pm25),
      dustLevel: this.parseAircleanLevel(page.airclean?.dust),
      transport: 'AiSEG2',
    };

    this.airPurifierSensorStatusCache.set(this.airPurifierKey(device), {
      smellLevel: status.smellLevel,
      pm25Level: status.pm25Level,
      dustLevel: status.dustLevel,
    });

    return status;
  }

  async getEcocuteStatus(device: EcocuteDevice): Promise<EcocuteStatus> {
    const endpoint = this.echonetEndpointForEcocuteStatus(device);
    if (!endpoint) {
      throw new Error(`No matching ECHONET Lite endpoint for EcoCute '${device.displayName}'`);
    }

    return this.getEchonetEcocuteStatus(endpoint);
  }

  async getEnergyStatus(): Promise<EnergyStatus> {
    const results = await Promise.allSettled([
      this.getEchonetSolarEnergyStatus(),
      this.getEchonetBatteryEnergyStatus(),
      this.getEchonetMultipleInputPcsStatus(),
    ]);
    const labels = ['solar', 'battery', 'grid'];
    const status: EnergyStatus = {};
    const errors: Record<string, string> = {};

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        Object.assign(status, result.value);
        return;
      }

      errors[labels[index]] = this.formatError(result.reason);
    });

    if (Object.keys(errors).length > 0) {
      status.errors = errors;
    }

    if (!status.solarEndpoint && !status.batteryEndpoint && !status.gridEndpoint) {
      if (Object.keys(errors).length > 0) {
        throw new Error(`No ECHONET Lite energy status could be read: ${
          Object.entries(errors).map(([label, error]) => `${label}: ${error}`).join('; ')
        }`);
      }
      throw new Error('No matching ECHONET Lite solar, storage battery, or multiple input PCS endpoint was discovered');
    }

    return status;
  }

  async getAirEnvironmentStatus(device: AirEnvironmentSensorDevice, force = false): Promise<AirEnvironmentStatus> {
    const statuses = await this.getAirEnvironmentStatuses(force);
    return statuses.get(this.airEnvironmentDeviceKey(device)) || {};
  }

  async getDoorLockStatus(
    device: DoorLockDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<DoorLockStatus> {
    const endpoint = this.echonetEndpointForDoorLock(device);
    if (endpoint) {
      try {
        return await this.getEchonetDoorLockStatus(endpoint);
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.getAisegDoorLockStatus(device, force, priority);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.getAisegDoorLockStatus(device, force, priority);
  }

  private async getAisegDoorLockStatus(
    device: DoorLockDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<DoorLockStatus> {
    const status = await this.getLockupStatus(force, priority);
    const lock = status.arrayElDevList.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);

    if (!lock) {
      throw new Error(`AiSEG2 did not return door lock data for '${device.displayName}'`);
    }

    return this.doorLockStatus(lock);
  }

  private async getEchonetShutterStatus(endpoint: EchonetLiteEndpoint): Promise<ShutterStatus> {
    const values = await this.echonetClient.getProperties(endpoint, [0x80, 0xea]);
    const openState = this.hexByte(values.get(0xea)) || '';

    return {
      state: this.hexByte(values.get(0x80)) || '0x31',
      openState,
      condition: this.echonetShutterCondition(openState),
      position: this.echonetShutterPosition(openState),
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  private async getEchonetAirPurifierStatus(endpoint: EchonetLiteEndpoint): Promise<AirPurifierStatus> {
    const modeEpc = this.echonetAirPurifierModeEpc(endpoint, 'getProperties');
    const values = await this.echonetClient.getProperties(
      endpoint,
      modeEpc ? [0x80, modeEpc] : [0x80],
    );
    const state = this.hexByte(values.get(0x80)) || '0x31';
    const mode = this.echonetAirPurifierModeFromValue(
      modeEpc,
      modeEpc ? this.hexByte(values.get(modeEpc)) : undefined,
      state,
    );

    return {
      state,
      mode,
      active: state === '0x30' && mode !== AIR_PURIFIER_MODE_STOP,
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  private async getEchonetDoorLockStatus(endpoint: EchonetLiteEndpoint): Promise<DoorLockStatus> {
    const state = this.hexByte(await this.echonetClient.getProperty(endpoint, 0x80));
    const secured = state === '0x30' ? true : state === '0x31' ? false : undefined;

    return {
      lockVal: secured === true ? 'lock_val' : secured === false ? 'lock_val open' : '',
      statecmd: secured === true ? '0x31' : secured === false ? '0x30' : '',
      secured,
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  private async getEchonetEcocuteStatus(endpoint: EchonetLiteEndpoint): Promise<EcocuteStatus> {
    const requestedEpcs = [
      0x80, // Operation status
      0xb0, // Water heating command/state: auto, immediate manual start, immediate manual stop
      0xb2, // Heating status
      0xb3, // Water heating temperature setting
      0xb6, // Tank mode
      0xc0, // Daytime reheating permission
      0xc1, // Tank water temperature
      0xc3, // Hot water supply status
      0xd1, // Supplied water temperature setting
      0xd3, // Bath water temperature setting
      0xe1, // Remaining water
      0xe2, // Tank capacity
      0xe3, // Automatic bath operation
      0xea, // Bath operation status
      0xee, // Bath water volume
    ].filter(epc => this.echonetObjectHasProperty(endpoint, 'getProperties', epc));
    const values = await this.echonetClient.getProperties(endpoint, requestedEpcs);

    return {
      operationState: this.hexByte(values.get(0x80)) || '0x31',
      waterHeatingMode: this.hexByte(values.get(0xb0)),
      waterHeatingStatus: this.hexByte(values.get(0xb2)),
      tankMode: this.hexByte(values.get(0xb6)),
      daytimeReheating: this.boolean41(values.get(0xc0)),
      bathAuto: this.boolean41(values.get(0xe3)),
      tankTemperature: this.unsignedNumber(values.get(0xc1)),
      suppliedWaterTemperature: this.unsignedNumber(values.get(0xd1)),
      bathWaterTemperature: this.unsignedNumber(values.get(0xd3)),
      remainingWaterLiters: this.unsignedNumber(values.get(0xe1)),
      tankCapacityLiters: this.unsignedNumber(values.get(0xe2)),
      hotWaterSupplyStatus: this.hexByte(values.get(0xc3)),
      bathOperationStatus: this.hexByte(values.get(0xea)),
      bathWaterVolume: this.unsignedNumber(values.get(0xee)),
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  private async getEchonetSolarEnergyStatus(): Promise<EnergyStatus> {
    const endpoint = this.echonetEndpointForHomeSolar();
    if (!endpoint) {
      return {};
    }

    const values = await this.echonetClient.getProperties(endpoint, this.supportedGetEpcs(endpoint, [
      0x80, // Operation status
      0xe0, // Measured instantaneous amount of electricity generated, W
      0xe1, // Measured cumulative amount of electric energy generated, 0.001 kWh
      0xe3, // Measured cumulative amount of electric energy sold, 0.001 kWh
      0xe8, // Rated power generation output, W
    ]));

    return {
      solarEndpoint: formatEndpoint(endpoint),
      solarOperationState: this.hexByte(values.get(0x80)),
      solarGenerationWatts: this.unsignedNumber(values.get(0xe0)),
      solarRatedPowerWatts: this.unsignedNumber(values.get(0xe8)),
      solarCumulativeGeneratedKwh: this.milliKwh(values.get(0xe1)),
      solarCumulativeSoldKwh: this.milliKwh(values.get(0xe3)),
    };
  }

  private async getEchonetBatteryEnergyStatus(): Promise<EnergyStatus> {
    const endpoint = this.echonetEndpointForStorageBattery();
    if (!endpoint) {
      return {};
    }

    const values = await this.echonetClient.getProperties(endpoint, this.supportedGetEpcs(endpoint, [
      0x80, // Operation status
      0xcf, // Working operation status
      0xd3, // Measured instantaneous charging/discharging electric power, signed W
      0xd6, // Measured cumulative discharging electric energy, 0.001 kWh
      0xd8, // Measured cumulative charging electric energy, 0.001 kWh
      0xda, // Operation mode setting
      0xe4, // Remaining stored electricity 3, %
    ]));
    const workingStatus = this.hexByte(values.get(0xcf));
    const batteryPowerWatts = this.signedNumber(values.get(0xd3));

    return {
      batteryEndpoint: formatEndpoint(endpoint),
      batteryOperationState: this.hexByte(values.get(0x80)),
      batteryWorkingStatus: workingStatus,
      batteryOperationMode: this.hexByte(values.get(0xda)),
      batteryPercent: this.unsignedNumber(values.get(0xe4)),
      batteryPowerWatts,
      batteryCharging: workingStatus === '0x42' || (batteryPowerWatts !== undefined && batteryPowerWatts > 0),
      batteryDischarging: workingStatus === '0x43' || (batteryPowerWatts !== undefined && batteryPowerWatts < 0),
      batteryStandby: workingStatus === '0x44' || batteryPowerWatts === 0,
      batteryCumulativeChargingKwh: this.milliKwh(values.get(0xd8)),
      batteryCumulativeDischargingKwh: this.milliKwh(values.get(0xd6)),
    };
  }

  private async getEchonetMultipleInputPcsStatus(): Promise<EnergyStatus> {
    const endpoint = this.echonetEndpointForMultipleInputPcs();
    if (!endpoint) {
      return {};
    }

    const values = await this.echonetClient.getProperties(endpoint, this.supportedGetEpcs(endpoint, [
      0xe0, // Measured cumulative electric energy, normal direction, 0.001 kWh
      0xe3, // Measured cumulative electric energy, reverse direction, 0.001 kWh
      0xe7, // Measured instantaneous electric power, signed W
    ]));

    return {
      gridEndpoint: formatEndpoint(endpoint),
      gridSource: 'multipleInputPcs',
      gridPowerWatts: this.signedNumber(values.get(0xe7)),
      gridCumulativeNormalKwh: this.milliKwh(values.get(0xe0)),
      gridCumulativeReverseKwh: this.milliKwh(values.get(0xe3)),
    };
  }

  private async setEchonetShutterPosition(endpoint: EchonetLiteEndpoint, targetPosition: number): Promise<void> {
    if (targetPosition > 0 && targetPosition < 100) {
      await this.echonetClient.setProperty(endpoint, 0xe1, bufferFromHexByte(targetPosition));
      return;
    }

    await this.echonetClient.setProperty(
      endpoint,
      0xe0,
      bufferFromHexByte(this.echonetShutterCommandForTarget(targetPosition)),
    );
  }

  private async setEchonetShutterStop(endpoint: EchonetLiteEndpoint): Promise<void> {
    await this.echonetClient.setProperty(endpoint, 0xe0, bufferFromHexByte(0x43));
  }

  private async setEchonetAirPurifierMode(endpoint: EchonetLiteEndpoint, mode: string): Promise<void> {
    const state = mode === AIR_PURIFIER_MODE_STOP ? '0x31' : '0x30';
    await this.echonetClient.setProperty(endpoint, 0x80, bufferFromHexByte(state));

    const modeEpc = this.echonetAirPurifierModeEpc(endpoint, 'setProperties');
    if (mode !== AIR_PURIFIER_MODE_STOP && modeEpc) {
      await this.echonetClient.setProperty(
        endpoint,
        modeEpc,
        bufferFromHexByte(this.echonetAirPurifierModeToValue(modeEpc, mode)),
      );
    }
  }

  private async setEchonetDoorLock(endpoint: EchonetLiteEndpoint, secured: boolean): Promise<void> {
    await this.echonetClient.setProperty(endpoint, 0x80, bufferFromHexByte(secured ? 0x30 : 0x31));
  }

  async getContactSensorStatus(device: ContactSensorDevice): Promise<ContactSensorStatus> {
    const status = await this.getLockupStatus();
    const sensor = status.arrayOcDevList.find(item => item.nodeId === device.nodeId && item.regNo === device.regNo);

    if (!sensor) {
      throw new Error(`AiSEG2 did not return contact sensor data for '${device.displayName}'`);
    }

    return {
      contactDetected: this.contactDetected(sensor),
      lowBattery: sensor.batteryUHF === 'U00' || sensor.batteryUHF === 'U01',
      locked: this.locked(sensor),
    };
  }

  async getSmokeSensorStatus(device: SmokeSensorDevice): Promise<SmokeSensorStatus> {
    const page = await this.getFireAlarmPageData(device.nodeId, device.eoj);
    const alarm = page.arrayRegDevList.find(item => item.equipIndex === device.equipIndex);

    if (!alarm) {
      throw new Error(`AiSEG2 did not return smoke sensor data for '${device.displayName}'`);
    }

    return {
      smokeDetected: Boolean(alarm.color) || Boolean(alarm.time && alarm.time !== '-'),
      lowBattery: alarm.battVisible !== undefined && alarm.battVisible !== 'hidden',
    };
  }

  async getControlToken(): Promise<string> {
    return this.getPageToken(LIGHTING_PAGE_PATH, false, 'action');
  }

  async getAirConditionerControlToken(): Promise<string> {
    return this.getPageToken(AIRCON_PAGE_PATH, false, 'action');
  }

  async getShutterControlToken(): Promise<string> {
    return this.getPageToken(SHUTTER_PAGE_PATH, false, 'action');
  }

  supportsShutterHalfOpen(device: ShutterDevice): boolean {
    return this.shutterDetailOperationPage(device) !== undefined;
  }

  async getAirPurifierControlToken(device: AirPurifierDevice): Promise<string> {
    return this.getPageToken(
      `/page/devices/device/327?track=32&page=2&nodeid=${device.nodeId}&eoj=${device.eoj}&devtype=${device.type}`,
      false,
      'action',
    );
  }

  async getDoorLockControlToken(): Promise<string> {
    return this.getPageToken(LOCKUP_PAGE_PATH, false, 'action');
  }

  async getPageToken(path: string, force = false, priority: RequestPriority = 'normal'): Promise<string> {
    const now = Date.now();
    const cached = this.pageTokenCache.get(path);
    if (!force && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const html = await this.requestText(path, {}, priority);
    const $ = loadHtml(html);
    const token = $('#main').attr('token') ||
      $('[token]').first().attr('token') ||
      $('.setting_value').first().text().trim();

    if (!token) {
      throw new Error(`AiSEG2 did not return a control token for ${path}`);
    }

    const value = this.normalizeToken(token);
    this.pageTokenCache.set(path, {
      value,
      expiresAt: now + 10000,
    });

    return value;
  }

  async changeLighting(
    device: LightingDevice,
    token: string,
    onoff: string,
    modulate: string,
  ): Promise<LightingChangeResponse> {
    const response = await this.postJson<LightingChangeResponse>(LIGHTING_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      device: {
        onoff,
        modulate,
      },
    }, 'action');
    this.lightingPanelCache = undefined;
    this.lightingPanelInflight = undefined;

    return response;
  }

  async changeAirConditionerPower(
    device: AirConditionerDevice,
    token: string,
    status: AirConditionerStatus,
  ): Promise<OperationResponse> {
    const response = await this.postJson<OperationResponse>(AIRCON_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      state: status.state,
    }, 'action');
    this.airConditionerPanelCache = undefined;
    this.airConditionerPanelInflight = undefined;

    return response;
  }

  async changeAirConditionerMode(
    device: AirConditionerDevice,
    mode: AirConditionerMode | string,
  ): Promise<AirConditionerOperationResponse> {
    return this.changeAirConditionerSetting(device, '1', mode);
  }

  async changeAirConditionerTemperature(
    device: AirConditionerDevice,
    temperature: number,
  ): Promise<AirConditionerOperationResponse> {
    return this.changeAirConditionerSetting(device, '2', String(Math.round(temperature)));
  }

  async changeAirConditionerFanMode(
    device: AirConditionerDevice,
    fanMode: AirConditionerFanMode | string,
  ): Promise<AirConditionerOperationResponse> {
    return this.changeAirConditionerSetting(device, '3', fanMode);
  }

  private async changeAirConditionerSetting(
    device: AirConditionerDevice,
    settingType: string,
    value: string,
  ): Promise<AirConditionerOperationResponse> {
    const token = await this.prepareAirConditionerSetting(device, settingType, value);
    const response = await this.postJson<OperationResponse>(AIRCON_DETAIL_CHANGE_PATH, {
      ...this.airConditionerRequestParams(device),
      token,
    }, 'action');
    this.airConditionerPanelCache = undefined;
    this.airConditionerPanelInflight = undefined;
    this.airConditionerDetailCache.delete(this.airConditionerKey(device));
    this.airConditionerDetailInflight.delete(this.airConditionerKey(device));

    return {
      ...response,
      token,
    };
  }

  async changeShutterPosition(device: ShutterDevice, token: string, targetPosition: number): Promise<ShutterOperationResponse> {
    const endpoint = this.echonetEndpointForShutter(device);
    if (endpoint && this.canSetEchonetShutterPosition(endpoint, targetPosition)) {
      try {
        await this.setEchonetShutterPosition(endpoint, targetPosition);
        this.shutterCache = undefined;
        this.shutterInflight = undefined;
        return {
          result: CheckResult.OK,
          operationPage: 'echonet',
          command: String(this.echonetShutterCommandForTarget(targetPosition)),
          transport: 'ECHONET Lite',
          endpoint: formatEndpoint(endpoint),
        };
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.changeAisegShutterPosition(device, token, targetPosition);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.changeAisegShutterPosition(device, token, targetPosition);
  }

  private async changeAisegShutterPosition(
    device: ShutterDevice,
    token: string,
    targetPosition: number,
  ): Promise<ShutterOperationResponse> {
    const controlToken = token || await this.getShutterControlToken();
    const command = this.shutterCommandForTarget(device, targetPosition);
    const operationPage = command === '3'
      ? this.shutterDetailOperationPage(device) || '325'
      : '325';
    const response = await this.postShutterOperation(device, controlToken, command, operationPage);

    return {
      ...response,
      operationPage,
      command,
      token: controlToken,
      transport: 'AiSEG2',
    };
  }

  async stopShutter(device: ShutterDevice, token: string): Promise<ShutterOperationResponse> {
    const endpoint = this.echonetEndpointForShutter(device);
    if (endpoint) {
      try {
        await this.setEchonetShutterStop(endpoint);
        this.shutterCache = undefined;
        this.shutterInflight = undefined;
        return {
          result: CheckResult.OK,
          operationPage: 'echonet',
          command: 'stop',
          transport: 'ECHONET Lite',
          endpoint: formatEndpoint(endpoint),
        };
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.stopAisegShutter(device, token);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.stopAisegShutter(device, token);
  }

  private async stopAisegShutter(device: ShutterDevice, token: string): Promise<ShutterOperationResponse> {
    const controlToken = token || await this.getShutterControlToken();
    const command = '2';
    const operationPage = '325';
    const response = await this.postShutterOperation(device, controlToken, command, operationPage);

    return {
      ...response,
      operationPage,
      command,
      token: controlToken,
      transport: 'AiSEG2',
    };
  }

  private async postShutterOperation(
    device: ShutterDevice,
    token: string,
    open: string,
    operationPage: string,
  ): Promise<OperationResponse> {
    const response = await this.postJson<OperationResponse>(`/action/devices/device/${operationPage}/operation`, {
      token,
      objSendData: JSON.stringify({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        device: {
          open,
        },
      }),
    }, 'action');
    this.shutterCache = undefined;
    this.shutterInflight = undefined;

    return response;
  }

  async changeAirPurifierMode(device: AirPurifierDevice, token: string, mode: string): Promise<OperationResponse> {
    const endpoint = this.echonetEndpointForAirPurifier(device);
    if (endpoint) {
      try {
        await this.setEchonetAirPurifierMode(endpoint, mode);
        this.airPurifierCache.delete(this.airPurifierKey(device));
        this.airPurifierInflight.delete(this.airPurifierKey(device));
        return {
          result: CheckResult.OK,
          transport: 'ECHONET Lite',
          endpoint: formatEndpoint(endpoint),
        };
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.changeAisegAirPurifierMode(device, token, mode);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.changeAisegAirPurifierMode(device, token, mode);
  }

  private async changeAisegAirPurifierMode(device: AirPurifierDevice, token: string, mode: string): Promise<OperationResponse> {
    const controlToken = token || await this.getAirPurifierControlToken(device);
    const state = mode === '0x40' ? '0x31' : '0x30';
    const response = await this.postJson<OperationResponse>(AIR_PURIFIER_OPERATION_PATH, {
      token: controlToken,
      objSendData: JSON.stringify({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        state,
        device: {
          state,
          mode,
        },
        airclean: {
          mode,
          type: mode,
        },
      }),
    }, 'action');
    this.airPurifierCache.delete(this.airPurifierKey(device));
    this.airPurifierInflight.delete(this.airPurifierKey(device));

    return {
      ...response,
      token: controlToken,
      transport: 'AiSEG2',
    };
  }

  async changeEcocuteWaterHeatingMode(device: EcocuteDevice, mode: EcocuteWaterHeatingMode): Promise<OperationResponse> {
    const endpoint = this.echonetEndpointForEcocute(device);
    if (!endpoint) {
      throw new Error(`No matching ECHONET Lite endpoint for EcoCute '${device.displayName}'`);
    }

    if (!this.echonetObjectHasProperty(endpoint, 'setProperties', 0xb0)) {
      throw new Error(`EcoCute '${device.displayName}' does not expose water heating control`);
    }

    await this.echonetClient.setProperty(endpoint, 0xb0, bufferFromHexByte(mode));
    return {
      result: CheckResult.OK,
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  async changeEcocuteBathAuto(device: EcocuteDevice, enabled: boolean): Promise<OperationResponse> {
    const endpoint = this.echonetEndpointForEcocute(device);
    if (!endpoint) {
      throw new Error(`No matching ECHONET Lite endpoint for EcoCute '${device.displayName}'`);
    }

    if (!this.echonetObjectHasProperty(endpoint, 'setProperties', 0xe3)) {
      throw new Error(`EcoCute '${device.displayName}' does not expose automatic bath control`);
    }

    await this.echonetClient.setProperty(endpoint, 0xe3, bufferFromHexByte(enabled ? 0x41 : 0x42));
    return {
      result: CheckResult.OK,
      transport: 'ECHONET Lite',
      endpoint: formatEndpoint(endpoint),
    };
  }

  async changeDoorLock(device: DoorLockDevice, token: string, status: DoorLockStatus): Promise<OperationResponse> {
    const endpoint = this.echonetEndpointForDoorLock(device);
    if (endpoint && status.secured !== undefined) {
      try {
        await this.setEchonetDoorLock(endpoint, !status.secured);
        this.lockupCache = undefined;
        this.lockupInflight = undefined;
        return {
          result: CheckResult.OK,
          transport: 'ECHONET Lite',
          endpoint: formatEndpoint(endpoint),
        };
      } catch (error) {
        if (!this.echonetOptions.fallbackToAiseg) {
          throw error;
        }
        const fallback = await this.changeAisegDoorLock(device, token, status);
        return {
          ...fallback,
          fallbackReason: this.formatError(error),
        };
      }
    }

    return this.changeAisegDoorLock(device, token, status);
  }

  private async changeAisegDoorLock(device: DoorLockDevice, token: string, status: DoorLockStatus): Promise<OperationResponse> {
    if (!status.statecmd) {
      throw new Error(`AiSEG2 did not return a door lock command for '${device.displayName}'`);
    }

    const controlToken = token || await this.getDoorLockControlToken();
    const response = await this.postJson<OperationResponse>(LOCKUP_CHANGE_PATH, {
      token: controlToken,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      state: status.statecmd,
    }, 'action');
    this.lockupCache = undefined;
    this.lockupInflight = undefined;

    return {
      ...response,
      token: controlToken,
      transport: 'AiSEG2',
    };
  }

  async checkLightingChange(acceptId: number): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(LIGHTING_CHECK_PATH, {
      acceptId: String(acceptId),
      type: '0x92',
    }, 'action');

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkAirConditionerChange(
    acceptId: number,
    device: AirConditionerDevice,
    token: string,
  ): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(AIRCON_DETAIL_CHECK_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      nodeId: device.nodeId,
      eoj: device.eoj,
      token,
    }, 'action');

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkShutterChange(
    acceptId: number,
    device: ShutterDevice,
    token: string,
    operationPage = '325',
  ): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(`/action/devices/device/${operationPage}/get_operation_status`, {
      acceptId: String(acceptId),
      type: device.type,
      token,
    }, 'action');

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkAirPurifierChange(acceptId: number, device: AirPurifierDevice, token: string): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(AIR_PURIFIER_STATUS_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      token,
    }, 'action');

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkDoorLockChange(acceptId: number, device: DoorLockDevice, token: string): Promise<CheckResult> {
    const status = await this.getLockupStatus(true, 'action');
    const elValidList = status.arrayElDevList
      .filter(lock => lock.cacheValid === '0x01')
      .map(lock => ({
        nodeId: lock.nodeId,
        eoj: lock.eoj,
      }));
    const response = await this.postJson<{ result?: CheckResult }>(LOCKUP_CHECK_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      nodeId: device.nodeId,
      eoj: device.eoj,
      token,
      elValidList,
    }, 'action');

    return this.requireCheckResult(response.result, acceptId);
  }

  private async getLightingPanelData(force = false, priority: RequestPriority = 'normal'): Promise<LightingPanelData[]> {
    const now = Date.now();
    if (!force && this.lightingPanelCache && this.lightingPanelCache.expiresAt > now) {
      return this.lightingPanelCache.value;
    }

    if (!force && this.lightingPanelInflight) {
      return this.lightingPanelInflight;
    }

    this.lightingPanelInflight = this.fetchLightingPanelData(now, priority).finally(() => {
      this.lightingPanelInflight = undefined;
    });

    return this.lightingPanelInflight;
  }

  private async getAirConditionerPanelData(force = false, priority: RequestPriority = 'normal'): Promise<AirConditionerPanelData[]> {
    const now = Date.now();
    if (!force && this.airConditionerPanelCache && this.airConditionerPanelCache.expiresAt > now) {
      return this.airConditionerPanelCache.value;
    }

    if (!force && this.airConditionerPanelInflight) {
      return this.airConditionerPanelInflight;
    }

    this.airConditionerPanelInflight = this.fetchAirConditionerPanelData(now, priority).finally(() => {
      this.airConditionerPanelInflight = undefined;
    });

    return this.airConditionerPanelInflight;
  }

  private async fetchLightingPanelData(now: number, priority: RequestPriority): Promise<LightingPanelData[]> {
    const devices = await this.getLightingDevices();
    const response = await this.postJson<LightingAutoUpdateResponse>(LIGHTING_AUTO_UPDATE_PATH, {
      page: '1',
      list: devices.map(device => this.lightingRequestDevice(device)),
    }, priority);
    const value = response.panelData || [];

    this.lightingPanelCache = {
      value,
      expiresAt: now + 3000,
    };

    return value;
  }

  private async fetchAirConditionerPanelData(now: number, priority: RequestPriority): Promise<AirConditionerPanelData[]> {
    const devices = await this.getAirConditionerDevices();
    const response = await this.postJson<AirConditionerAutoUpdateResponse>(AIRCON_AUTO_UPDATE_PATH, {
      page: '1',
      individual_page: '1',
      list: devices.map(device => ({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
      })),
    }, priority);
    const value = response.links || [];

    this.airConditionerPanelCache = {
      value,
      expiresAt: now + 10000,
    };

    return value;
  }

  private async getAirConditionerDetailStatus(
    device: AirConditionerDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirConditionerDetailUpdateResponse> {
    const key = this.airConditionerKey(device);
    const now = Date.now();
    const cached = this.airConditionerDetailCache.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.airConditionerDetailInflight.get(key);
    if (!force && inflight) {
      return inflight;
    }

    const request = this.fetchAirConditionerDetailStatus(device, key, now, priority).finally(() => {
      this.airConditionerDetailInflight.delete(key);
    });
    this.airConditionerDetailInflight.set(key, request);

    return request;
  }

  private async fetchAirConditionerDetailStatus(
    device: AirConditionerDevice,
    key: string,
    now: number,
    priority: RequestPriority,
  ): Promise<AirConditionerDetailUpdateResponse> {
    const value = await this.postJson<AirConditionerDetailUpdateResponse>(
      AIRCON_DETAIL_UPDATE_PATH,
      this.airConditionerRequestParams(device),
      priority,
    );

    this.airConditionerDetailCache.set(key, {
      value,
      expiresAt: now + 5000,
    });

    return value;
  }

  private async fetchAirConditionerCapabilities(
    device: AirConditionerDevice,
    key: string,
    now: number,
  ): Promise<AirConditionerCapabilities> {
    const [modeHtml, temperatureHtml, fanHtml] = await Promise.all([
      this.requestText(this.airConditionerSettingPagePath(device, '32111')),
      this.requestText(this.airConditionerSettingPagePath(device, '32112')),
      this.requestText(this.airConditionerSettingPagePath(device, '32113')),
    ]);
    const temperaturePage = loadHtml(temperatureHtml);
    const currentMode = this.extractSettingValue(modeHtml);
    const targetTemperature = this.parseTemperature(temperaturePage('#setting_value').attr('value'));
    const capabilities: AirConditionerCapabilities = {
      modes: this.parseAirConditionerControlOptions(modeHtml),
      fanModes: this.parseAirConditionerControlOptions(fanHtml),
      currentMode,
      currentFanMode: this.extractSettingValue(fanHtml),
      minTemperature: this.parseTemperatureLimit(temperaturePage('#btn_minus').attr('temp_limit_min')),
      maxTemperature: this.parseTemperatureLimit(temperaturePage('#btn_plus').attr('temp_limit_max')),
      targetTemperature,
      ...this.airConditionerModeTargetTemperatures(currentMode || '', targetTemperature),
    };

    this.airConditionerCapabilitiesCache.set(key, {
      value: capabilities,
      expiresAt: now + 60 * 60 * 1000,
    });

    return capabilities;
  }

  private async getShutterPanelData(force = false, priority: RequestPriority = 'normal'): Promise<ShutterPanelData[]> {
    const now = Date.now();
    if (!force && this.shutterCache && this.shutterCache.expiresAt > now) {
      return this.shutterCache.value;
    }

    if (!force && this.shutterInflight) {
      return this.shutterInflight;
    }

    this.shutterInflight = this.fetchShutterPanelData(now, priority).finally(() => {
      this.shutterInflight = undefined;
    });

    return this.shutterInflight;
  }

  private async fetchShutterPanelData(now: number, priority: RequestPriority): Promise<ShutterPanelData[]> {
    const html = await this.requestText(SHUTTER_PAGE_PATH, {}, priority);
    let panelData = this.extractInitArgument<ShutterPanelData[]>(html, 0);

    try {
      const token = this.extractTokenFromHtml(html);
      const response = await this.postJson<ShutterAutoUpdateResponse>(SHUTTER_AUTO_UPDATE_PATH, {
        token,
        list: JSON.stringify(panelData.map(device => ({
          nodeId: device.nodeId,
          eoj: device.eoj,
          type: device.type,
        }))),
      }, priority);

      if (response.arrayControlDevInfo) {
        panelData = JSON.parse(response.arrayControlDevInfo) as ShutterPanelData[];
      }
    } catch {
      // Falling back to the page snapshot is good enough for HomeKit polling.
    }

    this.shutterCache = {
      value: panelData,
      expiresAt: now + 2000,
    };

    return panelData;
  }

  private async getAirPurifierPageData(
    device: AirPurifierDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirPurifierPageData> {
    const key = this.airPurifierKey(device);
    const now = Date.now();
    const cached = this.airPurifierCache.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.airPurifierInflight.get(key);
    if (!force && inflight) {
      return inflight;
    }

    const request = this.fetchAirPurifierPageData(device, key, now, priority).finally(() => {
      this.airPurifierInflight.delete(key);
    });
    this.airPurifierInflight.set(key, request);

    return request;
  }

  private async fetchAirPurifierPageData(
    device: AirPurifierDevice,
    key: string,
    now: number,
    priority: RequestPriority,
  ): Promise<AirPurifierPageData> {
    const html = await this.requestText(
      `/page/devices/device/327?track=32&page=2&nodeid=${device.nodeId}&eoj=${device.eoj}&devtype=${device.type}`,
      {},
      priority,
    );

    const value = this.extractInitArgument<AirPurifierPageData>(html, 0);
    this.airPurifierCache.set(key, {
      value,
      expiresAt: now + 5000,
    });

    return value;
  }

  private async getAirEnvironmentDeviceData(): Promise<AirEnvironmentDeviceData[]> {
    const devices = await this.getAirEnvironmentSensorDevices();
    return devices.map(device => ({
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      nodeIdentNum: device.nodeIdentNum,
      devId: device.devId,
    }));
  }

  private async getAirEnvironmentStatuses(force = false): Promise<Map<string, AirEnvironmentStatus>> {
    const now = Date.now();
    if (!force && this.airEnvironmentStatusCache && this.airEnvironmentStatusCache.expiresAt > now) {
      return this.airEnvironmentStatusCache.value;
    }

    if (!force && this.airEnvironmentStatusInflight) {
      return this.airEnvironmentStatusInflight;
    }

    this.airEnvironmentStatusInflight = this.fetchAirEnvironmentStatuses(now).finally(() => {
      this.airEnvironmentStatusInflight = undefined;
    });

    return this.airEnvironmentStatusInflight;
  }

  private async fetchAirEnvironmentStatuses(now: number): Promise<Map<string, AirEnvironmentStatus>> {
    const deviceInfo = await this.getAirEnvironmentDeviceData();
    const response = await this.postJson<AirEnvironmentAutoUpdateResponse>(AIR_ENVIRONMENT_DEVICE_AUTO_UPDATE_PATH, {
      device_Info: deviceInfo,
      page: 1,
    });
    const value = new Map<string, AirEnvironmentStatus>();

    deviceInfo.forEach((device, index) => {
      if (!device.nodeId || !device.eoj) {
        return;
      }

      value.set(this.airEnvironmentDeviceKey(device), this.parseAirEnvironmentStatus(response.dispInfo?.[index] || ''));
    });

    this.airEnvironmentStatusCache = {
      value,
      expiresAt: now + 10000,
    };

    return value;
  }

  private async getLockupStatus(force = false, priority: RequestPriority = 'normal'): Promise<LockupStatusResponse> {
    const now = Date.now();
    if (!force && this.lockupCache && this.lockupCache.expiresAt > now) {
      return this.lockupCache.value;
    }

    if (!force && this.lockupInflight) {
      return this.lockupInflight;
    }

    this.lockupInflight = this.fetchLockupStatus(now, priority).finally(() => {
      this.lockupInflight = undefined;
    });

    return this.lockupInflight;
  }

  private async fetchLockupStatus(now: number, priority: RequestPriority): Promise<LockupStatusResponse> {
    const html = await this.requestText(LOCKUP_PAGE_PATH, {}, priority);
    const pageStatus = this.extractInitArgument<LockupStatusResponse>(html, 0);
    const elValidList = pageStatus.arrayElDevList
      .filter(lock => lock.cacheValid === '0x01')
      .map(lock => ({
        nodeId: lock.nodeId,
        eoj: lock.eoj,
      }));

    const value = await this.postJson<LockupStatusResponse>(LOCKUP_AUTO_UPDATE_PATH, {
      elValidList,
    }, priority);

    this.lockupCache = {
      value,
      expiresAt: now + 2000,
    };

    return value;
  }

  private async getFireAlarmPageData(nodeId: string, eoj: string, force = false): Promise<FireAlarmPageData> {
    const key = `${nodeId}:${eoj}`;
    const now = Date.now();
    const cached = this.smokeCache.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.smokeInflight.get(key);
    if (!force && inflight) {
      return inflight;
    }

    const request = this.fetchFireAlarmPageData(nodeId, eoj, key, now).finally(() => {
      this.smokeInflight.delete(key);
    });
    this.smokeInflight.set(key, request);

    return request;
  }

  private async fetchFireAlarmPageData(nodeId: string, eoj: string, key: string, now: number): Promise<FireAlarmPageData> {
    const html = await this.requestText(`/page/devices/device/32h?page=2&nodeId=${nodeId}&eoj=${eoj}`);
    const page = this.extractInitArgument<FireAlarmPageData>(html, 2);
    let value = page;

    try {
      const response = await this.postJson<Pick<FireAlarmPageData, 'arrayRegDevList'>>(FIRE_ALARM_AUTO_UPDATE_PATH, {
        page: '2',
        nodeId,
        eoj,
      });
      value = {
        ...page,
        arrayRegDevList: response.arrayRegDevList,
      };
    } catch {
      value = page;
    }

    this.smokeCache.set(key, {
      value,
      expiresAt: now + 5000,
    });

    return value;
  }

  private async prepareAirConditionerSetting(
    device: AirConditionerDevice,
    settingType: string,
    value: string,
  ): Promise<string> {
    const requestParams = this.airConditionerRequestParams(device);
    const html = await this.postFormText(this.airConditionerDetailPagePath(device), {
      ...requestParams,
      setting_type: settingType,
      value,
      request_by_form: '1',
    }, 'action');
    const token = this.extractTokenFromHtml(html);

    if (!this.airConditionerPreparedSettingMatched(html, settingType, value)) {
      throw new Error(
        `AiSEG2 did not stage air conditioner setting ${settingType}=${value} for '${device.displayName}'`,
      );
    }

    return token;
  }

  private async requestText(path: string, options: RequestOptions = {}, priority: RequestPriority = 'normal'): Promise<string> {
    return this.runQueuedRequest(async () => {
      const response = await httpRequest<string>(this.url(path), {
        ...this.baseOptions(),
        ...options,
        dataType: 'text',
      });

      this.assertSuccessfulResponse(path, response.status);
      return response.data;
    }, priority);
  }

  private async postJson<T>(path: string, data: unknown, priority: RequestPriority = 'normal'): Promise<T> {
    return this.runQueuedRequest(async () => {
      const response = await httpRequest<T>(this.url(path), {
        ...this.baseOptions(),
        method: 'POST',
        headers: FORM_HEADERS,
        data: this.formPayload(data),
        dataType: 'json',
      });

      this.assertSuccessfulResponse(path, response.status);
      return response.data;
    }, priority);
  }

  private baseOptions(): RequestOptions {
    return {
      digestAuth: `aiseg:${this.password}`,
      timeout: [10000, 20000],
    };
  }

  private async runQueuedRequest<T>(request: () => Promise<T>, priority: RequestPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedRequest = async () => {
        try {
          resolve(await request());
        } catch (error) {
          reject(error);
        }
      };

      const queue = priority === 'action' ? this.actionRequestQueue : this.normalRequestQueue;
      if (queue.length >= MAX_QUEUED_REQUESTS) {
        reject(new Error(`AiSEG2 ${priority} request queue is full`));
        return;
      }

      queue.push(queuedRequest);
      this.drainRequestQueue();
    });
  }

  private drainRequestQueue(): void {
    if (this.activeRequestCount > 0) {
      return;
    }

    const nextRequest = this.actionRequestQueue.shift() || this.normalRequestQueue.shift();
    if (!nextRequest) {
      return;
    }

    this.activeRequestCount++;
    void nextRequest().finally(() => {
      this.activeRequestCount--;
      this.drainRequestQueue();
    });
  }

  private async postFormText(
    path: string,
    data: Record<string, string>,
    priority: RequestPriority = 'normal',
  ): Promise<string> {
    return this.runQueuedRequest(async () => {
      const response = await httpRequest<string>(this.url(path), {
        ...this.baseOptions(),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: this.formFieldsPayload(data),
        dataType: 'text',
      });

      this.assertSuccessfulResponse(path, response.status);
      return response.data;
    }, priority);
  }

  private formPayload(data: unknown): string {
    return `data=${encodeURIComponent(JSON.stringify(data))}`;
  }

  private formFieldsPayload(data: Record<string, string>): string {
    return Object.entries(data)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  private lightingRequestDevice(device: LightingDevice): LightingDevice {
    return {
      kind: device.kind,
      displayName: device.displayName,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      nodeIdentNum: device.nodeIdentNum,
      deviceId: device.deviceId,
      uuidSeed: device.uuidSeed,
    };
  }

  private airConditionerRequestParams(device: AirConditionerDevice): Record<string, string> {
    return {
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      page: '1',
      individual_page: '1',
    };
  }

  private airConditionerDetailPagePath(device: AirConditionerDevice): string {
    return `${AIRCON_DETAIL_PAGE_PATH}?${this.formFieldsPayload(this.airConditionerRequestParams(device))}`;
  }

  private airConditionerSettingPagePath(device: AirConditionerDevice, page: string): string {
    return `${AIRCON_DETAIL_PAGE_PATH}/${page}?${this.formFieldsPayload(this.airConditionerRequestParams(device))}`;
  }

  private airConditionerKey(device: Pick<AirConditionerDevice, 'nodeId' | 'eoj'>): string {
    return `${device.nodeId}:${device.eoj}`;
  }

  private airConditionerModifyItem(
    status: AirConditionerDetailUpdateResponse | undefined,
    id: string,
  ): AirConditionerModifyItem | undefined {
    return status?.modify_items?.find(item => item.id_str === id);
  }

  private url(path: string): string {
    return `http://${this.host}${path}`;
  }

  private assertSuccessfulResponse(path: string, status: number): void {
    if (status < 200 || status >= 300) {
      throw new Error(`AiSEG2 request to ${path} failed with HTTP ${status}`);
    }
  }

  private extractInitArgument<T>(html: string, argumentIndex: number): T {
    const marker = 'window.onload = init(';
    const start = html.indexOf(marker);
    if (start < 0) {
      throw new Error('AiSEG2 page did not include init data');
    }

    const argsStart = start + marker.length;
    const args: string[] = [];
    let current = '';
    let depth = 0;
    let quote = '';
    let escaped = false;

    for (let index = argsStart; index < html.length; index++) {
      const char = html[index];

      if (quote) {
        current += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = '';
        }
        continue;
      }

      if (char === '"' || char === '\'') {
        quote = char;
        current += char;
        continue;
      }

      if (char === '[' || char === '{' || char === '(') {
        depth++;
      } else if (char === ']' || char === '}' || char === ')') {
        if (depth === 0 && char === ')') {
          args.push(current.trim());
          break;
        }
        depth--;
      }

      if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    const argument = args[argumentIndex];
    if (!argument) {
      throw new Error(`AiSEG2 init argument ${argumentIndex} was not found`);
    }

    return JSON.parse(argument) as T;
  }

  private extractScriptVariable<T>(html: string, variableName: string): T {
    const match = html.match(new RegExp(`var\\s+${variableName}\\s*=\\s*([^;]+);`));
    if (!match) {
      throw new Error(`AiSEG2 page did not include ${variableName} data`);
    }

    return JSON.parse(match[1]) as T;
  }

  private parseAirConditionerControlOptions(html: string): AirConditionerControlOption[] {
    const $ = loadHtml(html);
    const options: AirConditionerControlOption[] = [];

    $('.radio').each((index, element) => {
      const value = $(element).attr('value');
      if (!value) {
        return;
      }

      options.push({
        value,
        label: this.cleanDeviceName($(element).find('.button_text').text()),
        disabled: ($(element).attr('class') || '').split(/\s+/).includes('disable'),
      });
    });

    return options;
  }

  private extractSettingValue(html: string): string | undefined {
    const $ = loadHtml(html);
    const setting = $('#setting_value');

    return setting.is('input')
      ? setting.attr('value')
      : setting.text().trim() || undefined;
  }

  private airConditionerPreparedSettingMatched(html: string, settingType: string, value: string): boolean {
    const modifyItems = this.extractScriptVariable<AirConditionerModifyItem[]>(html, 'modify_items');
    const expectedId = this.airConditionerModifyItemId(settingType);
    const staged = modifyItems.find(item => item.id_str === expectedId);

    return staged?.after?.value === value;
  }

  private airConditionerModifyItemId(settingType: string): string {
    switch (settingType) {
      case '1':
        return 's_item_mode';
      case '2':
        return 's_item_temp';
      case '3':
        return 's_img_ac';
      default:
        return '';
    }
  }

  private airConditionerModeTargetTemperatures(
    mode: string,
    targetTemperature: number | undefined,
  ): Pick<AirConditionerStatus, 'coolingTargetTemperature' | 'heatingTargetTemperature'> {
    if (targetTemperature === undefined) {
      return {};
    }

    switch (mode) {
      case AirConditionerMode.Cool:
        return { coolingTargetTemperature: targetTemperature };
      case AirConditionerMode.Heat:
      case AirConditionerMode.HumidifyHeat:
        return { heatingTargetTemperature: targetTemperature };
      case AirConditionerMode.Auto:
        return {
          coolingTargetTemperature: targetTemperature,
          heatingTargetTemperature: targetTemperature,
        };
      default:
        return {};
    }
  }

  private extractAirEnvironmentDeviceNames(html: string): Map<string, string> {
    const $ = loadHtml(html);
    const names = new Map<string, string>();

    $('.base').each((index, element) => {
      const href = $(element).find('a[href*="nodeId="]').first().attr('href') || '';
      const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
      const params = new URLSearchParams(query);
      const nodeId = params.get('nodeId') || undefined;
      const eoj = params.get('eoj') || undefined;
      const type = params.get('type') || undefined;
      const rawName = $(element).find('.txt_name').first().html() || $(element).find('.txt_name').first().text();

      if (!nodeId || !eoj || !type || !rawName) {
        return;
      }

      names.set(this.airEnvironmentDeviceKey({ nodeId, eoj, type }), this.cleanDeviceName(rawName));
    });

    return names;
  }

  private extractTokenFromHtml(html: string): string {
    const $ = loadHtml(html);
    const token = $('#main').attr('token') ||
      $('[token]').first().attr('token') ||
      $('.setting_value').first().text().trim();

    if (!token) {
      throw new Error('AiSEG2 page did not include a token');
    }

    return this.normalizeToken(token);
  }

  private normalizeToken(token: string): string {
    return token.trim().replace(/^'|'$/g, '');
  }

  private requireCheckResult(result: CheckResult | undefined, acceptId: number): CheckResult {
    if (!result) {
      throw new Error(`AiSEG2 did not return status for request ${acceptId}`);
    }

    return result;
  }

  private cleanDeviceName(name: string): string {
    return name.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').replace(/・\s+/g, '・').trim();
  }

  private airEnvironmentDeviceKey(device: Pick<AirEnvironmentDeviceData, 'nodeId' | 'eoj' | 'type'>): string {
    return `${device.nodeId || ''}:${device.eoj || ''}:${device.type || ''}`;
  }

  private airPurifierKey(device: Pick<AirPurifierDevice, 'nodeId' | 'eoj' | 'type'>): string {
    return `${device.nodeId}:${device.eoj}:${device.type}`;
  }

  private airEnvironmentUuidSuffix(displayName: string): string {
    const normalized = displayName.normalize('NFKC');
    const sensorName = normalized.split('温湿センサ')[0].replace(/[・\s]+$/g, '').trim();
    return sensorName || normalized;
  }

  private parseTemperature(value: string | undefined): number | undefined {
    if (!value || value === '-' || value === '自動') {
      return undefined;
    }

    if (/^0x[0-9a-f]+$/i.test(value)) {
      const temperature = Number.parseInt(value, 16);
      return temperature >= 0 && temperature <= 50 ? temperature : undefined;
    }

    const match = value.replace(/<br\s*\/?>/gi, ' ').match(/(-?\d+(?:\.\d+)?)/);
    if (!match) {
      return undefined;
    }

    return Number(match[1]);
  }

  private parseTemperatureLimit(value: string | undefined): number | undefined {
    const temperature = Number(value);

    return Number.isFinite(temperature) ? temperature : undefined;
  }

  private parseHumidity(value: string | undefined): number | undefined {
    if (!value || value === '-') {
      return undefined;
    }

    const match = value.match(/(\d+(?:\.\d+)?)/);
    if (!match) {
      return undefined;
    }

    return Number(match[1]);
  }

  private parseAircleanLevel(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    if (/^0x[0-9a-f]+$/i.test(value)) {
      const hex = Number.parseInt(value, 16);
      return hex >= 0x30 ? hex - 0x30 : hex;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  private parseAirEnvironmentStatus(html: string): AirEnvironmentStatus {
    const $ = loadHtml(html);

    return {
      temperature: this.parseClassDigits($, '.num_ond'),
      humidity: this.parseClassDigits($, '.num_shitudo'),
    };
  }

  private parseClassDigits($: ReturnType<typeof loadHtml>, selector: string): number | undefined {
    let value = '';

    $(`${selector} .num, ${selector} .num_dot`).each((index, element) => {
      const classes = $(element).attr('class') || '';
      const digit = classes.match(/\bno(\d)\b/);

      if (digit) {
        value += digit[1];
      } else if (classes.includes('num_dot')) {
        value += '.';
      }
    });

    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private shutterCommandForTarget(device: ShutterDevice, targetPosition: number): string {
    if (targetPosition <= 0) {
      return '1';
    }

    if (targetPosition >= 100) {
      return '0';
    }

    return this.supportsShutterHalfOpen(device) ? '3' : '0';
  }

  private canSetEchonetShutterPosition(endpoint: EchonetLiteEndpoint, targetPosition: number): boolean {
    if (targetPosition <= 0 || targetPosition >= 100) {
      return true;
    }

    return this.echonetObjectHasProperty(endpoint, 'setProperties', 0xe1);
  }

  private canSetTimedEchonetShutterPosition(endpoint: EchonetLiteEndpoint): boolean {
    return this.echonetObjectHasProperty(endpoint, 'setProperties', 0xd2) &&
      this.echonetObjectHasProperty(endpoint, 'setProperties', 0xe9);
  }

  private echonetShutterCommandForTarget(targetPosition: number): number {
    return targetPosition <= 0 ? 0x42 : 0x41;
  }

  private echonetShutterPosition(openState: string): number {
    switch (openState) {
      case '0x41':
      case '0x43':
        return 100;
      case '0x42':
      case '0x44':
        return 0;
      default:
        return 50;
    }
  }

  private echonetShutterCondition(openState: string): string {
    switch (openState) {
      case '0x41':
        return '開';
      case '0x42':
        return '閉';
      case '0x43':
        return '開動作中';
      case '0x44':
        return '閉動作中';
      case '0x45':
        return '途中停止';
      default:
        return '';
    }
  }

  private shutterDetailOperationPage(device: ShutterDevice): string | undefined {
    if (device.type === '0x42') {
      return undefined;
    }

    const shutterType = Number.parseInt(device.shutterType || '', 16);
    switch (shutterType) {
      case 0x1010:
      case 0x2010:
      case 0x4010:
        return '3251';
      case 0x1011:
      case 0x2011:
      case 0x2111:
      case 0x4011:
        return '3252';
      case 0x1012:
      case 0x2012:
      case 0x2112:
      case 0x3111:
      case 0x3112:
      case 0x4012:
        return '3253';
      default:
        return undefined;
    }
  }

  private shutterPosition(data: ShutterPanelData): number {
    if (data.condition === '開' || data.shutter?.openState === '0x41') {
      return 100;
    }

    if (data.condition === '閉' || data.shutter?.openState === '0x42') {
      return 0;
    }

    return 50;
  }

  private doorLockStatus(data: LockupDoorData): DoorLockStatus {
    return {
      lockVal: data.lockVal || '',
      statecmd: data.statecmd || '',
      secured: data.lockVal === 'lock_val' ? true : data.lockVal === 'lock_val open' ? false : undefined,
      transport: 'AiSEG2',
    };
  }

  private findEchonetEndpoint(
    classCodes: string[],
    eoj?: string,
    host?: string,
  ): EchonetLiteEndpoint | undefined {
    const endpoint = this.findEchonetEndpoints(classCodes)
      .find(entry =>
        (!eoj || entry.object.eoj === eoj) &&
        (!host || entry.node.host === host),
      );

    return endpoint
      ? {
        host: endpoint.node.host,
        eoj: endpoint.object.eoj,
      }
      : undefined;
  }

  private findEchonetEndpoints(classCodes: string[]): Array<{
    node: EchonetLiteNode;
    object: EchonetLiteNode['objects'][number];
    productCode?: string;
  }> {
    return this.echonetNodes.flatMap(node => node.objects
      .filter(object => classCodes.includes(object.classCode))
      .map(object => ({
        node,
        object,
        productCode: object.productCode,
      })));
  }

  private findEchonetObject(endpoint: EchonetLiteEndpoint): EchonetLiteNode['objects'][number] | undefined {
    const normalizedEoj = normalizeEoj(endpoint.eoj);
    return this.echonetNodes
      .find(node => node.host === endpoint.host)
      ?.objects.find(object => object.eoj === normalizedEoj);
  }

  private hexByte(value: Buffer | undefined): string | undefined {
    if (!value || value.length < 1) {
      return undefined;
    }

    return `0x${value[0].toString(16).padStart(2, '0')}`;
  }

  private boolean41(value: Buffer | undefined): boolean | undefined {
    const byte = this.hexByte(value);
    if (byte === '0x41') {
      return true;
    }

    if (byte === '0x42') {
      return false;
    }

    return undefined;
  }

  private unsignedNumber(value: Buffer | undefined): number | undefined {
    if (!value || value.length === 0 || value.every(byte => byte === 0xff) || value[0] === 0xfd || value[0] === 0xfe) {
      return undefined;
    }

    return [...value].reduce((number, byte) => (number * 256) + byte, 0);
  }

  private signedNumber(value: Buffer | undefined): number | undefined {
    if (!value || value.length === 0) {
      return undefined;
    }

    const unsigned = [...value].reduce((number, byte) => (number * 256) + byte, 0);
    const bits = value.length * 8;
    const overflow = (2 ** (bits - 1)) - 1;
    const underflow = 2 ** (bits - 1);
    if (unsigned === overflow || unsigned === underflow) {
      return undefined;
    }

    const signBoundary = 2 ** (bits - 1);
    return unsigned >= signBoundary ? unsigned - (2 ** bits) : unsigned;
  }

  private milliKwh(value: Buffer | undefined): number | undefined {
    const raw = this.unsignedNumber(value);
    return raw === undefined ? undefined : raw / 1000;
  }

  private supportedGetEpcs(endpoint: EchonetLiteEndpoint, epcs: number[]): number[] {
    const supported = epcs.filter(epc => this.echonetObjectHasProperty(endpoint, 'getProperties', epc));
    return supported.length > 0 ? supported : epcs;
  }

  private echonetAirPurifierModeEpc(
    endpoint: EchonetLiteEndpoint,
    propertyMap: 'setProperties' | 'getProperties',
  ): number | undefined {
    if (this.echonetObjectHasProperty(endpoint, propertyMap, PANASONIC_AIR_PURIFIER_MODE_EPC)) {
      return PANASONIC_AIR_PURIFIER_MODE_EPC;
    }

    if (this.echonetObjectHasProperty(endpoint, propertyMap, STANDARD_AIR_PURIFIER_AIRFLOW_EPC)) {
      return STANDARD_AIR_PURIFIER_AIRFLOW_EPC;
    }

    return undefined;
  }

  private echonetAirPurifierModeFromValue(
    epc: number | undefined,
    value: string | undefined,
    state: string,
  ): string {
    if (state !== '0x30') {
      return AIR_PURIFIER_MODE_STOP;
    }

    if (!value) {
      return AIR_PURIFIER_MODE_AUTO;
    }

    if (epc === PANASONIC_AIR_PURIFIER_MODE_EPC) {
      return value;
    }

    if (epc === STANDARD_AIR_PURIFIER_AIRFLOW_EPC) {
      if (value === '0x41') {
        return AIR_PURIFIER_MODE_AUTO;
      }

      const level = Number.parseInt(value.replace(/^0x/u, ''), 16);
      if (!Number.isFinite(level)) {
        return AIR_PURIFIER_MODE_AUTO;
      }

      if (level <= 0x32) {
        return AIR_PURIFIER_MODE_WEAK;
      }
      if (level <= 0x34) {
        return AIR_PURIFIER_MODE_MEDIUM;
      }
      if (level <= 0x36) {
        return AIR_PURIFIER_MODE_STRONG;
      }

      return AIR_PURIFIER_MODE_TURBO;
    }

    return AIR_PURIFIER_MODE_AUTO;
  }

  private echonetAirPurifierModeToValue(epc: number, mode: string): string {
    if (epc === PANASONIC_AIR_PURIFIER_MODE_EPC) {
      return mode;
    }

    switch (mode) {
      case AIR_PURIFIER_MODE_WEAK:
        return '0x31';
      case AIR_PURIFIER_MODE_MEDIUM:
        return '0x34';
      case AIR_PURIFIER_MODE_STRONG:
        return '0x36';
      case AIR_PURIFIER_MODE_TURBO:
        return '0x38';
      default:
        return '0x41';
    }
  }

  private echonetObjectHasProperty(
    endpoint: EchonetLiteEndpoint,
    propertyMap: 'setProperties' | 'getProperties' | 'notificationProperties',
    epc: number,
  ): boolean {
    const object = this.findEchonetObject(endpoint);
    return Boolean(object?.[propertyMap]?.includes(`0x${epc.toString(16).padStart(2, '0')}`));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private contactDetected(data: LockupContactData): boolean {
    if (data.wSensorVal) {
      return data.wSensorVal !== 'wsensor_val open';
    }

    if (data.lockVal) {
      return data.lockVal !== 'lock_val open';
    }

    return true;
  }

  private locked(data: LockupContactData): boolean | undefined {
    if (data.lockVal === 'lock_val') {
      return true;
    }

    if (data.lockVal === 'lock_val open') {
      return false;
    }

    return undefined;
  }
}
