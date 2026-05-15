import dgram from 'node:dgram';


export interface EchonetLiteEndpoint {
  host: string;
  eoj: string;
}

export interface EchonetLiteProperty {
  epc: number;
  edt: Buffer;
}

interface ParsedMessage {
  tid: number;
  seoj: string;
  deoj: string;
  esv: number;
  properties: EchonetLiteProperty[];
}

const ECHONET_PORT = 3610;
const CONTROLLER_EOJ = [0x05, 0xff, 0x01];
const GET_ESV = 0x62;
const SETC_ESV = 0x61;
const GET_RESPONSE_ESV = 0x72;
const GET_SNA_ESV = 0x52;
const SET_RESPONSE_ESV = 0x71;
const SET_SNA_ESV = 0x51;
const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_RETRIES = 1;

export class EchonetLiteClient {
  private nextTid = 0x7400;
  private requestChain: Promise<unknown> = Promise.resolve();

  async getProperties(
    endpoint: EchonetLiteEndpoint,
    epcs: number[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Map<number, Buffer>> {
    const response = await this.request(endpoint, GET_ESV, epcs.map(epc => ({ epc, edt: Buffer.alloc(0) })), timeoutMs);
    if (response.esv === GET_SNA_ESV) {
      if (epcs.length > 1) {
        const individualValues = await this.getPropertiesIndividually(endpoint, epcs, timeoutMs);
        if (individualValues.size > 0) {
          return individualValues;
        }
      }

      throw new Error(`ECHONET Lite ${formatEndpoint(endpoint)} rejected get request`);
    }

    if (response.esv !== GET_RESPONSE_ESV) {
      throw new Error(`ECHONET Lite get returned unexpected ESV 0x${response.esv.toString(16)}`);
    }

    const values = new Map<number, Buffer>();
    for (const property of response.properties) {
      if (property.edt.length > 0) {
        values.set(property.epc, property.edt);
      }
    }

    return values;
  }

  private async getPropertiesIndividually(
    endpoint: EchonetLiteEndpoint,
    epcs: number[],
    timeoutMs: number,
  ): Promise<Map<number, Buffer>> {
    const values = new Map<number, Buffer>();

    for (const epc of epcs) {
      try {
        const value = await this.getProperty(endpoint, epc, timeoutMs);
        values.set(epc, value);
      } catch {
        // Some devices reject selected properties or multi-property GETs; keep usable values.
      }
    }

    return values;
  }

  async getProperty(endpoint: EchonetLiteEndpoint, epc: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
    const values = await this.getProperties(endpoint, [epc], timeoutMs);
    const value = values.get(epc);
    if (!value) {
      throw new Error(`ECHONET Lite ${formatEndpoint(endpoint)} did not return EPC ${formatEpc(epc)}`);
    }

    return value;
  }

  async setProperties(
    endpoint: EchonetLiteEndpoint,
    properties: EchonetLiteProperty[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    const response = await this.request(endpoint, SETC_ESV, properties, timeoutMs);
    if (response.esv === SET_RESPONSE_ESV) {
      return;
    }

    if (response.esv === SET_SNA_ESV) {
      throw new Error(`ECHONET Lite ${formatEndpoint(endpoint)} rejected set request`);
    }

    throw new Error(`ECHONET Lite set returned unexpected ESV 0x${response.esv.toString(16)}`);
  }

  async setProperty(endpoint: EchonetLiteEndpoint, epc: number, edt: Buffer, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await this.setProperties(endpoint, [{ epc, edt }], timeoutMs);
  }

  private async request(
    endpoint: EchonetLiteEndpoint,
    esv: number,
    properties: EchonetLiteProperty[],
    timeoutMs: number,
  ): Promise<ParsedMessage> {
    return this.enqueueRequest(() => this.performRequest(endpoint, esv, properties, timeoutMs));
  }

  private async performRequest(
    endpoint: EchonetLiteEndpoint,
    esv: number,
    properties: EchonetLiteProperty[],
    timeoutMs: number,
  ): Promise<ParsedMessage> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
      try {
        return await this.tryRequest(endpoint, esv, properties, timeoutMs);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private enqueueRequest<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.requestChain.then(operation, operation);
    this.requestChain = queued.catch(() => undefined);
    return queued;
  }

  private tryRequest(
    endpoint: EchonetLiteEndpoint,
    esv: number,
    properties: EchonetLiteProperty[],
    timeoutMs: number,
  ): Promise<ParsedMessage> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const tid = this.nextTransactionId();
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`ECHONET Lite ${formatEndpoint(endpoint)} timed out`));
      }, timeoutMs);

      socket.on('message', message => {
        const parsed = parseMessage(message);
        if (!parsed || parsed.tid !== tid || parsed.seoj !== normalizeEoj(endpoint.eoj)) {
          return;
        }

        clearTimeout(timer);
        socket.close();
        resolve(parsed);
      });

      bindSocket(socket, () => {
        socket.send(frame(tid, endpoint, esv, properties), ECHONET_PORT, endpoint.host);
      }, error => {
        clearTimeout(timer);
        socket.close();
        reject(error);
      });
    });
  }

  private nextTransactionId(): number {
    const tid = this.nextTid;
    this.nextTid = this.nextTid >= 0xffff ? 0x7400 : this.nextTid + 1;
    return tid;
  }
}

function bindSocket(socket: dgram.Socket, onListening: () => void, reject: (reason?: unknown) => void): void {
  socket.once('listening', onListening);
  socket.once('error', error => {
    reject(error);
  });
  socket.bind(ECHONET_PORT, '0.0.0.0');
}

export function formatEndpoint(endpoint: EchonetLiteEndpoint): string {
  return `${endpoint.host}/${normalizeEoj(endpoint.eoj)}`;
}

export function normalizeEoj(eoj: string): string {
  return `0x${eoj.replace(/^0x/u, '').toLowerCase().padStart(6, '0')}`;
}

export function bufferFromHexByte(value: string | number): Buffer {
  const byte = typeof value === 'number' ? value : Number.parseInt(value.replace(/^0x/u, ''), 16);
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new Error(`Invalid ECHONET Lite byte '${value}'`);
  }

  return Buffer.from([byte]);
}

function frame(tid: number, endpoint: EchonetLiteEndpoint, esv: number, properties: EchonetLiteProperty[]): Buffer {
  return Buffer.from([
    0x10,
    0x81,
    (tid >> 8) & 0xff,
    tid & 0xff,
    ...CONTROLLER_EOJ,
    ...eojBytes(endpoint.eoj),
    esv,
    properties.length,
    ...properties.flatMap(property => [property.epc, property.edt.length, ...property.edt]),
  ]);
}

function parseMessage(message: Buffer): ParsedMessage | undefined {
  if (message.length < 12 || message[0] !== 0x10 || message[1] !== 0x81) {
    return undefined;
  }

  const properties: EchonetLiteProperty[] = [];
  let offset = 12;
  const opc = message[11];
  for (let index = 0; index < opc && offset + 2 <= message.length; index++) {
    const epc = message[offset++];
    const pdc = message[offset++];
    const edt = message.subarray(offset, offset + pdc);
    offset += pdc;
    properties.push({ epc, edt });
  }

  return {
    tid: (message[2] << 8) | message[3],
    seoj: formatEoj(message.subarray(4, 7)),
    deoj: formatEoj(message.subarray(7, 10)),
    esv: message[10],
    properties,
  };
}

function eojBytes(eoj: string): number[] {
  const normalized = normalizeEoj(eoj).replace(/^0x/u, '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function formatEoj(value: Buffer): string {
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function formatEpc(epc: number): string {
  return `0x${epc.toString(16).padStart(2, '0')}`;
}
