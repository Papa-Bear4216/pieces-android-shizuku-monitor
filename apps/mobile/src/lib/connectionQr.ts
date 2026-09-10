// Parses the connection QR payload used by Setup's "Scan to Connect" flow.
// Deliberately a small pure function, not inlined in Setup.tsx — this is the
// one place that has to agree with whatever generates the QR (a companion
// desktop script, another app instance's "share my config" flow, etc.), so
// keeping it isolated makes that contract easy to find and to test.
//
// Payload shape: {"baseUrl": "<http(s) URL>", "token": "<opaque string>"}
// JSON, not a delimited string — avoids the class of bug where two values
// concatenated by a delimiter (e.g. a newline) get parsed back out wrong if
// either value could ever contain that delimiter itself.

export interface ConnectionQrPayload {
  baseUrl: string;
  token: string;
}

export class InvalidConnectionQrError extends Error {
  constructor(reason: string) {
    super(`Invalid connection QR code: ${reason}`);
    this.name = "InvalidConnectionQrError";
  }
}

export function parseConnectionQrPayload(raw: string): ConnectionQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidConnectionQrError("not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidConnectionQrError("expected a JSON object");
  }

  const { baseUrl, token } = parsed as Record<string, unknown>;

  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new InvalidConnectionQrError("missing or empty \"baseUrl\"");
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new InvalidConnectionQrError("missing or empty \"token\"");
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InvalidConnectionQrError(`"baseUrl" is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidConnectionQrError(`"baseUrl" must be http(s), got ${url.protocol}`);
  }

  return { baseUrl: baseUrl.trim().replace(/\/$/, ""), token: token.trim() };
}
