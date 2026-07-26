import jwt from "jsonwebtoken";
import { isRevoked } from "./device-registry.js";

// Long-lived tokens (1 year) are intentional here: this is a handful of
// personal devices, not a multi-tenant system - the security boundary is the
// device registry's revoked flag (checked on every request below), not token
// expiry. A refresh-token dance would add complexity with no real benefit
// at this scale.
const TOKEN_LIFETIME = "365d";

export interface DeviceTokenPayload {
  deviceId: string;
}

export function issueToken(deviceId: string, secret: string): string {
  return jwt.sign({ deviceId } satisfies DeviceTokenPayload, secret, { expiresIn: TOKEN_LIFETIME });
}

export type VerifyResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: string };

export function verifyToken(authHeader: string | undefined, secret: string): VerifyResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing or malformed Authorization header" };
  }
  const token = authHeader.slice("Bearer ".length);

  let payload: DeviceTokenPayload;
  try {
    payload = jwt.verify(token, secret) as DeviceTokenPayload;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
  }

  if (!payload.deviceId) {
    return { ok: false, reason: "token missing deviceId" };
  }

  if (isRevoked(payload.deviceId)) {
    return { ok: false, reason: "device revoked" };
  }

  return { ok: true, deviceId: payload.deviceId };
}
