import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';

import { API, Logger } from 'homebridge';

import { Aiseg2Client, DoorLockStatus } from './aiseg2Client';
import { DoorLockDevice } from './devices';


export type WebhookLockAction = 'unlock' | 'toggle';

export interface WebhookServerConfig {
  enabled: boolean;
  port: number;
  bind: string;
  publicHost: string;
  token: string;
  action: WebhookLockAction;
  doorLockName: string;
  cooldownSeconds: number;
}

interface WebhookSecretFile {
  token?: string;
}

const DEFAULT_WEBHOOK_PORT = 18582;
const DEFAULT_WEBHOOK_BIND = '0.0.0.0';
const DEFAULT_WEBHOOK_COOLDOWN_SECONDS = 5;
const WEBHOOK_PATH_PREFIX = '/api/webhook/';

export class Aiseg2WebhookServer {
  private server?: Server;
  private token = '';
  private lastAcceptedAt = 0;

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly config: WebhookServerConfig,
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
      this.log.error(`AiSEG2 webhook server failed: ${this.formatError(error)}`);
    });
    this.server.listen(this.config.port, this.config.bind, () => {
      this.log.info(`AiSEG2 webhook listening: POST ${this.webhookUrl()}`);
      this.log.info(
        `AiSEG2 webhook lock action: ${this.config.action}` +
        (this.config.doorLockName ? `, target=${this.config.doorLockName}` : ', target=auto'),
      );
    });
  }

  stop(): void {
    if (!this.server) {
      return;
    }

    this.server.close();
    this.server = undefined;
  }

  static configFrom(value: unknown): WebhookServerConfig {
    const config = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const action = config.action === 'toggle' ? 'toggle' : 'unlock';

    return {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : false,
      port: this.numberFrom(config.port, DEFAULT_WEBHOOK_PORT, 1, 65535),
      bind: this.stringFrom(config.bind, DEFAULT_WEBHOOK_BIND),
      publicHost: this.stringFrom(config.publicHost, ''),
      token: this.stringFrom(config.token, ''),
      action,
      doorLockName: this.stringFrom(config.doorLockName, ''),
      cooldownSeconds: this.numberFrom(
        config.cooldownSeconds,
        DEFAULT_WEBHOOK_COOLDOWN_SECONDS,
        0,
        3600,
      ),
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url || '/', 'http://localhost').pathname;
      if (path !== this.webhookPath()) {
        this.writeJson(response, 404, { ok: false, error: 'not found' });
        return;
      }

      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        this.writeJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      await this.drainRequest(request);
      const result = await this.handleWebhook();
      this.writeJson(response, result.statusCode, result.body);
    } catch (error) {
      this.log.error(`AiSEG2 webhook request failed: ${this.formatError(error)}`);
      this.writeJson(response, 500, { ok: false, error: 'internal error' });
    }
  }

  private async handleWebhook(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const now = Date.now();
    const cooldownMs = this.config.cooldownSeconds * 1000;
    if (cooldownMs > 0 && now - this.lastAcceptedAt < cooldownMs) {
      this.log.warn('AiSEG2 webhook lock trigger ignored: cooldown active');
      return {
        statusCode: 202,
        body: { ok: true, ignored: true, reason: 'cooldown' },
      };
    }

    const client = this.getClient();
    const device = await this.resolveDoorLock(client);
    const status = await client.getDoorLockStatus(device, true, 'action');
    const desiredSecured = this.desiredSecured(status);

    if (desiredSecured === undefined) {
      this.log.warn(`${device.displayName} webhook lock trigger ignored: current lock state is unknown`);
      return {
        statusCode: 409,
        body: { ok: false, error: 'current lock state is unknown' },
      };
    }

    if (status.secured === desiredSecured) {
      this.lastAcceptedAt = now;
      this.log.info(
        `${device.displayName} webhook lock trigger ignored: already ${this.formatSecured(desiredSecured)}`,
      );
      return {
        statusCode: 200,
        body: { ok: true, ignored: true, state: this.formatSecured(status.secured) },
      };
    }

    this.lastAcceptedAt = now;
    this.log.info(
      `${device.displayName} webhook lock trigger: action=${this.config.action}, ` +
      `current=${this.formatSecured(status.secured)}, target=${this.formatSecured(desiredSecured)}, ` +
      `transport=${status.transport || 'AiSEG2'}${status.endpoint ? ` endpoint=${status.endpoint}` : ''}`,
    );

    try {
      const token = client.echonetEndpointForDoorLock(device)
        ? ''
        : await client.getDoorLockControlToken();
      const response = await client.changeDoorLock(device, token, status);
      this.log.info(
        `${device.displayName} webhook lock request accepted: target=${this.formatSecured(desiredSecured)}, ` +
        `transport=${response.transport || 'AiSEG2'}${response.endpoint ? ` endpoint=${response.endpoint}` : ''}, ` +
        `acceptId=${response.acceptId ?? '-'}` +
        (response.fallbackReason ? `, fallback=${response.fallbackReason}` : ''),
      );

      return {
        statusCode: 202,
        body: { ok: true, target: this.formatSecured(desiredSecured) },
      };
    } catch (error) {
      this.lastAcceptedAt = 0;
      throw error;
    }
  }

  private async resolveDoorLock(client: Aiseg2Client): Promise<DoorLockDevice> {
    const devices = await client.getDoorLockDevices();
    if (this.config.doorLockName) {
      const targetName = this.normalizeName(this.config.doorLockName);
      const device = devices.find(entry => this.normalizeName(entry.displayName) === targetName);
      if (!device) {
        throw new Error(`No AiSEG2 door lock matched webhook target '${this.config.doorLockName}'`);
      }

      return device;
    }

    if (devices.length === 1) {
      return devices[0];
    }

    throw new Error(`AiSEG2 webhook requires doorLockName when ${devices.length} door locks are available`);
  }

  private desiredSecured(status: DoorLockStatus): boolean | undefined {
    if (this.config.action === 'unlock') {
      return false;
    }

    return status.secured === undefined ? undefined : !status.secured;
  }

  private resolveToken(): string {
    const configuredToken = this.normalizeToken(this.config.token);
    if (configuredToken) {
      return configuredToken;
    }

    const path = this.secretPath();
    try {
      if (existsSync(path)) {
        const file = JSON.parse(readFileSync(path, 'utf8')) as WebhookSecretFile;
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
      this.log.warn(`Failed to persist AiSEG2 webhook token: ${this.formatError(error)}`);
      return randomBytes(24).toString('base64url');
    }
  }

  private secretPath(): string {
    return join(this.api.user.storagePath(), 'aiseg2-webhook.json');
  }

  private webhookUrl(): string {
    const host = this.config.publicHost || this.localIpv4Address() || '127.0.0.1';
    return `http://${host}:${this.config.port}${this.webhookPath()}`;
  }

  private webhookPath(): string {
    return `${WEBHOOK_PATH_PREFIX}${this.token}`;
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

  private normalizeToken(token: string): string {
    return token.trim().replace(/^\/?api\/webhook\//u, '');
  }

  private normalizeName(name: string): string {
    return name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  }

  private async drainRequest(request: IncomingMessage): Promise<void> {
    let bytes = 0;

    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) {
        throw new Error('Webhook request body is too large');
      }
    }
  }

  private writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  private formatSecured(secured: boolean | undefined): string {
    if (secured === true) {
      return 'secured';
    }

    if (secured === false) {
      return 'unsecured';
    }

    return 'unknown';
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static numberFrom(value: unknown, defaultValue: number, min: number, max: number): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) {
      return defaultValue;
    }

    return Math.max(min, Math.min(max, Math.trunc(number)));
  }

  private static stringFrom(value: unknown, defaultValue: string): string {
    return typeof value === 'string' ? value.trim() : defaultValue;
  }
}
