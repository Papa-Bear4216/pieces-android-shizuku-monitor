import { listDevices } from "./device-registry.js";

const devices = listDevices();
if (devices.length === 0) {
  console.log("No devices enrolled.");
} else {
  for (const d of devices) {
    console.log(`${d.deviceId}  ${d.revoked ? "[REVOKED]" : "[active] "}  ${d.label}  (issued ${d.issuedAt})`);
  }
}
