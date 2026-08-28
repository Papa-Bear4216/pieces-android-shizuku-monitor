import { randomUUID } from "node:crypto";
import { addDevice } from "./device-registry.js";
import { issueToken } from "./jwt.js";

const JWT_SECRET = process.env.GATEWAY_JWT_SECRET;
if (!JWT_SECRET) {
  console.error("GATEWAY_JWT_SECRET is not set. Refusing to issue a token without it.");
  process.exit(1);
}

const label = process.argv[2];
if (!label) {
  console.error("Usage: npm run enroll -- \"<device label, e.g. My Pixel>\"");
  process.exit(1);
}

const deviceId = randomUUID();
const record = addDevice(deviceId, label);
const token = issueToken(deviceId, JWT_SECRET);

console.log(`Enrolled device: ${record.label} (${record.deviceId})`);
console.log("");
console.log("Token to enter in the phone's Setup screen (remote mode):");
console.log(token);
