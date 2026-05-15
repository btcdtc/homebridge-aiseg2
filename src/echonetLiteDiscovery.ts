import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';


export interface EchonetLiteDiscoveryOptions {
  subnets: string[];
  timeoutMs?: number;
}

export interface EchonetLiteNode {
  host: string;
  objects: EchonetLiteObject[];
}

export interface EchonetLiteObject {
  eoj: string;
  classCode: string;
  className: string;
  shortName: string;
  manufacturerCode?: string;
  manufacturerName?: string;
  productCode?: string;
  operationStatus?: string;
  operationStatusRaw?: string;
  faultStatus?: string;
  configurationUrl?: string;
  setProperties?: string[];
  getProperties?: string[];
  notificationProperties?: string[];
}

interface DiscoverySubnet {
  interfaceName: string;
  subnet: string;
  hosts: string[];
}

interface ParsedMessage {
  tid: number;
  seoj: string;
  deoj: string;
  esv: number;
  properties: EchonetProperty[];
}

interface EchonetProperty {
  epc: number;
  edt: Buffer;
}

interface PendingRequest {
  host: string;
  eoj: string;
}

interface DeviceClassInfo {
  className: string;
  shortName: string;
}

const ECHONET_PORT = 3610;
const ECHONET_MULTICAST_ADDRESS = '224.0.23.0';
const MAX_HOSTS_PER_SUBNET = 254;
const DEFAULT_TIMEOUT_MS = 3000;
const CONTROLLER_EOJ = [0x05, 0xff, 0x01];
const NODE_PROFILE_EOJ_BYTES = [0x0e, 0xf0, 0x01];

// Common AiSEG2-adjacent classes, aligned with ECHONET Appendix / pychonet mraData names.
const DEVICE_CLASSES: Record<string, DeviceClassInfo> = {
  '0x0007': { className: 'Human detection sensor', shortName: 'humanDetectionSensor' },
  '0x000d': { className: 'Illuminance sensor', shortName: 'illuminanceSensor' },
  '0x0011': { className: 'Temperature sensor', shortName: 'temperatureSensor' },
  '0x0012': { className: 'Humidity sensor', shortName: 'humiditySensor' },
  '0x0022': { className: 'Electric energy sensor', shortName: 'electricEnergySensor' },
  '0x0023': { className: 'Current value sensor', shortName: 'currentValueSensor' },
  '0x0029': { className: 'Open/close sensor', shortName: 'openCloseSensor' },
  '0x0130': { className: 'Home air conditioner', shortName: 'homeAirConditioner' },
  '0x0135': { className: 'Air cleaner', shortName: 'airCleaner' },
  '0x0260': { className: 'Electrically operated blind/shade', shortName: 'electricBlindShade' },
  '0x0261': { className: 'Electrically operated shutter', shortName: 'electricShutter' },
  '0x0262': { className: 'Electrically operated curtain', shortName: 'electricCurtain' },
  '0x0263': { className: 'Electrically operated rain sliding door/shutter', shortName: 'electricRainDoor' },
  '0x0264': { className: 'Electrically operated gate', shortName: 'electricGate' },
  '0x0265': { className: 'Electrically operated window', shortName: 'electricWindow' },
  '0x0266': { className: 'Automatically operated entrance door/sliding door', shortName: 'automaticEntranceDoor' },
  '0x026f': { className: 'Electric lock', shortName: 'electricLock' },
  '0x0279': { className: 'Home solar power generation', shortName: 'homeSolarPowerGeneration' },
  '0x027d': { className: 'Storage battery', shortName: 'storageBattery' },
  '0x0280': { className: 'Electric energy meter', shortName: 'electricEnergyMeter' },
  '0x0281': { className: 'Water flow meter', shortName: 'waterFlowMeter' },
  '0x0287': { className: 'Distribution panel metering', shortName: 'distributionPanelMetering' },
  '0x0288': { className: 'Low voltage smart electric energy meter', shortName: 'lowVoltageSmartElectricEnergyMeter' },
  '0x0290': { className: 'General lighting', shortName: 'generalLighting' },
  '0x02a1': { className: 'Single function lighting', shortName: 'singleFunctionLighting' },
  '0x02a3': { className: 'Lighting system', shortName: 'lightingSystem' },
  '0x02a5': { className: 'Multiple input PCS', shortName: 'multipleInputPCS' },
  '0x05fd': { className: 'Switch (supporting JEM-A/HA terminals)', shortName: 'switch' },
  '0x05ff': { className: 'Controller', shortName: 'controller' },
  '0x0ef0': { className: 'Node profile', shortName: 'nodeProfile' },
};

const MANUFACTURERS: Record<string, string> = {
  '00000b': 'Panasonic',
};

const METADATA_EPCS = [
  0x80, // Operation status
  0x82, // Version information
  0x83, // Identification number
  0x88, // Fault status
  0x8a, // Manufacturer code
  0x8c, // Product code
  0x9d, // Status change announcement property map
  0x9e, // Set property map
  0x9f, // Get property map
  0xf0, // HF-JA2 configuration URL
  0xf1, // HF-JA2-specific control/status property
  0xf2, // HF-JA2-specific notification property
];

export async function discoverEchonetLiteNodes(options: EchonetLiteDiscoveryOptions): Promise<EchonetLiteNode[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hosts = hostsFromConfiguredSubnets(options.subnets);
  const nodes = new Map<string, EchonetLiteNode>();
  const pendingRequests = new Map<number, PendingRequest>();
  let nextTid = 0x7000;

  const socket = await bindSocket();

  socket.on('message', (message, remote) => {
    const parsed = parseMessage(message);
    if (!parsed) {
      return;
    }

    collectInstanceList(nodes, remote.address, parsed);

    const pending = pendingRequests.get(parsed.tid);
    if (pending) {
      collectObjectMetadata(nodes, pending, parsed);
      pendingRequests.delete(parsed.tid);
    }
  });

  try {
    socket.setBroadcast(true);
    sendGet(socket, nextTid++, NODE_PROFILE_EOJ_BYTES, [0xd6], ECHONET_MULTICAST_ADDRESS);
    for (const host of hosts) {
      sendGet(socket, nextTid++, NODE_PROFILE_EOJ_BYTES, [0xd6], host);
    }

    await delay(timeoutMs);

    for (const node of nodes.values()) {
      for (const object of node.objects) {
        const tid = nextTid++;
        pendingRequests.set(tid, {
          host: node.host,
          eoj: object.eoj,
        });
        sendGet(socket, tid, eojBytes(object.eoj), METADATA_EPCS, node.host);
      }
    }

    await delay(Math.min(timeoutMs, 2500));
  } finally {
    socket.close();
  }

  return [...nodes.values()]
    .sort((left, right) => compareIp(left.host, right.host))
    .map(node => ({
      ...node,
      objects: node.objects.sort((left, right) => left.eoj.localeCompare(right.eoj)),
    }));
}

export function localEchonetLiteSubnets(): string[] {
  return localIpv4Subnets().map(subnet => `${subnet.interfaceName} ${subnet.subnet}`);
}

export function configuredEchonetLiteTargets(configuredSubnets: string[]): string[] {
  return hostsFromConfiguredSubnets(configuredSubnets);
}

function collectInstanceList(nodes: Map<string, EchonetLiteNode>, host: string, parsed: ParsedMessage): void {
  for (const property of parsed.properties) {
    if (property.epc !== 0xd6 || property.edt.length < 1) {
      continue;
    }

    const count = property.edt[0];
    const node = nodeFor(nodes, host);

    for (let index = 0; index < count; index++) {
      const offset = 1 + (index * 3);
      if (offset + 3 > property.edt.length) {
        break;
      }

      const eoj = formatEoj(property.edt.subarray(offset, offset + 3));
      if (node.objects.some(object => object.eoj === eoj)) {
        continue;
      }

      const classCode = eojClassCode(eoj);
      const classInfo = DEVICE_CLASSES[classCode] || {
        className: 'Unknown ECHONET Lite object',
        shortName: 'unknown',
      };

      node.objects.push({
        eoj,
        classCode,
        className: classInfo.className,
        shortName: classInfo.shortName,
      });
    }
  }
}

function collectObjectMetadata(nodes: Map<string, EchonetLiteNode>, pending: PendingRequest, parsed: ParsedMessage): void {
  const node = nodes.get(pending.host);
  const object = node?.objects.find(entry => entry.eoj === pending.eoj);
  if (!object) {
    return;
  }

  for (const property of parsed.properties) {
    const raw = hex(property.edt);
    switch (property.epc) {
      case 0x80:
        object.operationStatusRaw = raw ? `0x${raw}` : undefined;
        object.operationStatus = operationStatus(raw);
        break;
      case 0x88:
        object.faultStatus = faultStatus(raw);
        break;
      case 0x8a:
        object.manufacturerCode = raw || undefined;
        object.manufacturerName = raw ? MANUFACTURERS[raw] : undefined;
        break;
      case 0x8c:
        object.productCode = decodeAscii(property.edt);
        break;
      case 0x9d:
        object.notificationProperties = decodePropertyMap(property.edt);
        break;
      case 0x9e:
        object.setProperties = decodePropertyMap(property.edt);
        break;
      case 0x9f:
        object.getProperties = decodePropertyMap(property.edt);
        break;
      case 0xf0:
        object.configurationUrl = decodeLengthPrefixedAscii(property.edt);
        break;
      default:
        break;
    }
  }
}

function nodeFor(nodes: Map<string, EchonetLiteNode>, host: string): EchonetLiteNode {
  const existing = nodes.get(host);
  if (existing) {
    return existing;
  }

  const created: EchonetLiteNode = {
    host,
    objects: [],
  };
  nodes.set(host, created);
  return created;
}

function bindSocket(): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let fallbackStarted = false;

    socket.once('listening', () => {
      resolve(socket);
    });
    socket.once('error', error => {
      if (!fallbackStarted && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        fallbackStarted = true;
        socket.removeAllListeners();
        const fallback = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        fallback.once('listening', () => resolve(fallback));
        fallback.once('error', reject);
        fallback.bind(0, '0.0.0.0');
        return;
      }

      reject(error);
    });
    socket.bind(ECHONET_PORT, '0.0.0.0');
  });
}

function sendGet(socket: dgram.Socket, tid: number, deoj: number[], epcs: number[], host: string): void {
  const frame = Buffer.from([
    0x10,
    0x81,
    (tid >> 8) & 0xff,
    tid & 0xff,
    ...CONTROLLER_EOJ,
    ...deoj,
    0x62,
    epcs.length,
    ...epcs.flatMap(epc => [epc, 0x00]),
  ]);

  socket.send(frame, ECHONET_PORT, host);
}

function parseMessage(message: Buffer): ParsedMessage | undefined {
  if (message.length < 12 || message[0] !== 0x10 || message[1] !== 0x81) {
    return undefined;
  }

  const properties: EchonetProperty[] = [];
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

function hostsFromConfiguredSubnets(configuredSubnets: string[]): string[] {
  const configured = configuredSubnets
    .flatMap(entry => entry.split(/[\s,]+/))
    .map(entry => entry.trim())
    .filter(Boolean);

  const subnets = configured.length > 0
    ? configured.map(configuredSubnet)
    : localIpv4Subnets();

  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const subnet of subnets) {
    for (const host of subnet.hosts) {
      if (seen.has(host)) {
        continue;
      }

      seen.add(host);
      hosts.push(host);
    }
  }

  return hosts;
}

function configuredSubnet(value: string): DiscoverySubnet {
  if (!value.includes('/')) {
    return {
      interfaceName: 'configured',
      subnet: `${value}/32`,
      hosts: [value],
    };
  }

  const [networkAddress, prefixValue] = value.split('/');
  const prefix = Number.parseInt(prefixValue, 10);
  if (!Number.isInteger(prefix) || prefix < 24 || prefix > 32) {
    throw new Error(`ECHONET Lite discovery subnet '${value}' must use a /24 to /32 prefix`);
  }

  const networkInt = ipToInt(networkAddress);
  const hostCount = prefix === 32 ? 1 : (2 ** (32 - prefix)) - 2;
  if (hostCount > MAX_HOSTS_PER_SUBNET) {
    throw new Error(`ECHONET Lite discovery subnet '${value}' is too large`);
  }

  const hosts: string[] = [];
  if (prefix === 32) {
    hosts.push(networkAddress);
  } else {
    const maskInt = prefixToMask(prefix);
    const normalizedNetworkInt = (networkInt & maskInt) >>> 0;
    const broadcastInt = (normalizedNetworkInt | (~maskInt >>> 0)) >>> 0;
    for (let hostInt = normalizedNetworkInt + 1; hostInt < broadcastInt; hostInt++) {
      hosts.push(intToIp(hostInt));
    }
  }

  return {
    interfaceName: 'configured',
    subnet: value,
    hosts,
  };
}

function localIpv4Subnets(): DiscoverySubnet[] {
  const subnets: DiscoverySubnet[] = [];

  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses || ignoredInterface(interfaceName)) {
      continue;
    }

    for (const address of addresses) {
      if (address.family !== 'IPv4' ||
        address.internal ||
        !address.address ||
        !address.netmask ||
        !privateIpv4(address.address)) {
        continue;
      }

      const subnet = subnetForAddress(interfaceName, address.address, address.netmask);
      if (subnet.hosts.length > 0) {
        subnets.push(subnet);
      }
    }
  }

  return subnets;
}

function subnetForAddress(interfaceName: string, address: string, netmask: string): DiscoverySubnet {
  let maskInt = ipToInt(netmask);
  let networkInt = (ipToInt(address) & maskInt) >>> 0;
  let broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  let hostCount = Math.max(0, broadcastInt - networkInt - 1);

  if (hostCount > MAX_HOSTS_PER_SUBNET) {
    maskInt = prefixToMask(24);
    networkInt = (ipToInt(address) & maskInt) >>> 0;
    broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
    hostCount = Math.max(0, broadcastInt - networkInt - 1);
  }

  const hosts: string[] = [];
  for (let hostInt = networkInt + 1; hostInt < broadcastInt; hostInt++) {
    const host = intToIp(hostInt);
    if (host !== address) {
      hosts.push(host);
    }
  }

  return {
    interfaceName,
    subnet: `${intToIp(networkInt)}/${prefixLength(maskInt)}`,
    hosts,
  };
}

function eojBytes(eoj: string): number[] {
  const normalized = eoj.replace(/^0x/u, '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function formatEoj(value: Buffer): string {
  return `0x${hex(value)}`;
}

function eojClassCode(eoj: string): string {
  return `0x${eoj.replace(/^0x/u, '').slice(0, 4).toLowerCase()}`;
}

function decodePropertyMap(value: Buffer): string[] | undefined {
  if (value.length === 0) {
    return undefined;
  }

  if (value[0] < 16) {
    return [...value.subarray(1, 1 + value[0])]
      .map(epc => `0x${epc.toString(16).padStart(2, '0')}`);
  }

  const properties: string[] = [];
  for (let byteIndex = 0; byteIndex < Math.min(value.length, 16); byteIndex++) {
    for (let bit = 0; bit < 8; bit++) {
      if ((value[byteIndex] & (1 << bit)) !== 0) {
        properties.push(`0x${((bit << 4) + byteIndex + 0x80).toString(16)}`);
      }
    }
  }

  return properties;
}

function decodeAscii(value: Buffer): string | undefined {
  const decoded = value.toString('ascii').replace(/\0+$/u, '').trim();
  return decoded || undefined;
}

function decodeLengthPrefixedAscii(value: Buffer): string | undefined {
  if (value.length === 0) {
    return undefined;
  }

  const declaredLength = value[0];
  return decodeAscii(value.subarray(1, Math.min(value.length, 1 + declaredLength)));
}

function operationStatus(raw: string): string | undefined {
  if (raw === '30') {
    return 'on';
  }

  if (raw === '31') {
    return 'off';
  }

  return raw ? `0x${raw}` : undefined;
}

function faultStatus(raw: string): string | undefined {
  if (raw === '41') {
    return 'fault';
  }

  if (raw === '42') {
    return 'normal';
  }

  return raw ? `0x${raw}` : undefined;
}

function ignoredInterface(interfaceName: string): boolean {
  return interfaceName === 'lo' ||
    interfaceName.startsWith('docker') ||
    interfaceName.startsWith('br-') ||
    interfaceName.startsWith('veth');
}

function privateIpv4(address: string): boolean {
  const [first, second] = address.split('.').map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function prefixLength(maskInt: number): number {
  let bits = 0;
  for (let bit = 31; bit >= 0; bit--) {
    if ((maskInt & (1 << bit)) !== 0) {
      bits++;
    }
  }

  return bits;
}

function prefixToMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function ipToInt(address: string): number {
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address '${address}'`);
  }

  return parts.reduce((value, octet) => ((value << 8) + octet) >>> 0, 0);
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function compareIp(left: string, right: string): number {
  return ipToInt(left) - ipToInt(right);
}

function hex(value: Buffer): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
