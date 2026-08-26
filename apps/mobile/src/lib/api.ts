import { getProxyBaseUrl, getProxyToken } from "./config";

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
// /mobile/recent/assets proxies to PiecesOS's /assets, which the proxy itself
// allows up to 30s for (a real store scan on a non-trivial asset count is
// legitimately slow — see ASSETS_TIMEOUT_MS in apps/proxy/src/server.ts).
// The client timeout must exceed that, or it aborts requests the server was
// still on track to complete successfully.
const ASSETS_CLIENT_FETCH_TIMEOUT_MS = 35000;
// /mobile/ask falls back to a local Ollama call (grounded in Pieces data)
// when PiecesOS itself can't answer — CPU-bound local generation measured
// 23.8s-63.9s in testing against OLLAMA_TIMEOUT_MS=90000 in
// apps/proxy/src/ollama-fallback.ts. Must exceed that ceiling or the client
// aborts requests the server was still on track to complete.
const ASK_CLIENT_FETCH_TIMEOUT_MS = 100000;
// /mobile/summaries makes one /workstream_summary/{id} call plus up to a few
// parallel /annotation/{id} calls PER summary (see apps/proxy/src/summaries.ts) —
// measured 0.4s for 21 summaries against the local PiecesOS install, but that's
// with an unusually low PIECES_BASE_URL round-trip; give real headroom for a
// slower network path rather than assume the default 10s always covers it.
const SUMMARIES_CLIENT_FETCH_TIMEOUT_MS = 30000;

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const [baseUrl, token] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
  if (!baseUrl || !token) throw new ProxyNotConfiguredError();

  const timeoutMs = path.startsWith("/mobile/recent/assets")
    ? ASSETS_CLIENT_FETCH_TIMEOUT_MS
    : path.startsWith("/mobile/ask")
      ? ASK_CLIENT_FETCH_TIMEOUT_MS
      : path.startsWith("/mobile/summaries")
        ? SUMMARIES_CLIENT_FETCH_TIMEOUT_MS
        : CLIENT_FETCH_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HomeNodeUnreachableError("Request timed out reaching the proxy.");
    }
    throw err;
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    throw new HomeNodeUnreachableError(body?.reason ?? body?.error);
  }

  return res;
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
