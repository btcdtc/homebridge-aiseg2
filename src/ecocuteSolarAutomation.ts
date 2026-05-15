import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { request as httpRequest } from 'urllib';

import { EcocuteStatus, EcocuteWaterHeatingMode, EnergyStatus } from './aiseg2Client';
import { EcocuteDevice } from './devices';
import { Aiseg2Platform } from './platform';


interface AutomationState {
  lastStartedAt?: string;
  lastStartedLocalDate?: string;
}

interface WeatherForecast {
  maxShortwaveRadiationWatts?: number;
  averageCloudCover?: number;
  maxPrecipitationProbability?: number;
}

export class EcocuteSolarAutomation {
  private interval?: ReturnType<typeof setInterval>;
  private running = false;
  private state: AutomationState = {};

  constructor(private readonly platform: Aiseg2Platform) {
    this.state = this.loadState();
  }

  start(): void {
    if (this.interval) {
      return;
    }

    const intervalMs = this.platform.ecocuteSolarAutomationNumber('checkIntervalSeconds', 300, 60, 3600) * 1000;
    this.platform.log.info(
      `EcoCute solar automation enabled: ${this.platform.ecocuteSolarAutomationDryRun ? 'dry-run' : 'active'}, ` +
      `interval=${Math.round(intervalMs / 1000)}s`,
    );
    void this.evaluate('startup');
    this.interval = this.platform.registerInterval(() => {
      void this.evaluate('poll');
    }, intervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    this.platform.unregisterInterval(this.interval);
    this.interval = undefined;
  }

  private async evaluate(reason: string): Promise<void> {
    if (this.running) {
      this.platform.log.debug(`EcoCute solar automation skipped ${reason}: evaluation already running`);
      return;
    }

    this.running = true;
    try {
      await this.evaluateOnce(reason);
    } catch (error) {
      this.platform.log.error(`EcoCute solar automation failed: ${this.formatError(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async evaluateOnce(reason: string): Promise<void> {
    const now = new Date();
    const skipReason = this.timeSkipReason(now);
    if (skipReason) {
      this.platform.log.debug(`EcoCute solar automation skipped ${reason}: ${skipReason}`);
      return;
    }

    const energy = await this.platform.client.getEnergyStatus();
    const energySkipReason = this.energySkipReason(energy);
    if (energySkipReason) {
      this.platform.log.info(`EcoCute solar automation skipped ${reason}: ${energySkipReason}`);
      return;
    }

    const weather = await this.weatherForecast();
    const weatherSkipReason = this.weatherSkipReason(weather);
    if (weatherSkipReason) {
      this.platform.log.info(`EcoCute solar automation skipped ${reason}: ${weatherSkipReason}`);
      return;
    }

    const device = await this.resolveEcocuteDevice();
    if (!device) {
      return;
    }

    const status = await this.platform.client.getEcocuteStatus(device);
    if (this.ecocuteAlreadyHeating(status)) {
      this.platform.log.info(`EcoCute solar automation skipped ${reason}: '${device.displayName}' is already heating`);
      return;
    }

    const summary = this.decisionSummary(energy, weather);
    if (this.platform.ecocuteSolarAutomationDryRun) {
      this.platform.log.info(`EcoCute solar automation dry-run would start '${device.displayName}': ${summary}`);
      return;
    }

    this.platform.log.info(`EcoCute solar automation starting '${device.displayName}': ${summary}`);
    const response = await this.platform.client.changeEcocuteWaterHeatingMode(
      device,
      EcocuteWaterHeatingMode.ManualHeating,
    );
    this.platform.log.info(
      `${device.displayName} solar automation manual water heating accepted: ` +
      `transport=${response.transport || 'ECHONET Lite'}${response.endpoint ? ` endpoint=${response.endpoint}` : ''}`,
    );

    this.state = {
      lastStartedAt: now.toISOString(),
      lastStartedLocalDate: this.localDate(now),
    };
    this.saveState();
  }

  private timeSkipReason(now: Date): string | undefined {
    if (!this.platform.ecocuteSolarAutomationWindowOpen(now)) {
      return 'outside allowed time window';
    }

    if (this.platform.ecocuteSolarAutomationBoolean('oncePerDay', true) &&
      this.state.lastStartedLocalDate === this.localDate(now)) {
      return 'already started today';
    }

    const cooldownHours = this.platform.ecocuteSolarAutomationNumber('cooldownHours', 18, 0, 168);
    if (cooldownHours > 0 && this.state.lastStartedAt) {
      const elapsedMs = now.getTime() - new Date(this.state.lastStartedAt).getTime();
      if (elapsedMs >= 0 && elapsedMs < cooldownHours * 60 * 60 * 1000) {
        return `cooldown active (${Math.ceil((cooldownHours * 60 * 60 * 1000 - elapsedMs) / 60000)}m remaining)`;
      }
    }

    return undefined;
  }

  private energySkipReason(energy: EnergyStatus): string | undefined {
    const minSolarWatts = this.platform.ecocuteSolarAutomationNumber('minSolarWatts', 2500, 0, 100000);
    if ((energy.solarGenerationWatts || 0) < minSolarWatts) {
      return `solar generation ${this.formatNumber(energy.solarGenerationWatts, 'W')} below ${minSolarWatts}W`;
    }

    const minBatteryPercent = this.platform.ecocuteSolarAutomationNumber('minBatteryPercent', 80, 0, 100);
    if (energy.batteryPercent === undefined || energy.batteryPercent < minBatteryPercent) {
      return `battery ${this.formatNumber(energy.batteryPercent, '%')} below ${minBatteryPercent}%`;
    }

    if (this.platform.ecocuteSolarAutomationBoolean('requireBatteryNotDischarging', true) &&
      energy.batteryDischarging === true) {
      return `battery is discharging (${this.formatNumber(energy.batteryPowerWatts, 'W')})`;
    }

    const minBatteryChargeWatts = this.platform.ecocuteSolarAutomationNumber('minBatteryChargeWatts', 0, 0, 100000);
    if (minBatteryChargeWatts > 0 && (energy.batteryPowerWatts || 0) < minBatteryChargeWatts) {
      return `battery charge power ${this.formatNumber(energy.batteryPowerWatts, 'W')} below ${minBatteryChargeWatts}W`;
    }

    return undefined;
  }

  private async weatherForecast(): Promise<WeatherForecast | undefined> {
    if (!this.platform.ecocuteSolarAutomationBoolean('weatherEnabled', false)) {
      return undefined;
    }

    const latitude = this.platform.ecocuteSolarAutomationFloat('latitude', Number.NaN, -90, 90);
    const longitude = this.platform.ecocuteSolarAutomationFloat('longitude', Number.NaN, -180, 180);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('weather forecast is enabled but latitude/longitude are not configured');
    }

    const forecastHours = this.platform.ecocuteSolarAutomationNumber('forecastHours', 3, 1, 12);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('hourly', 'shortwave_radiation,cloud_cover,precipitation_probability');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'Asia/Tokyo');
    url.searchParams.set('timeformat', 'unixtime');

    const response = await httpRequest<{
      hourly?: {
        time?: Array<number | string>;
        shortwave_radiation?: number[];
        cloud_cover?: number[];
        precipitation_probability?: number[];
      };
    }>(url.toString(), {
      dataType: 'json',
      timeout: [5000, 10000],
    });

    const hourly = response.data.hourly;
    if (!hourly?.time?.length) {
      throw new Error('weather forecast did not return hourly data');
    }

    const now = Date.now();
    const end = now + forecastHours * 60 * 60 * 1000;
    const indexes = hourly.time
      .map((time, index) => ({ time: this.forecastTimeMs(time), index }))
      .filter(item => item.time >= now - 60 * 60 * 1000 && item.time <= end)
      .map(item => item.index);

    return {
      maxShortwaveRadiationWatts: this.maxAtIndexes(hourly.shortwave_radiation, indexes),
      averageCloudCover: this.averageAtIndexes(hourly.cloud_cover, indexes),
      maxPrecipitationProbability: this.maxAtIndexes(hourly.precipitation_probability, indexes),
    };
  }

  private weatherSkipReason(weather: WeatherForecast | undefined): string | undefined {
    if (!weather) {
      return undefined;
    }

    const minRadiation = this.platform.ecocuteSolarAutomationNumber('minForecastRadiationWatts', 350, 0, 1200);
    if ((weather.maxShortwaveRadiationWatts || 0) < minRadiation) {
      return `forecast radiation ${this.formatNumber(weather.maxShortwaveRadiationWatts, 'W/m2')} below ${minRadiation}W/m2`;
    }

    const maxCloudCover = this.platform.ecocuteSolarAutomationNumber('maxForecastCloudCover', 85, 0, 100);
    if (weather.averageCloudCover !== undefined && weather.averageCloudCover > maxCloudCover) {
      return `forecast cloud cover ${Math.round(weather.averageCloudCover)}% above ${maxCloudCover}%`;
    }

    const maxPrecipitation = this.platform.ecocuteSolarAutomationNumber('maxForecastPrecipitationProbability', 70, 0, 100);
    if (weather.maxPrecipitationProbability !== undefined && weather.maxPrecipitationProbability > maxPrecipitation) {
      return `forecast precipitation ${Math.round(weather.maxPrecipitationProbability)}% above ${maxPrecipitation}%`;
    }

    return undefined;
  }

  private async resolveEcocuteDevice(): Promise<EcocuteDevice | undefined> {
    const devices = await this.platform.client.getEcocuteDevices();
    const configuredName = this.platform.ecocuteSolarAutomationString('ecocuteName', '');
    if (configuredName) {
      const matched = devices.find(device => device.displayName === configuredName);
      if (!matched) {
        this.platform.log.warn(`EcoCute solar automation skipped: no EcoCute named '${configuredName}'`);
      }
      return matched;
    }

    if (devices.length === 1) {
      return devices[0];
    }

    this.platform.log.warn('EcoCute solar automation skipped: configure ecocuteName when multiple EcoCute devices exist');
    return undefined;
  }

  private ecocuteAlreadyHeating(status: EcocuteStatus): boolean {
    return status.waterHeatingMode === EcocuteWaterHeatingMode.ManualHeating &&
      status.waterHeatingStatus !== '0x42';
  }

  private decisionSummary(energy: EnergyStatus, weather: WeatherForecast | undefined): string {
    return [
      `solar=${this.formatNumber(energy.solarGenerationWatts, 'W')}`,
      `battery=${this.formatNumber(energy.batteryPercent, '%')}`,
      `batteryPower=${this.formatNumber(energy.batteryPowerWatts, 'W')}`,
      weather ? `forecastRadiation=${this.formatNumber(weather.maxShortwaveRadiationWatts, 'W/m2')}` : undefined,
      weather?.averageCloudCover !== undefined ? `cloud=${Math.round(weather.averageCloudCover)}%` : undefined,
    ].filter(Boolean).join(', ');
  }

  private maxAtIndexes(values: number[] | undefined, indexes: number[]): number | undefined {
    const selected = indexes.map(index => values?.[index]).filter((value): value is number => Number.isFinite(value));
    return selected.length > 0 ? Math.max(...selected) : undefined;
  }

  private forecastTimeMs(value: number | string): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric * 1000 : new Date(value).getTime();
  }

  private averageAtIndexes(values: number[] | undefined, indexes: number[]): number | undefined {
    const selected = indexes.map(index => values?.[index]).filter((value): value is number => Number.isFinite(value));
    return selected.length > 0 ? selected.reduce((sum, value) => sum + value, 0) / selected.length : undefined;
  }

  private loadState(): AutomationState {
    const statePath = this.statePath();
    if (!existsSync(statePath)) {
      return {};
    }

    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as AutomationState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      this.platform.log.warn(`Failed to read EcoCute solar automation state: ${this.formatError(error)}`);
      return {};
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2));
    } catch (error) {
      this.platform.log.warn(`Failed to persist EcoCute solar automation state: ${this.formatError(error)}`);
    }
  }

  private statePath(): string {
    return join(this.platform.api.user.storagePath(), 'aiseg2-ecocute-solar-automation.json');
  }

  private localDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? 'unknown' : `${Math.round(value * 10) / 10}${unit}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
