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
  LightingDevice,
  ShutterDevice,
  SmokeSensorDevice,
  displayNameFromSummary,
  uuidSeedFor,
} from './devices';


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
}

export interface ShutterStatus {
  state: string;
  openState: string;
  condition: string;
  position: number;
}

export interface AirPurifierStatus {
  state: string;
  mode: string;
  active: boolean;
  smellLevel?: number;
  pm25Level?: number;
  dustLevel?: number;
}

export interface AirEnvironmentStatus {
  temperature?: number;
  humidity?: number;
}

export interface DoorLockStatus {
  lockVal: string;
  statecmd: string;
  secured: boolean | undefined;
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
  private airEnvironmentDeviceCache?: CachedValue<AirEnvironmentSensorDevice[]>;
  private airEnvironmentStatusCache?: CachedValue<Map<string, AirEnvironmentStatus>>;
  private airEnvironmentStatusInflight?: Promise<Map<string, AirEnvironmentStatus>>;
  private pageTokenCache = new Map<string, CachedValue<string>>();
  private readonly actionRequestQueue: QueuedRequest[] = [];
  private readonly normalRequestQueue: QueuedRequest[] = [];
  private activeRequestCount = 0;

  constructor(
    private readonly host: string,
    private readonly password: string,
  ) {}

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

    return {
      state: source.state || '0x31',
      mode: source.mode || modeItem?.current?.value || AirConditionerMode.Auto,
      modeLabel: this.cleanDeviceName(modeItem?.current?.value_str || source.state_str || ''),
      fanMode: fanItem?.current?.value || undefined,
      fanModeLabel: this.cleanDeviceName(fanItem?.current?.value_str || ''),
      active: source.state === '0x30',
      currentTemperature: this.parseTemperature(source.inner),
      targetTemperature: this.parseTemperature(source.temp),
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
    };
  }

  async getAirPurifierStatus(
    device: AirPurifierDevice,
    force = false,
    priority: RequestPriority = 'normal',
  ): Promise<AirPurifierStatus> {
    const page = await this.getAirPurifierPageData(device, force, priority);
    const mode = page.airclean?.mode || '0x40';

    return {
      state: page.state || '0x31',
      mode,
      active: page.state === '0x30' && mode !== '0x40',
      smellLevel: this.parseAircleanLevel(page.airclean?.smell),
      pm25Level: this.parseAircleanLevel(page.airclean?.pm25),
      dustLevel: this.parseAircleanLevel(page.airclean?.dust),
    };
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
    const status = await this.getLockupStatus(force, priority);
    const lock = status.arrayElDevList.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);

    if (!lock) {
      throw new Error(`AiSEG2 did not return door lock data for '${device.displayName}'`);
    }

    return this.doorLockStatus(lock);
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
    const command = this.shutterCommandForTarget(device, targetPosition);
    const operationPage = command === '3'
      ? this.shutterDetailOperationPage(device) || '325'
      : '325';
    const response = await this.postShutterOperation(device, token, command, operationPage);

    return {
      ...response,
      operationPage,
      command,
    };
  }

  async stopShutter(device: ShutterDevice, token: string): Promise<ShutterOperationResponse> {
    const command = '2';
    const operationPage = '325';
    const response = await this.postShutterOperation(device, token, command, operationPage);

    return {
      ...response,
      operationPage,
      command,
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
    const state = mode === '0x40' ? '0x31' : '0x30';
    const response = await this.postJson<OperationResponse>(AIR_PURIFIER_OPERATION_PATH, {
      token,
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

    return response;
  }

  async changeDoorLock(device: DoorLockDevice, token: string, status: DoorLockStatus): Promise<OperationResponse> {
    if (!status.statecmd) {
      throw new Error(`AiSEG2 did not return a door lock command for '${device.displayName}'`);
    }

    const response = await this.postJson<OperationResponse>(LOCKUP_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      state: status.statecmd,
    }, 'action');
    this.lockupCache = undefined;
    this.lockupInflight = undefined;

    return response;
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
    const capabilities: AirConditionerCapabilities = {
      modes: this.parseAirConditionerControlOptions(modeHtml),
      fanModes: this.parseAirConditionerControlOptions(fanHtml),
      currentMode: this.extractSettingValue(modeHtml),
      currentFanMode: this.extractSettingValue(fanHtml),
      minTemperature: this.parseTemperatureLimit(temperaturePage('#btn_minus').attr('temp_limit_min')),
      maxTemperature: this.parseTemperatureLimit(temperaturePage('#btn_plus').attr('temp_limit_max')),
      targetTemperature: this.parseTemperature(temperaturePage('#setting_value').attr('value')),
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
    return `data=${JSON.stringify(data)}`;
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
    };
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
