import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { request as httpRequest } from 'urllib';

import { EcocuteStatus, EcocuteWaterHeatingMode, EnergyStatus } from './aiseg2Client';
import { EcocuteDevice } from './devices';
import { Aiseg2Platform } from './platform';


interface AutomationState {
  lastAnyStartedAt?: string;
  lastAnyStartedLocalDate?: string;
  lastStartedAt?: string;
  lastStartedLocalDate?: string;
  lastNightFallbackStartedAt?: string;
  lastNightFallbackLocalDate?: string;
}

interface WeatherForecast {
  maxShortwaveRadiationWatts?: number;
  averageCloudCover?: number;
  maxPrecipitationProbability?: number;
  nextSolarWindowStart?: string;
  nextSolarWindowEnd?: string;
  nextSolarMaxShortwaveRadiationWatts?: number;
  nextSolarAverageCloudCover?: number;
  nextSolarMaxPrecipitationProbability?: number;
}

interface StartDecision {
  shouldStart: boolean;
  summary?: string;
  skipReason?: string;
  stateUpdate?: Partial<AutomationState>;
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

    const device = await this.resolveEcocuteDevice();
    if (!device) {
      return;
    }

    const status = await this.platform.client.getEcocuteStatus(device);
    if (this.ecocuteAlreadyHeating(status)) {
      this.platform.log.info(`EcoCute solar automation skipped ${reason}: '${device.displayName}' is already heating`);
      return;
    }

    const nightFallback = await this.nightFallbackDecision(now, status);
    if (nightFallback.shouldStart && nightFallback.summary && nightFallback.stateUpdate) {
      await this.startManualHeating(device, now, nightFallback.summary, nightFallback.stateUpdate);
      return;
    }
    if (nightFallback.skipReason) {
      this.platform.log.debug(`EcoCute night fallback skipped ${reason}: ${nightFallback.skipReason}`);
    }

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

    const summary = this.decisionSummary(energy, weather);
    await this.startManualHeating(device, now, summary, {
      lastAnyStartedAt: now.toISOString(),
      lastAnyStartedLocalDate: this.localDate(now),
      lastStartedAt: now.toISOString(),
      lastStartedLocalDate: this.localDate(now),
    });
  }

  private async startManualHeating(
    device: EcocuteDevice,
    now: Date,
    summary: string,
    stateUpdate: Partial<AutomationState>,
  ): Promise<void> {
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
      ...this.state,
      ...stateUpdate,
      lastAnyStartedAt: stateUpdate.lastAnyStartedAt || now.toISOString(),
      lastAnyStartedLocalDate: stateUpdate.lastAnyStartedLocalDate || this.localDate(now),
    };
    this.saveState();
  }

  private timeSkipReason(now: Date): string | undefined {
    if (!this.platform.ecocuteSolarAutomationWindowOpen(now)) {
      return 'outside allowed time window';
    }

    if (this.platform.ecocuteSolarAutomationBoolean('oncePerDay', true) &&
      (this.state.lastStartedLocalDate === this.localDate(now) ||
        this.state.lastAnyStartedLocalDate === this.localDate(now))) {
      return 'already started today';
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

  private async weatherForecast(nightTarget?: Date): Promise<WeatherForecast | undefined> {
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
    url.searchParams.set('forecast_days', '3');
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
    const nextSolarWindow = this.nextSolarWindowAfterNight(new Date(now), nightTarget);
    const nextSolarIndexes = hourly.time
      .map((time, index) => ({ time: this.forecastTimeMs(time), index }))
      .filter(item => item.time >= nextSolarWindow.start.getTime() && item.time <= nextSolarWindow.end.getTime())
      .map(item => item.index);

    return {
      maxShortwaveRadiationWatts: this.maxAtIndexes(hourly.shortwave_radiation, indexes),
      averageCloudCover: this.averageAtIndexes(hourly.cloud_cover, indexes),
      maxPrecipitationProbability: this.maxAtIndexes(hourly.precipitation_probability, indexes),
      nextSolarWindowStart: this.localDateTime(nextSolarWindow.start),
      nextSolarWindowEnd: this.localDateTime(nextSolarWindow.end),
      nextSolarMaxShortwaveRadiationWatts: this.maxAtIndexes(hourly.shortwave_radiation, nextSolarIndexes),
      nextSolarAverageCloudCover: this.averageAtIndexes(hourly.cloud_cover, nextSolarIndexes),
      nextSolarMaxPrecipitationProbability: this.maxAtIndexes(hourly.precipitation_probability, nextSolarIndexes),
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
    return status.waterHeatingStatus === '0x41';
  }

  private async nightFallbackDecision(now: Date, status: EcocuteStatus): Promise<StartDecision> {
    if (!this.platform.ecocuteSolarAutomationBoolean('nightFallbackEnabled', false)) {
      return { shouldStart: false };
    }

    const timing = this.nightFallbackTiming(now);
    if (!timing.due) {
      return { shouldStart: false, skipReason: timing.skipReason };
    }

    const targetDate = this.localDate(timing.target);
    if (this.state.lastNightFallbackLocalDate === targetDate) {
      return { shouldStart: false, skipReason: `night fallback already started for ${targetDate}` };
    }

    const daytimeDate = this.fallbackDaytimeLocalDate(timing.target);
    const missedDaytime = this.state.lastStartedLocalDate !== daytimeDate;
    const threshold = this.platform.ecocuteSolarAutomationNumber('nightFallbackHotWaterLiters', 350, 0, 5000);
    const lowWater = status.remainingWaterLiters !== undefined && status.remainingWaterLiters < threshold;
    let nextSolarBlockedReason: string | undefined;

    if (!missedDaytime && !lowWater &&
      this.platform.ecocuteSolarAutomationBoolean('nightFallbackWhenNextSolarBlocked', true)) {
      try {
        nextSolarBlockedReason = this.nextSolarBlockedReason(await this.weatherForecast(timing.target));
      } catch (error) {
        return {
          shouldStart: false,
          skipReason: `next solar forecast unavailable: ${this.formatError(error)}`,
        };
      }
    }

    const reasons = [
      missedDaytime ? `no daytime solar heating recorded for ${daytimeDate}` : undefined,
      lowWater ? `${Math.round(status.remainingWaterLiters || 0)}L below ${threshold}L at night fallback` : undefined,
      nextSolarBlockedReason ? `next solar window blocked: ${nextSolarBlockedReason}` : undefined,
    ].filter(Boolean);

    if (reasons.length === 0) {
      return {
        shouldStart: false,
        skipReason: `night fallback not needed for ${targetDate}`,
      };
    }

    return {
      shouldStart: true,
      summary: `nightFallback=${this.localDateTime(timing.target)}, ${reasons.join('; ')}`,
      stateUpdate: {
        lastAnyStartedAt: now.toISOString(),
        lastAnyStartedLocalDate: this.localDate(now),
        lastNightFallbackStartedAt: now.toISOString(),
        lastNightFallbackLocalDate: targetDate,
      },
    };
  }

  private nightFallbackTiming(now: Date): { due: boolean; target: Date; skipReason?: string } {
    const time = this.platform.ecocuteSolarAutomationString('nightFallbackTime', '01:00');
    const target = this.currentOrPreviousLocalTimeDate(now, time);
    const elapsedMs = now.getTime() - target.getTime();
    const windowMs = (this.platform.ecocuteSolarAutomationNumber('checkIntervalSeconds', 300, 60, 3600) + 60) * 1000;
    if (elapsedMs < 0 || elapsedMs > windowMs) {
      return {
        due: false,
        target,
        skipReason: `outside night fallback window ${this.localDateTime(target)} + ${Math.round(windowMs / 60000)}m`,
      };
    }

    return { due: true, target };
  }

  private nextSolarBlockedReason(weather: WeatherForecast | undefined): string | undefined {
    if (!weather) {
      return undefined;
    }

    const reasons = [
      this.nextSolarRadiationSkipReason(weather),
      this.nextSolarCloudSkipReason(weather),
      this.nextSolarPrecipitationSkipReason(weather),
    ].filter(Boolean);

    return reasons.length > 0
      ? `${weather.nextSolarWindowStart || 'next'}-${weather.nextSolarWindowEnd || 'solar'} ${reasons.join('; ')}`
      : undefined;
  }

  private nextSolarRadiationSkipReason(weather: WeatherForecast): string | undefined {
    if (weather.nextSolarMaxShortwaveRadiationWatts === undefined) {
      return undefined;
    }

    const minRadiation = this.platform.ecocuteSolarAutomationNumber('minForecastRadiationWatts', 350, 0, 1200);
    return weather.nextSolarMaxShortwaveRadiationWatts < minRadiation
      ? `radiation ${this.formatNumber(weather.nextSolarMaxShortwaveRadiationWatts, 'W/m2')} below ${minRadiation}W/m2`
      : undefined;
  }

  private nextSolarCloudSkipReason(weather: WeatherForecast): string | undefined {
    if (weather.nextSolarAverageCloudCover === undefined) {
      return undefined;
    }

    const maxCloudCover = this.platform.ecocuteSolarAutomationNumber('maxForecastCloudCover', 85, 0, 100);
    return weather.nextSolarAverageCloudCover > maxCloudCover
      ? `cloud cover ${Math.round(weather.nextSolarAverageCloudCover)}% above ${maxCloudCover}%`
      : undefined;
  }

  private nextSolarPrecipitationSkipReason(weather: WeatherForecast): string | undefined {
    if (weather.nextSolarMaxPrecipitationProbability === undefined) {
      return undefined;
    }

    const maxPrecipitation = this.platform.ecocuteSolarAutomationNumber('maxForecastPrecipitationProbability', 70, 0, 100);
    return weather.nextSolarMaxPrecipitationProbability > maxPrecipitation
      ? `precipitation ${Math.round(weather.nextSolarMaxPrecipitationProbability)}% above ${maxPrecipitation}%`
      : undefined;
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

  private localDateTime(date: Date): string {
    return `${this.localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  private currentOrPreviousLocalTimeDate(now: Date, time: string): Date {
    const minutes = this.parseTimeMinutes(time, 60);
    const target = new Date(now);
    target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (target.getTime() > now.getTime()) {
      target.setDate(target.getDate() - 1);
    }

    return target;
  }

  private nextLocalTimeDate(now: Date, time: string): Date {
    const minutes = this.parseTimeMinutes(time, 60);
    const target = new Date(now);
    target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }

  private nextSolarWindowAfterNight(now: Date, nightTarget?: Date): { start: Date; end: Date } {
    const fallbackTime = this.platform.ecocuteSolarAutomationString('nightFallbackTime', '01:00');
    const night = nightTarget ? new Date(nightTarget) : this.nextLocalTimeDate(now, fallbackTime);
    const startMinutes = this.parseTimeMinutes(this.platform.ecocuteSolarAutomationString('allowedStartTime', '09:30'), 570);
    const endMinutes = this.parseTimeMinutes(this.platform.ecocuteSolarAutomationString('allowedEndTime', '14:30'), startMinutes);
    const start = new Date(night);
    start.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    if (start.getTime() <= night.getTime()) {
      start.setDate(start.getDate() + 1);
    }

    const end = new Date(start);
    end.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
    if (end.getTime() <= start.getTime()) {
      end.setDate(end.getDate() + 1);
    }

    return { start, end };
  }

  private fallbackDaytimeLocalDate(nightTarget: Date): string {
    const startMinutes = this.parseTimeMinutes(this.platform.ecocuteSolarAutomationString('allowedStartTime', '09:30'), 570);
    const daytime = new Date(nightTarget);
    daytime.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    if (daytime.getTime() > nightTarget.getTime()) {
      daytime.setDate(daytime.getDate() - 1);
    }

    return this.localDate(daytime);
  }

  private parseTimeMinutes(value: string, defaultMinutes: number): number {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
    if (!match) {
      return defaultMinutes;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return defaultMinutes;
    }

    return (hour * 60) + minute;
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? 'unknown' : `${Math.round(value * 10) / 10}${unit}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
