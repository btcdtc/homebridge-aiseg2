import { request as httpRequest, RequestOptions } from 'urllib';
import { load as loadHtml } from 'cheerio';

import {
  Aiseg2DeviceSummary,
  Aiseg2DeviceType,
  AirConditionerDevice,
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
  active: boolean;
  currentTemperature?: number;
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
}

export interface DoorLockStatus {
  lockVal: string;
  statecmd: string;
  secured: boolean | undefined;
}

export interface ContactSensorStatus {
  contactDetected: boolean;
  lowBattery: boolean;
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

export type LightingChangeResponse = OperationResponse;

interface LightingPanelData {
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
  mode?: string;
  temp?: string;
  inner?: string;
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
  };
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

const DEVICE_LIST_PATH = '/page/devices/device/32';
const LIGHTING_PAGE_PATH = '/page/devices/device/32i1?page=1';
const LIGHTING_AUTO_UPDATE_PATH = '/data/devices/device/32i1/auto_update';
const LIGHTING_CHANGE_PATH = '/action/devices/device/32i1/change';
const LIGHTING_CHECK_PATH = '/data/devices/device/32i1/check';
const AIRCON_AUTO_UPDATE_PATH = '/data/devices/device/321/auto_update';
const AIRCON_CHANGE_PATH = '/action/devices/device/321/change';
const AIRCON_CHECK_PATH = '/action/devices/device/321/check';
const SHUTTER_PAGE_PATH = '/page/devices/device/325?page=2';
const SHUTTER_OPERATION_PATH = '/action/devices/device/325/operation';
const SHUTTER_STATUS_PATH = '/action/devices/device/325/get_operation_status';
const SHUTTER_AUTO_UPDATE_PATH = '/data/devices/device/325/auto_update';
const LOCKUP_PAGE_PATH = '/page/lockup/8';
const LOCKUP_AUTO_UPDATE_PATH = '/data/lockup/8/auto_update';
const LOCKUP_CHANGE_PATH = '/action/lockup/8/change';
const LOCKUP_CHECK_PATH = '/action/lockup/8/check';
const FIRE_ALARM_AUTO_UPDATE_PATH = '/data/devices/device/32h/auto_update';
const AIR_PURIFIER_OPERATION_PATH = '/action/devices/device/327/operation';
const AIR_PURIFIER_STATUS_PATH = '/action/devices/device/327/get_operation_status';

const FORM_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded',
};

export class Aiseg2Client {
  private lockupCache?: CachedValue<LockupStatusResponse>;
  private shutterCache?: CachedValue<ShutterPanelData[]>;
  private smokeCache = new Map<string, CachedValue<FireAlarmPageData>>();

  constructor(
    private readonly host: string,
    private readonly password: string,
  ) {}

  async getDeviceSummaries(): Promise<Aiseg2DeviceSummary[]> {
    const html = await this.requestText(DEVICE_LIST_PATH);
    return this.extractInitArgument<Aiseg2DeviceSummary[]>(html, 4);
  }

  async getLightingDevices(): Promise<LightingDevice[]> {
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

  async getLightingStatus(device: LightingDevice): Promise<LightingStatus> {
    const response = await this.postJson<LightingAutoUpdateResponse>(LIGHTING_AUTO_UPDATE_PATH, {
      page: '1',
      list: [this.lightingRequestDevice(device)],
    });

    const panel = response.panelData && response.panelData[0];
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

  async getAirConditionerStatus(device: AirConditionerDevice): Promise<AirConditionerStatus> {
    const statuses = await this.getAirConditionerPanelData([device]);
    const status = statuses.find(item => item.nodeId === device.nodeId && item.eoj === device.eoj);

    if (!status) {
      throw new Error(`AiSEG2 did not return air conditioner data for '${device.displayName}'`);
    }

    return {
      state: status.state || '0x31',
      mode: status.mode || '0x41',
      active: status.state === '0x30',
      currentTemperature: this.parseTemperature(status.inner),
      targetTemperature: this.parseTemperature(status.temp),
    };
  }

  async getShutterStatus(device: ShutterDevice): Promise<ShutterStatus> {
    const statuses = await this.getShutterPanelData();
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

  async getAirPurifierStatus(device: AirPurifierDevice): Promise<AirPurifierStatus> {
    const page = await this.getAirPurifierPageData(device);
    const mode = page.airclean?.mode || '0x40';

    return {
      state: page.state || '0x31',
      mode,
      active: page.state === '0x30' && mode !== '0x40',
    };
  }

  async getDoorLockStatus(device: DoorLockDevice): Promise<DoorLockStatus> {
    const status = await this.getLockupStatus();
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
      contactDetected: sensor.wSensorVal !== 'wsensor_val open' && sensor.lockVal !== 'lock_val open',
      lowBattery: sensor.batteryUHF === 'U00' || sensor.batteryUHF === 'U01',
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
    return this.getPageToken(LIGHTING_PAGE_PATH);
  }

  async getPageToken(path: string): Promise<string> {
    const html = await this.requestText(path);
    const $ = loadHtml(html);
    const token = $('#main').attr('token') ||
      $('[token]').first().attr('token') ||
      $('.setting_value').first().text().trim();

    if (!token) {
      throw new Error(`AiSEG2 did not return a control token for ${path}`);
    }

    return this.normalizeToken(token);
  }

  async changeLighting(
    device: LightingDevice,
    token: string,
    onoff: string,
    modulate: string,
  ): Promise<LightingChangeResponse> {
    return this.postJson<LightingChangeResponse>(LIGHTING_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      device: {
        onoff,
        modulate,
      },
    });
  }

  async changeAirConditionerPower(
    device: AirConditionerDevice,
    token: string,
    status: AirConditionerStatus,
  ): Promise<OperationResponse> {
    return this.postJson<OperationResponse>(AIRCON_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      state: status.state,
    });
  }

  async changeShutterPosition(device: ShutterDevice, token: string, targetPosition: number): Promise<OperationResponse> {
    const open = targetPosition >= 50 ? '0' : '1';

    return this.postJson<OperationResponse>(SHUTTER_OPERATION_PATH, {
      token,
      objSendData: JSON.stringify({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        device: {
          open,
        },
      }),
    });
  }

  async stopShutter(device: ShutterDevice, token: string): Promise<OperationResponse> {
    return this.postJson<OperationResponse>(SHUTTER_OPERATION_PATH, {
      token,
      objSendData: JSON.stringify({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        device: {
          open: '2',
        },
      }),
    });
  }

  async changeAirPurifierMode(device: AirPurifierDevice, token: string, mode: string): Promise<OperationResponse> {
    return this.postJson<OperationResponse>(AIR_PURIFIER_OPERATION_PATH, {
      token,
      objSendData: JSON.stringify({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        device: {
          mode,
        },
      }),
    });
  }

  async changeDoorLock(device: DoorLockDevice, token: string, status: DoorLockStatus): Promise<OperationResponse> {
    if (!status.statecmd) {
      throw new Error(`AiSEG2 did not return a door lock command for '${device.displayName}'`);
    }

    return this.postJson<OperationResponse>(LOCKUP_CHANGE_PATH, {
      token,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      state: status.statecmd,
    });
  }

  async checkLightingChange(acceptId: number): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(LIGHTING_CHECK_PATH, {
      acceptId: String(acceptId),
      type: '0x92',
    });

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkAirConditionerChange(
    acceptId: number,
    device: AirConditionerDevice,
    token: string,
  ): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(AIRCON_CHECK_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      nodeId: device.nodeId,
      eoj: device.eoj,
      token,
    });

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkShutterChange(acceptId: number, device: ShutterDevice, token: string): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(SHUTTER_STATUS_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      token,
    });

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkAirPurifierChange(acceptId: number, device: AirPurifierDevice, token: string): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(AIR_PURIFIER_STATUS_PATH, {
      acceptId: String(acceptId),
      type: device.type,
      token,
    });

    return this.requireCheckResult(response.result, acceptId);
  }

  async checkDoorLockChange(acceptId: number, device: DoorLockDevice, token: string): Promise<CheckResult> {
    const status = await this.getLockupStatus(true);
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
    });

    return this.requireCheckResult(response.result, acceptId);
  }

  private async getAirConditionerPanelData(devices: AirConditionerDevice[]): Promise<AirConditionerPanelData[]> {
    const response = await this.postJson<AirConditionerAutoUpdateResponse>(AIRCON_AUTO_UPDATE_PATH, {
      page: '1',
      individual_page: '1',
      list: devices.map(device => ({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
      })),
    });

    return response.links || [];
  }

  private async getShutterPanelData(force = false): Promise<ShutterPanelData[]> {
    const now = Date.now();
    if (!force && this.shutterCache && this.shutterCache.expiresAt > now) {
      return this.shutterCache.value;
    }

    const html = await this.requestText(SHUTTER_PAGE_PATH);
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
      });

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

  private async getAirPurifierPageData(device: AirPurifierDevice): Promise<AirPurifierPageData> {
    const html = await this.requestText(
      `/page/devices/device/327?track=32&page=2&nodeid=${device.nodeId}&eoj=${device.eoj}&devtype=${device.type}`,
    );

    return this.extractInitArgument<AirPurifierPageData>(html, 0);
  }

  private async getLockupStatus(force = false): Promise<LockupStatusResponse> {
    const now = Date.now();
    if (!force && this.lockupCache && this.lockupCache.expiresAt > now) {
      return this.lockupCache.value;
    }

    const html = await this.requestText(LOCKUP_PAGE_PATH);
    const pageStatus = this.extractInitArgument<LockupStatusResponse>(html, 0);
    const elValidList = pageStatus.arrayElDevList
      .filter(lock => lock.cacheValid === '0x01')
      .map(lock => ({
        nodeId: lock.nodeId,
        eoj: lock.eoj,
      }));

    const value = await this.postJson<LockupStatusResponse>(LOCKUP_AUTO_UPDATE_PATH, {
      elValidList,
    });

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

  private async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await httpRequest<string>(this.url(path), {
      ...this.baseOptions(),
      ...options,
      dataType: 'text',
    });

    this.assertSuccessfulResponse(path, response.status);
    return response.data;
  }

  private async postJson<T>(path: string, data: unknown): Promise<T> {
    const response = await httpRequest<T>(this.url(path), {
      ...this.baseOptions(),
      method: 'POST',
      headers: FORM_HEADERS,
      data: this.formPayload(data),
      dataType: 'json',
    });

    this.assertSuccessfulResponse(path, response.status);
    return response.data;
  }

  private baseOptions(): RequestOptions {
    return {
      digestAuth: `aiseg:${this.password}`,
      timeout: [5000, 10000],
    };
  }

  private formPayload(data: unknown): string {
    return `data=${JSON.stringify(data)}`;
  }

  private lightingRequestDevice(device: LightingDevice): LightingDevice {
    return {
      ...device,
    };
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
    return name.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  private parseTemperature(value: string | undefined): number | undefined {
    if (!value || value === '-' || value === '自動') {
      return undefined;
    }

    const match = value.replace(/<br\s*\/?>/gi, ' ').match(/(-?\d+(?:\.\d+)?)/);
    if (!match) {
      return undefined;
    }

    return Number(match[1]);
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
}
