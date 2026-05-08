import { networkInterfaces } from 'node:os';

import { request as httpRequest } from 'urllib';


export interface Aiseg2DiscoveryResult {
  host: string;
  interfaceName: string;
  subnet: string;
}

interface DiscoverySubnet {
  interfaceName: string;
  address: string;
  subnet: string;
  hosts: string[];
}

const DISCOVERY_PATH = '/page/devices/device/32';
const DISCOVERY_BATCH_SIZE = 32;
const MAX_HOSTS_PER_SUBNET = 254;

export async function discoverAiseg2Controller(password: string): Promise<Aiseg2DiscoveryResult> {
  const subnets = localIpv4Subnets();
  const seenHosts = new Set<string>();

  for (const subnet of subnets) {
    const hosts = subnet.hosts.filter(host => {
      if (seenHosts.has(host)) {
        return false;
      }
      seenHosts.add(host);
      return true;
    });

    for (let index = 0; index < hosts.length; index += DISCOVERY_BATCH_SIZE) {
      const batch = hosts.slice(index, index + DISCOVERY_BATCH_SIZE);
      const results = await Promise.all(batch.map(host => probeAiseg2Host(host, password)));
      const matchIndex = results.findIndex(Boolean);

      if (matchIndex >= 0) {
        return {
          host: batch[matchIndex],
          interfaceName: subnet.interfaceName,
          subnet: subnet.subnet,
        };
      }
    }
  }

  throw new Error('No AiSEG2 controller was found on the current IPv4 subnets');
}

export function localDiscoverySubnets(): string[] {
  return localIpv4Subnets().map(subnet => `${subnet.interfaceName} ${subnet.subnet}`);
}

async function probeAiseg2Host(host: string, password: string): Promise<boolean> {
  try {
    const response = await httpRequest<string>(`http://${host}${DISCOVERY_PATH}`, {
      digestAuth: `aiseg:${password}`,
      timeout: [700, 1500],
      dataType: 'text',
    });

    return response.status >= 200 &&
      response.status < 300 &&
      typeof response.data === 'string' &&
      response.data.includes('window.onload = init(');
  } catch {
    return false;
  }
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
  const addressInt = ipToInt(address);
  let maskInt = ipToInt(netmask);
  let networkInt = (addressInt & maskInt) >>> 0;
  let broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  let hostCount = Math.max(0, broadcastInt - networkInt - 1);

  if (hostCount > MAX_HOSTS_PER_SUBNET) {
    maskInt = ipToInt('255.255.255.0');
    networkInt = (addressInt & maskInt) >>> 0;
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
    address,
    subnet: `${intToIp(networkInt)}/${prefixLength(maskInt)}`,
    hosts,
  };
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

function ipToInt(address: string): number {
  return address
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .reduce((value, octet) => ((value << 8) + octet) >>> 0, 0);
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}
