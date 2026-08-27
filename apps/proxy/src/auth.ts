import { timingSafeEqual, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Constant-time comparison — avoids leaking token length/prefix via timing. */
export function isValidBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expectedToken);
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
