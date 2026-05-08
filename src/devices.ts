export enum Aiseg2DeviceType {
  DoorLock = '0x44',
  Ecocute = '0x36',
  AirConditioner = '0x33',
  Lighting = '0x92',
  Shutter = '0x2b',
  AirPurifier = '0x48',
  AirEnvironmentSensor = '0x0c',
  FireAlarm = '0x91',
  OpenCloseSensor = '0x11',
  WindowLockSensor = '0x14',
}

export type SupportedDeviceKind =
  | 'lighting'
  | 'airConditioner'
  | 'shutter'
  | 'airPurifier'
  | 'airEnvironmentSensor'
  | 'doorLock'
  | 'contactSensor'
  | 'smokeSensor';

export interface Aiseg2DeviceSummary {
  nodeId: string;
  eoj: string;
  type: string;
  name: string;
  location: string;
}

export interface Aiseg2Device {
  kind: SupportedDeviceKind;
  displayName: string;
  nodeId: string;
  eoj: string;
  type: string;
  uuidSeed: string;
}

export interface LightingDevice extends Aiseg2Device {
  kind: 'lighting';
  nodeIdentNum: string;
  deviceId: string;
  disable?: string;
  state?: string;
  dimmable?: boolean;
  brightness?: number;
}

export interface AirConditionerDevice extends Aiseg2Device {
  kind: 'airConditioner';
  state?: string;
  mode?: string;
  currentTemperature?: number;
  targetTemperature?: number;
}

export interface ShutterDevice extends Aiseg2Device {
  kind: 'shutter';
  state?: string;
  openState?: string;
  condition?: string;
}

export interface AirPurifierDevice extends Aiseg2Device {
  kind: 'airPurifier';
  state?: string;
  mode?: string;
}

export interface AirEnvironmentSensorDevice extends Aiseg2Device {
  kind: 'airEnvironmentSensor';
  roomName: string;
  roomIndex: number;
  nodeIdentNum: string;
  temperature?: number;
  humidity?: number;
}

export interface DoorLockDevice extends Aiseg2Device {
  kind: 'doorLock';
  lockVal?: string;
  statecmd?: string;
}

export interface ContactSensorDevice extends Aiseg2Device {
  kind: 'contactSensor';
  regNo: number;
  lockVal?: string;
  wSensorVal?: string;
  batteryUHF?: string;
}

export interface SmokeSensorDevice extends Aiseg2Device {
  kind: 'smokeSensor';
  equipIndex: string;
  color?: string;
  time?: string;
  battVisible?: string;
}

export type SupportedDevice =
  | LightingDevice
  | AirConditionerDevice
  | ShutterDevice
  | AirPurifierDevice
  | AirEnvironmentSensorDevice
  | DoorLockDevice
  | ContactSensorDevice
  | SmokeSensorDevice;

export function displayNameFromSummary(summary: Aiseg2DeviceSummary): string {
  return [summary.location, summary.name].filter(Boolean).join(' ') || summary.name;
}

export function uuidSeedFor(device: Pick<Aiseg2Device, 'kind' | 'nodeId' | 'eoj' | 'type'>, suffix = ''): string {
  return ['aiseg2', device.kind, device.type, device.nodeId, device.eoj, suffix].filter(Boolean).join(':');
}
