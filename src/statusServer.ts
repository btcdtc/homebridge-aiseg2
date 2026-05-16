import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';

import { API, Logger } from 'homebridge';
import { request as httpRequest } from 'urllib';

import { Aiseg2Client, EcocuteStatus } from './aiseg2Client';
import { EcocuteDevice } from './devices';


export interface StatusApiConfig {
  enabled: boolean;
  port: number;
  bind: string;
  publicHost: string;
  token: string;
  ecocuteName: string;
  weatherEnabled: boolean;
  latitude: number;
  longitude: number;
  forecastHours: number;
  automation: StatusAutomationConfig;
}

interface StatusApiSecretFile {
  token?: string;
}

interface AutomationState {
  lastAnyStartedAt?: string;
  lastAnyStartedLocalDate?: string;
  lastStartedAt?: string;
  lastStartedLocalDate?: string;
  lastNightFallbackStartedAt?: string;
  lastNightFallbackLocalDate?: string;
}

interface WeatherForecast {
  currentShortwaveRadiationWatts?: number;
  currentCloudCover?: number;
  currentPrecipitationProbability?: number;
  maxShortwaveRadiationWatts?: number;
  averageCloudCover?: number;
  maxPrecipitationProbability?: number;
  nextSolarWindowStart?: string;
  nextSolarWindowEnd?: string;
  nextSolarMaxShortwaveRadiationWatts?: number;
  nextSolarAverageCloudCover?: number;
  nextSolarMaxPrecipitationProbability?: number;
}

interface StatusWeatherConfig {
  enabled?: boolean;
  latitude?: number;
  longitude?: number;
  forecastHours?: number;
}

interface StatusAutomationConfig {
  enabled: boolean;
  dryRun: boolean;
  allowedStartTime: string;
  allowedEndTime: string;
  minSolarWatts: number;
  minBatteryPercent: number;
  minBatteryChargeWatts: number;
  minForecastRadiationWatts: number;
  maxForecastCloudCover: number;
  maxForecastPrecipitationProbability: number;
  emergencyHotWaterLiters: number;
  nightFallbackTime: string;
  nightFallbackHotWaterLiters: number;
}

const DEFAULT_STATUS_PORT = 18583;
const DEFAULT_STATUS_BIND = '0.0.0.0';
const STATUS_PATH_PREFIX = '/api/aiseg2/status/';
const STATUS_CACHE_MS = 25000;

export class Aiseg2StatusServer {
  private server?: Server;
  private token = '';
  private statusCache?: {
    expiresAt: number;
    value: Record<string, unknown>;
  };

  private statusInflight?: Promise<Record<string, unknown>>;

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly config: StatusApiConfig,
    private readonly getClient: () => Aiseg2Client,
  ) {}

  start(): void {
    if (!this.config.enabled || this.server) {
      return;
    }

    this.token = this.resolveToken();
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on('error', error => {
      this.log.error(`AiSEG2 status API failed: ${this.formatError(error)}`);
    });
    this.server.listen(this.config.port, this.config.bind, () => {
      this.log.info(`AiSEG2 status API listening: GET ${this.statusUrl()}`);
    });
  }

  stop(): void {
    if (!this.server) {
      return;
    }

    this.server.close();
    this.server = undefined;
  }

  static configFrom(value: unknown, weatherFallback: unknown): StatusApiConfig {
    const config = this.objectFrom(value);
    const fallback = this.objectFrom(weatherFallback);
    const fallbackWeather = this.weatherConfigFrom(fallback);
    const ownWeather = this.weatherConfigFrom(config);
    const fallbackAutomation = this.automationConfigFrom(fallback);
    const ownAutomation = this.automationConfigFrom(config);

    return {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : false,
      port: this.numberFrom(config.port, DEFAULT_STATUS_PORT, 1, 65535),
      bind: this.stringFrom(config.bind, DEFAULT_STATUS_BIND),
      publicHost: this.stringFrom(config.publicHost, ''),
      token: this.stringFrom(config.token, ''),
      ecocuteName: this.stringFrom(config.ecocuteName, ''),
      weatherEnabled: ownWeather.enabled ?? fallbackWeather.enabled ?? false,
      latitude: ownWeather.latitude ?? fallbackWeather.latitude ?? Number.NaN,
      longitude: ownWeather.longitude ?? fallbackWeather.longitude ?? Number.NaN,
      forecastHours: ownWeather.forecastHours ?? fallbackWeather.forecastHours ?? 3,
      automation: {
        ...this.defaultAutomationConfig(),
        ...fallbackAutomation,
        ...ownAutomation,
      },
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url || '/', 'http://localhost').pathname;
      if (path !== this.statusPath()) {
        this.writeJson(response, 404, { ok: false, error: 'not found' });
        return;
      }

      if ((request.method || '').toUpperCase() !== 'GET') {
        response.setHeader('Allow', 'GET');
        this.writeJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      this.writeJson(response, 200, await this.cachedStatus());
    } catch (error) {
      this.log.error(`AiSEG2 status API request failed: ${this.formatError(error)}`);
      this.writeJson(response, 500, { ok: false, error: 'internal error' });
    }
  }

  private async handleStatus(): Promise<Record<string, unknown>> {
    const client = this.getClient();
    const [ecocuteResult, energyResult, weatherResult] = await Promise.allSettled([
      this.ecocuteStatus(client),
      this.energyStatus(client),
      this.weatherForecast(),
    ]);
    const ecocutes = ecocuteResult.status === 'fulfilled' ? ecocuteResult.value : [];
    const ecocute = ecocutes[0] || null;
    const energy = energyResult.status === 'fulfilled' ? energyResult.value : {};
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : undefined;
    const plan = this.heatingPlan(ecocute, energy, weather);
    const errors: Record<string, string> = {};

    if (ecocuteResult.status === 'rejected') {
      errors.ecocute = this.formatError(ecocuteResult.reason);
    }
    if (energyResult.status === 'rejected') {
      errors.energy = this.formatError(energyResult.reason);
    }
    if (weatherResult.status === 'rejected') {
      errors.weather = this.formatError(weatherResult.reason);
    }

    return {
      ok: Object.keys(errors).length === 0,
      updatedAt: new Date().toISOString(),
      ecocute,
      ecocutes,
      energy,
      weather,
      plan,
      homepage: this.homepageFields(ecocute, energy, weather, plan),
      errors,
    };
  }

  private async cachedStatus(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.statusCache && this.statusCache.expiresAt > now) {
      return this.statusCache.value;
    }
    if (this.statusInflight) {
      return this.statusInflight;
    }

    this.statusInflight = this.handleStatus()
      .then(value => {
        this.statusCache = {
          value,
          expiresAt: Date.now() + STATUS_CACHE_MS,
        };
        return value;
      })
      .finally(() => {
        this.statusInflight = undefined;
      });

    return this.statusInflight;
  }

  private async ecocuteStatus(client: Aiseg2Client): Promise<Array<Record<string, unknown>>> {
    const devices = await client.getEcocuteDevices();
    const targetName = this.normalizeName(this.config.ecocuteName);
    const selected = targetName
      ? devices.filter(device => this.normalizeName(device.displayName) === targetName)
      : devices;
    if (targetName && selected.length === 0) {
      throw new Error(`No AiSEG2 EcoCute matched status API target '${this.config.ecocuteName}'`);
    }

    const statuses = await Promise.all(selected.map(async device => {
      const status = await client.getEcocuteStatus(device);
      return this.ecocuteSummary(client, device, status);
    }));

    return statuses;
  }

  private ecocuteSummary(
    client: Aiseg2Client,
    device: EcocuteDevice,
    status: EcocuteStatus,
  ): Record<string, unknown> {
    const metadata = client.echonetMetadataForEcocute(device);

    return {
      name: device.displayName,
      nodeId: device.nodeId,
      eoj: device.eoj,
      endpoint: status.endpoint || metadata?.endpoint,
      manufacturer: metadata?.manufacturerName || metadata?.manufacturerCode,
      manufacturerCode: metadata?.manufacturerCode,
      productCode: metadata?.productCode,
      model: metadata?.productCode,
      operationState: status.operationState,
      operationStateLabel: this.operationLabel(status.operationState),
      waterHeatingCommand: status.waterHeatingMode,
      waterHeatingCommandLabel: this.waterHeatingCommandLabel(status.waterHeatingMode),
      waterHeatingStatus: status.waterHeatingStatus,
      waterHeatingStatusLabel: this.waterHeatingStatusLabel(status.waterHeatingStatus),
      tankMode: status.tankMode,
      daytimeReheating: status.daytimeReheating,
      bathAuto: status.bathAuto,
      tankTemperatureCelsius: status.tankTemperature,
      suppliedWaterTemperatureCelsius: status.suppliedWaterTemperature,
      bathWaterTemperatureCelsius: status.bathWaterTemperature,
      remainingHotWaterLiters: status.remainingWaterLiters,
      tankCapacityLiters: status.tankCapacityLiters,
      hotWaterSupplyStatus: status.hotWaterSupplyStatus,
      bathOperationStatus: status.bathOperationStatus,
      bathWaterVolumeLiters: status.bathWaterVolume,
      capabilities: {
        waterHeatingCommandSettable: client.ecocuteCanSet(device, 0xb0),
        manualHeatingStopDaysSettable: client.ecocuteCanSet(device, 0xb4),
        manualHeatingOffTimerSettable: client.ecocuteCanSet(device, 0xb5),
        daytimeReheatingPermissionSettable: client.ecocuteCanSet(device, 0xc0),
        daytimeHeatingShiftTime1Settable: client.ecocuteCanSet(device, 0xca),
      },
    };
  }

  private async energyStatus(client: Aiseg2Client): Promise<Record<string, unknown>> {
    const status = await client.getEnergyStatus();

    return {
      solar: {
        endpoint: status.solarEndpoint,
        operationState: status.solarOperationState,
        operationStateLabel: this.operationLabel(status.solarOperationState),
        generationWatts: status.solarGenerationWatts,
        ratedPowerWatts: status.solarRatedPowerWatts,
        cumulativeGeneratedKwh: this.round(status.solarCumulativeGeneratedKwh, 3),
        cumulativeSoldKwh: this.round(status.solarCumulativeSoldKwh, 3),
      },
      battery: {
        endpoint: status.batteryEndpoint,
        operationState: status.batteryOperationState,
        operationStateLabel: this.operationLabel(status.batteryOperationState),
        workingStatus: status.batteryWorkingStatus,
        workingStatusLabel: this.batteryWorkingStatusLabel(status.batteryWorkingStatus),
        operationMode: status.batteryOperationMode,
        percent: status.batteryPercent,
        powerWatts: status.batteryPowerWatts,
        charging: status.batteryCharging,
        discharging: status.batteryDischarging,
        standby: status.batteryStandby,
        cumulativeChargingKwh: this.round(status.batteryCumulativeChargingKwh, 3),
        cumulativeDischargingKwh: this.round(status.batteryCumulativeDischargingKwh, 3),
      },
      grid: {
        endpoint: status.gridEndpoint,
        source: status.gridSource,
        powerWatts: status.gridPowerWatts,
        cumulativeNormalDirectionKwh: this.round(status.gridCumulativeNormalKwh, 3),
        cumulativeReverseDirectionKwh: this.round(status.gridCumulativeReverseKwh, 3),
      },
      errors: status.errors || {},
    };
  }

  private async weatherForecast(): Promise<Record<string, unknown> | undefined> {
    if (!this.config.weatherEnabled) {
      return undefined;
    }
    if (!Number.isFinite(this.config.latitude) || !Number.isFinite(this.config.longitude)) {
      throw new Error('weather is enabled but latitude/longitude are not configured');
    }

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(this.config.latitude));
    url.searchParams.set('longitude', String(this.config.longitude));
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
    const nowDate = new Date(now);
    const end = now + this.config.forecastHours * 60 * 60 * 1000;
    const indexes = hourly.time
      .map((time, index) => ({ time: this.forecastTimeMs(time), index }))
      .filter(item => item.time >= now - 60 * 60 * 1000 && item.time <= end)
      .map(item => item.index);
    const currentIndex = this.nearestForecastIndex(hourly.time, now);
    const nextSolarWindow = this.nextSolarWindowAfterNight(nowDate);
    const nextSolarIndexes = hourly.time
      .map((time, index) => ({ time: this.forecastTimeMs(time), index }))
      .filter(item => item.time >= nextSolarWindow.start.getTime() && item.time <= nextSolarWindow.end.getTime())
      .map(item => item.index);
    const forecast: WeatherForecast = {
      currentShortwaveRadiationWatts: this.numberAtIndex(hourly.shortwave_radiation, currentIndex),
      currentCloudCover: this.numberAtIndex(hourly.cloud_cover, currentIndex),
      currentPrecipitationProbability: this.numberAtIndex(hourly.precipitation_probability, currentIndex),
      maxShortwaveRadiationWatts: this.maxAtIndexes(hourly.shortwave_radiation, indexes),
      averageCloudCover: this.averageAtIndexes(hourly.cloud_cover, indexes),
      maxPrecipitationProbability: this.maxAtIndexes(hourly.precipitation_probability, indexes),
      nextSolarWindowStart: this.localDateTime(nextSolarWindow.start),
      nextSolarWindowEnd: this.localDateTime(nextSolarWindow.end),
      nextSolarMaxShortwaveRadiationWatts: this.maxAtIndexes(hourly.shortwave_radiation, nextSolarIndexes),
      nextSolarAverageCloudCover: this.averageAtIndexes(hourly.cloud_cover, nextSolarIndexes),
      nextSolarMaxPrecipitationProbability: this.maxAtIndexes(hourly.precipitation_probability, nextSolarIndexes),
    };

    return {
      forecastHours: this.config.forecastHours,
      latitude: this.config.latitude,
      longitude: this.config.longitude,
      currentShortwaveRadiationWatts: this.round(forecast.currentShortwaveRadiationWatts, 1),
      currentCloudCoverPercent: this.round(forecast.currentCloudCover, 1),
      currentPrecipitationProbabilityPercent: this.round(forecast.currentPrecipitationProbability, 1),
      maxShortwaveRadiationWatts: this.round(forecast.maxShortwaveRadiationWatts, 1),
      averageCloudCoverPercent: this.round(forecast.averageCloudCover, 1),
      maxPrecipitationProbabilityPercent: this.round(forecast.maxPrecipitationProbability, 1),
      nextSolarWindowStart: forecast.nextSolarWindowStart,
      nextSolarWindowEnd: forecast.nextSolarWindowEnd,
      nextSolarMaxShortwaveRadiationWatts: this.round(forecast.nextSolarMaxShortwaveRadiationWatts, 1),
      nextSolarAverageCloudCoverPercent: this.round(forecast.nextSolarAverageCloudCover, 1),
      nextSolarMaxPrecipitationProbabilityPercent: this.round(forecast.nextSolarMaxPrecipitationProbability, 1),
    };
  }

  private homepageFields(
    ecocute: Record<string, unknown> | null,
    energy: Record<string, unknown>,
    weather: Record<string, unknown> | undefined,
    plan: Record<string, unknown>,
  ): Record<string, unknown> {
    const solar = this.objectFrom(energy.solar);
    const battery = this.objectFrom(energy.battery);
    const grid = this.objectFrom(energy.grid);
    const solarPlan = this.objectFrom(plan.solar);
    const emergencyPlan = this.objectFrom(plan.emergency);
    const nightPlan = this.objectFrom(plan.nightFallback);
    const currentPlan = this.objectFrom(plan.current);
    const nextSolarPlan = this.objectFrom(plan.nextSolar);

    return {
      ecocuteModel: ecocute?.model,
      hotWaterLiters: ecocute?.remainingHotWaterLiters,
      tankCelsius: ecocute?.tankTemperatureCelsius,
      bathCelsius: ecocute?.bathWaterTemperatureCelsius,
      bathLiters: ecocute?.bathWaterVolumeLiters,
      heating: ecocute?.waterHeatingStatusLabel,
      command: ecocute?.waterHeatingCommandLabel,
      solarWatts: solar.generationWatts,
      batteryPercent: battery.percent,
      batteryWatts: battery.powerWatts,
      gridWatts: grid.powerWatts,
      gridNormalKwh: grid.cumulativeNormalDirectionKwh,
      gridReverseKwh: grid.cumulativeReverseDirectionKwh,
      weatherNowRadiationWatts: weather?.currentShortwaveRadiationWatts,
      weatherNowCloudPercent: weather?.currentCloudCoverPercent,
      weatherNowRainPercent: weather?.currentPrecipitationProbabilityPercent,
      weatherRadiationWatts: weather?.maxShortwaveRadiationWatts,
      cloudPercent: weather?.averageCloudCoverPercent,
      rainPercent: weather?.maxPrecipitationProbabilityPercent,
      forecastHours: weather?.forecastHours,
      nextSolarForecast: nextSolarPlan.label,
      nextSolarReason: nextSolarPlan.reason,
      nextSolarWindow: nextSolarPlan.window,
      nextSolarRadiationWatts: weather?.nextSolarMaxShortwaveRadiationWatts,
      nextSolarCloudPercent: weather?.nextSolarAverageCloudCoverPercent,
      nextSolarRainPercent: weather?.nextSolarMaxPrecipitationProbabilityPercent,
      planNow: currentPlan.label,
      planReason: currentPlan.reason,
      solarPlan: solarPlan.label,
      solarPlanReason: solarPlan.reason,
      solarWindow: solarPlan.window,
      emergencyPlan: emergencyPlan.label,
      emergencyReason: emergencyPlan.reason,
      nightPlan: nightPlan.label,
      nightReason: nightPlan.reason,
      nightTime: nightPlan.time,
      lastSolarHeating: plan.lastStartedAt,
    };
  }

  private heatingPlan(
    ecocute: Record<string, unknown> | null,
    energy: Record<string, unknown>,
    weather: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const now = new Date();
    const state = this.automationState();
    const today = this.localDate(now);
    const alreadyStartedToday = state.lastStartedLocalDate === today || state.lastAnyStartedLocalDate === today;
    const hotWaterLiters = this.numberValue(ecocute?.remainingHotWaterLiters);
    const heating = ecocute?.waterHeatingStatusLabel === 'heating';
    const solar = this.solarHeatingPlan(now, state, energy, weather, heating);
    const emergency = this.emergencyHeatingPlan(hotWaterLiters);
    const nextSolar = this.nextSolarForecastPlan(weather);
    const nightFallback = this.nightFallbackPlan(now, hotWaterLiters, nextSolar);
    const current = this.currentHeatingPlan(emergency, solar, nightFallback);

    return {
      current,
      solar,
      nextSolar,
      emergency,
      nightFallback,
      lastAnyStartedAt: state.lastAnyStartedAt,
      lastAnyStartedLocalDate: state.lastAnyStartedLocalDate,
      lastStartedAt: state.lastStartedAt,
      lastStartedLocalDate: state.lastStartedLocalDate,
      lastNightFallbackStartedAt: state.lastNightFallbackStartedAt,
      lastNightFallbackLocalDate: state.lastNightFallbackLocalDate,
      alreadyStartedToday,
    };
  }

  private solarHeatingPlan(
    now: Date,
    state: AutomationState,
    energy: Record<string, unknown>,
    weather: Record<string, unknown> | undefined,
    heating: boolean,
  ): Record<string, unknown> {
    const config = this.config.automation;
    const solar = this.objectFrom(energy.solar);
    const battery = this.objectFrom(energy.battery);
    const window = `${config.allowedStartTime}-${config.allowedEndTime}`;
    const inWindow = this.timeWindowOpen(now, config.allowedStartTime, config.allowedEndTime);
    const today = this.localDate(now);
    const solarWatts = this.numberValue(solar.generationWatts);
    const batteryPercent = this.numberValue(battery.percent);
    const batteryWatts = this.numberValue(battery.powerWatts);
    const batteryDischarging = battery.discharging === true;
    const nextWindowStart = this.nextLocalTime(now, config.allowedStartTime);
    const base = {
      enabled: config.enabled,
      dryRun: config.dryRun,
      window,
      inWindow,
      nextWindowStart,
      thresholds: {
        minSolarWatts: config.minSolarWatts,
        minBatteryPercent: config.minBatteryPercent,
        minBatteryChargeWatts: config.minBatteryChargeWatts,
        requireBatteryNotDischarging: true,
        minForecastRadiationWatts: config.minForecastRadiationWatts,
        maxForecastCloudCover: config.maxForecastCloudCover,
        maxForecastPrecipitationProbability: config.maxForecastPrecipitationProbability,
      },
    };

    const wait = (label: string, reason: string): Record<string, unknown> => ({
      ...base,
      eligible: false,
      label,
      reason,
    });

    if (!config.enabled) {
      return wait('Solar automation off', 'EcoCute solar automation is disabled');
    }
    if (heating) {
      return wait('Already heating', 'EcoCute is already heating');
    }
    if (state.lastStartedLocalDate === today || state.lastAnyStartedLocalDate === today) {
      return wait('Done today', 'EcoCute automation already started heating today');
    }
    if (!inWindow) {
      return wait('Waiting for solar window', `Next solar window starts ${nextWindowStart}`);
    }
    if (solarWatts === undefined || solarWatts < config.minSolarWatts) {
      return wait('Solar below threshold', `${this.formatNumber(solarWatts, 'W')} < ${config.minSolarWatts}W`);
    }
    if (batteryPercent === undefined || batteryPercent < config.minBatteryPercent) {
      return wait('Battery below threshold', `${this.formatNumber(batteryPercent, '%')} < ${config.minBatteryPercent}%`);
    }
    if (batteryDischarging) {
      return wait('Battery discharging', `battery power ${this.formatNumber(batteryWatts, 'W')}`);
    }
    if (config.minBatteryChargeWatts > 0 && (batteryWatts || 0) < config.minBatteryChargeWatts) {
      return wait('Battery charge below threshold', `${this.formatNumber(batteryWatts, 'W')} < ${config.minBatteryChargeWatts}W`);
    }

    const weatherReason = this.weatherPlanSkipReason(weather);
    if (weatherReason) {
      return wait('Weather not good enough', weatherReason);
    }

    return {
      ...base,
      eligible: true,
      label: config.dryRun ? 'Solar dry-run eligible' : 'Solar start eligible',
      reason: 'Solar, battery, and forecast thresholds are satisfied',
    };
  }

  private emergencyHeatingPlan(hotWaterLiters: number | undefined): Record<string, unknown> {
    const threshold = this.config.automation.emergencyHotWaterLiters;
    const active = hotWaterLiters !== undefined && hotWaterLiters < threshold;

    return {
      thresholdLiters: threshold,
      active,
      label: active ? 'Low hot water warning' : 'Hot water OK',
      reason: hotWaterLiters === undefined
        ? 'hot water level is unknown'
        : active
          ? `${Math.round(hotWaterLiters)}L < ${threshold}L`
          : `${Math.round(hotWaterLiters)}L >= ${threshold}L`,
    };
  }

  private nextSolarForecastPlan(weather: Record<string, unknown> | undefined): Record<string, unknown> {
    const config = this.config.automation;
    const window = weather?.nextSolarWindowStart && weather.nextSolarWindowEnd
      ? `${weather.nextSolarWindowStart} - ${weather.nextSolarWindowEnd}`
      : `${config.allowedStartTime}-${config.allowedEndTime}`;
    const unavailable = (label: string, reason: string): Record<string, unknown> => ({
      blocked: false,
      unknown: true,
      label,
      reason,
      window,
    });

    if (!this.config.weatherEnabled) {
      return unavailable('Next solar unknown', 'weather forecast checks are disabled');
    }
    if (!weather) {
      return unavailable('Next solar unknown', 'weather forecast is unavailable');
    }

    const radiation = this.numberValue(weather.nextSolarMaxShortwaveRadiationWatts);
    const cloud = this.numberValue(weather.nextSolarAverageCloudCoverPercent);
    const rain = this.numberValue(weather.nextSolarMaxPrecipitationProbabilityPercent);
    const reasons = [
      radiation === undefined
        ? 'next solar radiation is unknown'
        : radiation < config.minForecastRadiationWatts
          ? `radiation ${this.formatNumber(radiation, 'W/m2')} < ${config.minForecastRadiationWatts}W/m2`
          : undefined,
      cloud !== undefined && cloud > config.maxForecastCloudCover
        ? `cloud ${Math.round(cloud)}% > ${config.maxForecastCloudCover}%`
        : undefined,
      rain !== undefined && rain > config.maxForecastPrecipitationProbability
        ? `rain ${Math.round(rain)}% > ${config.maxForecastPrecipitationProbability}%`
        : undefined,
    ].filter(Boolean);
    const blocked = reasons.length > 0;

    return {
      blocked,
      unknown: radiation === undefined,
      label: blocked ? 'Tomorrow solar blocked' : 'Tomorrow solar OK',
      reason: blocked
        ? reasons.join('; ')
        : `radiation ${this.formatNumber(radiation, 'W/m2')}, cloud ${this.formatNumber(cloud, '%')}, rain ${this.formatNumber(rain, '%')}`,
      window,
    };
  }

  private nightFallbackPlan(
    now: Date,
    hotWaterLiters: number | undefined,
    nextSolar: Record<string, unknown>,
  ): Record<string, unknown> {
    const config = this.config.automation;
    const targetDate = this.nextLocalTimeDate(now, config.nightFallbackTime);
    const target = this.localDateTime(targetDate);
    const lowWater = hotWaterLiters !== undefined && hotWaterLiters < config.nightFallbackHotWaterLiters;
    const nextSolarBlocked = nextSolar.blocked === true;
    const shouldRun = config.enabled && (lowWater || nextSolarBlocked);
    const reasons = [
      lowWater ? `${Math.round(hotWaterLiters || 0)}L < ${config.nightFallbackHotWaterLiters}L` : undefined,
      nextSolarBlocked ? `tomorrow solar heat is blocked: ${nextSolar.reason}` : undefined,
    ].filter(Boolean);
    const notNeededReason = `${target}: hot water is above ${config.nightFallbackHotWaterLiters}L ` +
      'and tomorrow solar looks usable';

    return {
      time: config.nightFallbackTime,
      target,
      thresholdLiters: config.nightFallbackHotWaterLiters,
      nextSolarBlocked,
      shouldRun,
      label: config.enabled
        ? shouldRun ? 'Night fallback pending' : 'Night fallback not needed'
        : 'Night fallback off',
      reason: shouldRun
        ? `${target}: ${reasons.join('; ')}`
        : config.enabled
          ? notNeededReason
          : 'night fallback automation is disabled',
    };
  }

  private currentHeatingPlan(
    emergency: Record<string, unknown>,
    solar: Record<string, unknown>,
    nightFallback: Record<string, unknown>,
  ): Record<string, unknown> {
    if (emergency.active === true) {
      return {
        label: emergency.label,
        reason: emergency.reason,
      };
    }
    if (solar.eligible === true) {
      return {
        label: solar.label,
        reason: solar.reason,
      };
    }

    return {
      label: nightFallback.shouldRun === true ? nightFallback.label : solar.label,
      reason: nightFallback.shouldRun === true ? nightFallback.reason : solar.reason,
    };
  }

  private weatherPlanSkipReason(weather: Record<string, unknown> | undefined): string | undefined {
    const config = this.config.automation;
    if (!this.config.weatherEnabled) {
      return undefined;
    }
    if (!weather) {
      return 'weather forecast is unavailable';
    }

    const radiation = this.numberValue(weather.maxShortwaveRadiationWatts);
    if (radiation === undefined || radiation < config.minForecastRadiationWatts) {
      return `forecast radiation ${this.formatNumber(radiation, 'W/m2')} < ${config.minForecastRadiationWatts}W/m2`;
    }

    const cloud = this.numberValue(weather.averageCloudCoverPercent);
    if (cloud !== undefined && cloud > config.maxForecastCloudCover) {
      return `forecast cloud ${Math.round(cloud)}% > ${config.maxForecastCloudCover}%`;
    }

    const rain = this.numberValue(weather.maxPrecipitationProbabilityPercent);
    if (rain !== undefined && rain > config.maxForecastPrecipitationProbability) {
      return `forecast rain ${Math.round(rain)}% > ${config.maxForecastPrecipitationProbability}%`;
    }

    return undefined;
  }

  private resolveToken(): string {
    const configuredToken = this.normalizeToken(this.config.token);
    if (configuredToken) {
      return configuredToken;
    }

    const path = this.secretPath();
    try {
      if (existsSync(path)) {
        const file = JSON.parse(readFileSync(path, 'utf8')) as StatusApiSecretFile;
        const token = this.normalizeToken(file.token || '');
        if (token) {
          return token;
        }
      }

      const token = randomBytes(24).toString('base64url');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
      return token;
    } catch (error) {
      this.log.warn(`Failed to persist AiSEG2 status API token: ${this.formatError(error)}`);
      return randomBytes(24).toString('base64url');
    }
  }

  private secretPath(): string {
    return join(this.api.user.storagePath(), 'aiseg2-status-api.json');
  }

  private statusUrl(): string {
    const host = this.config.publicHost || this.localIpv4Address() || '127.0.0.1';
    return `http://${host}:${this.config.port}${this.statusPath()}`;
  }

  private statusPath(): string {
    return `${STATUS_PATH_PREFIX}${this.token}`;
  }

  private localIpv4Address(): string | undefined {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) {
          return address.address;
        }
      }
    }

    return undefined;
  }

  private writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  private normalizeToken(token: string): string {
    return token.trim().replace(/^\/?api\/aiseg2\/status\//u, '');
  }

  private normalizeName(name: string): string {
    return name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  }

  private operationLabel(value: unknown): string | undefined {
    switch (value) {
      case '0x30':
        return 'on';
      case '0x31':
        return 'off';
      default:
        return typeof value === 'string' ? value : undefined;
    }
  }

  private waterHeatingCommandLabel(value: unknown): string | undefined {
    switch (value) {
      case '0x41':
        return 'auto';
      case '0x42':
        return 'manualHeating';
      case '0x43':
        return 'manualStop';
      default:
        return typeof value === 'string' ? value : undefined;
    }
  }

  private waterHeatingStatusLabel(value: unknown): string | undefined {
    switch (value) {
      case '0x41':
        return 'heating';
      case '0x42':
        return 'notHeating';
      default:
        return typeof value === 'string' ? value : undefined;
    }
  }

  private batteryWorkingStatusLabel(value: unknown): string | undefined {
    switch (value) {
      case '0x42':
        return 'charging';
      case '0x43':
        return 'discharging';
      case '0x44':
        return 'standby';
      default:
        return typeof value === 'string' ? value : undefined;
    }
  }

  private forecastTimeMs(value: number | string): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric * 1000 : new Date(value).getTime();
  }

  private nearestForecastIndex(values: Array<number | string> | undefined, targetMs: number): number | undefined {
    if (!values?.length) {
      return undefined;
    }

    let bestIndex: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    values.forEach((value, index) => {
      const distance = Math.abs(this.forecastTimeMs(value) - targetMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private numberAtIndex(values: number[] | undefined, index: number | undefined): number | undefined {
    if (index === undefined) {
      return undefined;
    }

    const value = values?.[index];
    return Number.isFinite(value) ? value : undefined;
  }

  private maxAtIndexes(values: number[] | undefined, indexes: number[]): number | undefined {
    const selected = indexes.map(index => values?.[index]).filter((value): value is number => Number.isFinite(value));
    return selected.length > 0 ? Math.max(...selected) : undefined;
  }

  private averageAtIndexes(values: number[] | undefined, indexes: number[]): number | undefined {
    const selected = indexes.map(index => values?.[index]).filter((value): value is number => Number.isFinite(value));
    return selected.length > 0 ? selected.reduce((sum, value) => sum + value, 0) / selected.length : undefined;
  }

  private round(value: number | undefined, digits: number): number | undefined {
    if (value === undefined || !Number.isFinite(value)) {
      return undefined;
    }

    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  private automationState(): AutomationState {
    const path = join(this.api.user.storagePath(), 'aiseg2-ecocute-solar-automation.json');
    if (!existsSync(path)) {
      return {};
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as AutomationState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      this.log.warn(`Failed to read EcoCute automation state for status API: ${this.formatError(error)}`);
      return {};
    }
  }

  private localDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private nextLocalTime(now: Date, time: string): string {
    return this.localDateTime(this.nextLocalTimeDate(now, time));
  }

  private nextLocalTimeDate(now: Date, time: string): Date {
    const minutes = this.parseTimeMinutes(time, 0);
    const target = new Date(now);
    target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }

  private nextSolarWindowAfterNight(now: Date): { start: Date; end: Date } {
    const config = this.config.automation;
    const night = this.nextLocalTimeDate(now, config.nightFallbackTime);
    const startMinutes = this.parseTimeMinutes(config.allowedStartTime, 0);
    const endMinutes = this.parseTimeMinutes(config.allowedEndTime, startMinutes);
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

  private localDateTime(date: Date): string {
    return `${this.localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  private timeWindowOpen(now: Date, startTime: string, endTime: string): boolean {
    const start = this.parseTimeMinutes(startTime, 0);
    const end = this.parseTimeMinutes(endTime, 0);
    const current = (now.getHours() * 60) + now.getMinutes();
    if (start === end) {
      return true;
    }

    return start < end
      ? current >= start && current <= end
      : current >= start || current <= end;
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

  private numberValue(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private formatNumber(value: number | undefined, unit: string): string {
    return value === undefined ? `unknown${unit}` : `${Math.round(value * 10) / 10}${unit}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static objectFrom(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private objectFrom(value: unknown): Record<string, unknown> {
    return Aiseg2StatusServer.objectFrom(value);
  }

  private static weatherConfigFrom(config: Record<string, unknown>): StatusWeatherConfig {
    return {
      enabled: typeof config.weatherEnabled === 'boolean' ? config.weatherEnabled : undefined,
      latitude: this.optionalNumberFrom(config.latitude, -90, 90),
      longitude: this.optionalNumberFrom(config.longitude, -180, 180),
      forecastHours: this.optionalNumberFrom(config.forecastHours, 1, 12),
    };
  }

  private static defaultAutomationConfig(): StatusAutomationConfig {
    return {
      enabled: false,
      dryRun: true,
      allowedStartTime: '09:30',
      allowedEndTime: '14:30',
      minSolarWatts: 2500,
      minBatteryPercent: 80,
      minBatteryChargeWatts: 0,
      minForecastRadiationWatts: 350,
      maxForecastCloudCover: 85,
      maxForecastPrecipitationProbability: 70,
      emergencyHotWaterLiters: 200,
      nightFallbackTime: '01:00',
      nightFallbackHotWaterLiters: 350,
    };
  }

  private static automationConfigFrom(config: Record<string, unknown>): Partial<StatusAutomationConfig> {
    const output: Partial<StatusAutomationConfig> = {};
    this.assignDefined(output, 'enabled', this.optionalBooleanFrom(config.enabled));
    this.assignDefined(output, 'dryRun', this.optionalBooleanFrom(config.dryRun));
    this.assignDefined(output, 'allowedStartTime', this.optionalTimeStringFrom(config.allowedStartTime));
    this.assignDefined(output, 'allowedEndTime', this.optionalTimeStringFrom(config.allowedEndTime));
    this.assignDefined(output, 'minSolarWatts', this.optionalNumberFrom(config.minSolarWatts, 0, 100000));
    this.assignDefined(output, 'minBatteryPercent', this.optionalNumberFrom(config.minBatteryPercent, 0, 100));
    this.assignDefined(output, 'minBatteryChargeWatts', this.optionalNumberFrom(config.minBatteryChargeWatts, 0, 100000));
    this.assignDefined(output, 'minForecastRadiationWatts', this.optionalNumberFrom(config.minForecastRadiationWatts, 0, 1200));
    this.assignDefined(output, 'maxForecastCloudCover', this.optionalNumberFrom(config.maxForecastCloudCover, 0, 100));
    this.assignDefined(
      output,
      'maxForecastPrecipitationProbability',
      this.optionalNumberFrom(config.maxForecastPrecipitationProbability, 0, 100),
    );
    this.assignDefined(output, 'emergencyHotWaterLiters', this.optionalNumberFrom(config.emergencyHotWaterLiters, 0, 5000));
    this.assignDefined(output, 'nightFallbackTime', this.optionalTimeStringFrom(config.nightFallbackTime));
    this.assignDefined(output, 'nightFallbackHotWaterLiters', this.optionalNumberFrom(config.nightFallbackHotWaterLiters, 0, 5000));
    return output;
  }

  private static numberFrom(value: unknown, defaultValue: number, min: number, max: number): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) {
      return defaultValue;
    }

    return Math.max(min, Math.min(max, Math.trunc(number)));
  }

  private static optionalNumberFrom(value: unknown, min: number, max: number): number | undefined {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) {
      return undefined;
    }

    return Math.max(min, Math.min(max, number));
  }

  private static optionalBooleanFrom(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private static optionalTimeStringFrom(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return /^\d{1,2}:\d{2}$/u.test(trimmed) ? trimmed : undefined;
  }

  private static assignDefined(
    output: Partial<StatusAutomationConfig>,
    key: keyof StatusAutomationConfig,
    value: boolean | number | string | undefined,
  ): void {
    if (value !== undefined) {
      (output as Record<string, unknown>)[key] = value;
    }
  }

  private static stringFrom(value: unknown, defaultValue: string): string {
    return typeof value === 'string' ? value.trim() : defaultValue;
  }
}
