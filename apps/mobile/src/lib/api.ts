import { getConnectionTargets } from "./config";

export class ProxyNotConfiguredError extends Error {
  constructor() {
    super("Proxy is not configured — complete Setup first.");
    this.name = "ProxyNotConfiguredError";
  }
}

// Both the LAN proxy and the remote gateway return 503 specifically when the
// home node (PC running PiecesOS) is unreachable within their timeout — a
// deliberate fail-closed design, not a generic server error. Surfacing it
// distinctly lets the UI say "PC is offline" instead of a raw error string.
export class HomeNodeUnreachableError extends Error {
  constructor(detail?: string) {
    super(detail ?? "The home PC is offline or unreachable right now.");
    this.name = "HomeNodeUnreachableError";
  }
}

// The proxy/gateway enforce their own 5s upstream timeout and return 503 when
// PiecesOS is unreachable — but that only helps once our request actually
// reaches them. A stalled TCP handshake or dropped packet on the phone's own
// network never gets a response at all, so fetch() hangs indefinitely with
// no client-side abort. This client-side timeout ensures every call fails
// closed instead of leaving the UI stuck on "Checking…" forever.
const CLIENT_FETCH_TIMEOUT_MS = 10000;
const ASSETS_CLIENT_FETCH_TIMEOUT_MS = 35000;
const ASK_CLIENT_FETCH_TIMEOUT_MS = 100000;
const SUMMARIES_CLIENT_FETCH_TIMEOUT_MS = 30000;

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const targets = await getConnectionTargets();
  if (targets.length === 0) throw new ProxyNotConfiguredError();

  const timeoutMs = path.startsWith("/mobile/recent/assets")
    ? ASSETS_CLIENT_FETCH_TIMEOUT_MS
    : path.startsWith("/mobile/ask")
      ? ASK_CLIENT_FETCH_TIMEOUT_MS
      : path.startsWith("/mobile/summaries")
        ? SUMMARIES_CLIENT_FETCH_TIMEOUT_MS
        : CLIENT_FETCH_TIMEOUT_MS;

  let lastError: unknown = null;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    // Probe LAN with a fast 2.5s timeout if a remote fallback exists
    const isProbe = targets.length > 1 && i === 0 && target.mode === "lan" && !path.startsWith("/mobile/ask");
    const currentTimeout = isProbe ? 2500 : timeoutMs;

    try {
      const res = await fetch(`${target.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${target.token}`,
        },
        signal: AbortSignal.timeout(currentTimeout),
      });

      if (res.status === 503) {
        const body = await res.json().catch(() => null);
        throw new HomeNodeUnreachableError(body?.reason ?? body?.error);
      }

      return res;
    } catch (err) {
      lastError = err;
      if (err instanceof HomeNodeUnreachableError && i === targets.length - 1) {
        throw err;
      }
    }
  }

  if (lastError instanceof Error && lastError.name === "TimeoutError") {
    throw new HomeNodeUnreachableError("Request timed out reaching the proxy.");
  }
  if (lastError instanceof Error) throw lastError;
  throw new HomeNodeUnreachableError();
}

export type AskResult =
  | { status: "answered"; answers: unknown }
  | { status: "unavailable"; reason: string; likelyNoModelConfigured?: boolean };

/** Unauthenticated liveness check — safe to call before Setup is complete. */
export async function checkProxyHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/mobile/health`, {
      signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<{ health: string; version: string }> {
  const [healthRes, versionRes] = await Promise.all([
    authedFetch("/mobile/status/health"),
    authedFetch("/mobile/status/version"),
  ]);
  if (!healthRes.ok) throw new Error(`Status health check failed: HTTP ${healthRes.status}`);
  if (!versionRes.ok) throw new Error(`Status version check failed: HTTP ${versionRes.status}`);
  return { health: await healthRes.text(), version: await versionRes.text() };
}

export interface WorkstreamSummary {
  id: string;
  name: string;
  created: string;
  text: string;
}

/**
 * "What got done" — PiecesOS's own AI-generated workstream rollups, not raw
 * captured telemetry. The proxy filters each summary down to its SUMMARY (or
 * DESCRIPTION) annotation only; the broader HIERARCHICAL_PROFILE_SUMMARY
 * annotation every summary also carries never reaches this client.
 */
export async function getWorkstreamSummaries(): Promise<WorkstreamSummary[]> {
  const res = await authedFetch("/mobile/summaries");
  if (!res.ok) throw new Error(`Summaries fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.summaries) ? body.summaries : [];
}

export async function ask(query: string): Promise<AskResult> {
  const res = await authedFetch("/mobile/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Ask failed: HTTP ${res.status}`);
  return res.json();
}
