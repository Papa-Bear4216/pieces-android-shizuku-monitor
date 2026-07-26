import { revokeDevice } from "./device-registry.js";

const deviceId = process.argv[2];
if (!deviceId) {
  console.error("Usage: npm run revoke -- <deviceId>");
  console.error("Run 'npm run list-devices' to see enrolled device IDs.");
  process.exit(1);
}

try {
  revokeDevice(deviceId);
  console.log(`Revoked device: ${deviceId}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
