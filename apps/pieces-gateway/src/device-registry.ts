import { readFileSync, writeFileSync, existsSync } from "node:fs";

// A stateless JWT alone cannot be revoked - the whole point of a device
// registry is to give a per-device revoked flag that every request checks,
// on top of standard signature/expiry validation. Small scale (a handful of
// personal devices), so a flat JSON file is enough - no database needed.

export interface DeviceRecord {
  deviceId: string;
  label: string;
  issuedAt: string;
  revoked: boolean;
}

export interface DeviceRegistry {
  devices: DeviceRecord[];
}

const REGISTRY_PATH = process.env.DEVICE_REGISTRY_PATH ?? "./devices.json";

function load(): DeviceRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return { devices: [] };
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

function save(registry: DeviceRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function addDevice(deviceId: string, label: string): DeviceRecord {
  const registry = load();
  if (registry.devices.some((d) => d.deviceId === deviceId)) {
    throw new Error(`Device ${deviceId} is already enrolled.`);
  }
  const record: DeviceRecord = { deviceId, label, issuedAt: new Date().toISOString(), revoked: false };
  registry.devices.push(record);
  save(registry);
  return record;
}

export function revokeDevice(deviceId: string): void {
  const registry = load();
  const record = registry.devices.find((d) => d.deviceId === deviceId);
  if (!record) throw new Error(`Device ${deviceId} not found.`);
  record.revoked = true;
  save(registry);
}

export function isRevoked(deviceId: string): boolean {
  const registry = load();
  const record = registry.devices.find((d) => d.deviceId === deviceId);
  // A device with no registry record at all is treated as revoked (fail
  // closed) - it should never have gotten a valid JWT in the first place,
  // but if the registry file was ever reset, this is the safe default.
  return !record || record.revoked;
}

export function listDevices(): DeviceRecord[] {
  return load().devices;
}
