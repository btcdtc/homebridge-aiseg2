import { request as httpRequest, RequestOptions } from 'urllib';
import { load as loadHtml } from 'cheerio';

import type { LightingDevice } from './lightingAccessory';


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

export interface LightingChangeResponse {
  acceptId?: number | string;
}

interface LightingPanelData {
  state?: string;
  modulate_hidden?: string;
  modulate_level?: number | string;
}

interface LightingAutoUpdateResponse {
  panelData?: LightingPanelData[];
}

const LIGHTING_PAGE_PATH = '/page/devices/device/32i1?page=1';
const LIGHTING_AUTO_UPDATE_PATH = '/data/devices/device/32i1/auto_update';
const LIGHTING_CHANGE_PATH = '/action/devices/device/32i1/change';
const LIGHTING_CHECK_PATH = '/data/devices/device/32i1/check';

const FORM_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded',
};

export class Aiseg2Client {
  constructor(
    private readonly host: string,
    private readonly password: string,
  ) {}

  async getLightingDevices(): Promise<LightingDevice[]> {
    const html = await this.requestText(LIGHTING_PAGE_PATH);
    const $ = loadHtml(html);
    const devices: LightingDevice[] = [];

    $('.panel').each((index, element) => {
      const device: LightingDevice = {
        displayName: $($(element).find('.lighting_title')[0]).text().trim(),
        nodeId: $(element).attr('nodeid') || '',
        eoj: $(element).attr('eoj') || '',
        type: $(element).attr('type') || '',
        nodeIdentNum: $(element).attr('nodeidentnum') || '',
        deviceId: $(element).attr('deviceid') || '',
      };

      if (device.deviceId) {
        devices.push(device);
      }
    });

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

  async getControlToken(): Promise<string> {
    const html = await this.requestText(LIGHTING_PAGE_PATH);
    const $ = loadHtml(html);
    const token = $('#main').attr('token') || '';

    if (!token) {
      throw new Error('AiSEG2 did not return a control token');
    }

    return token;
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

  async checkLightingChange(acceptId: number): Promise<CheckResult> {
    const response = await this.postJson<{ result?: CheckResult }>(LIGHTING_CHECK_PATH, {
      acceptId: String(acceptId),
      type: '0x92',
    });

    if (!response.result) {
      throw new Error(`AiSEG2 did not return status for request ${acceptId}`);
    }

    return response.result;
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
      displayName: device.displayName,
      nodeId: device.nodeId,
      eoj: device.eoj,
      type: device.type,
      nodeIdentNum: device.nodeIdentNum,
      deviceId: device.deviceId,
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
}
