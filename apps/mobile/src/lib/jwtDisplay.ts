// Decodes a JWT's payload for DISPLAY purposes only — reading exp/iat to show
// "expires in N days" on Setup. This does NOT verify the signature; it's not
// a security check, just base64url-decoding a public part of a token the
// user already possesses. Never use this for auth decisions — the gateway's
// own verifyToken (apps/pieces-gateway/src/jwt.ts) is the real check.
//
// The LAN proxy's bearer token is opaque random bytes, not a JWT — this
// returns null for it (and for anything else that isn't a well-formed JWT),
// so callers should treat "not a JWT" as an ordinary, expected case rather
// than an error.

export interface JwtDisplayInfo {
  expiresAt: Date | null;
  issuedAt: Date | null;
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
  // atob() alone decodes to a binary (Latin-1) string, not UTF-8 - fine for
  // the current payload shape (deviceId/iat/exp are all ASCII), but a JWT
  // payload is UTF-8 JSON in general, so this re-encodes byte-for-byte back
  // to bytes and decodes those as UTF-8 rather than assuming ASCII. Cheap
  // insurance against a future payload field (e.g. a non-ASCII device
  // label) silently mangling instead of just failing loudly.
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function decodeJwtForDisplay(token: string): JwtDisplayInfo | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }

  const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  const iat = typeof payload.iat === "number" ? new Date(payload.iat * 1000) : null;
  return { expiresAt: exp, issuedAt: iat };
}

export function formatExpiry(expiresAt: Date): string {
  const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return `expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`;
  if (daysLeft === 0) return "expires today";
  return `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
}
