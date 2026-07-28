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

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const [baseUrl, token] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
  if (!baseUrl || !token) throw new ProxyNotConfiguredError();

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    throw new HomeNodeUnreachableError(body?.reason ?? body?.error);
  }

  return res;
}

export interface ConversationSummary {
  id: string;
  name: string;
  created: string;
  updated: string;
}

export interface AssetSummary {
  id: string;
  name: string;
  created: string;
  updated: string;
}

export type AskResult =
  | { status: "answered"; answers: unknown }
  | { status: "unavailable"; reason: string };

/** Unauthenticated liveness check — safe to call before Setup is complete. */
export async function checkProxyHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/mobile/health`);
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

export async function getRecentConversations(): Promise<ConversationSummary[]> {
  const res = await authedFetch("/mobile/recent/conversations");
  if (!res.ok) throw new Error(`Recent conversations failed: HTTP ${res.status}`);
  const body = await res.json();
  const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
  return iterable.map((c: Record<string, any>) => ({
    id: c.id,
    name: c.name,
    created: c.created?.readable ?? c.created?.value ?? "",
    updated: c.updated?.readable ?? c.updated?.value ?? "",
  }));
}

export async function getRecentAssets(): Promise<AssetSummary[]> {
  const res = await authedFetch("/mobile/recent/assets");
  if (!res.ok) throw new Error(`Recent assets failed: HTTP ${res.status}`);
  const body = await res.json();
  const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
  return iterable.map((a: Record<string, any>) => ({
    id: a.id,
    name: a.name,
    created: a.created?.readable ?? a.created?.value ?? "",
    updated: a.updated?.readable ?? a.updated?.value ?? "",
  }));
}

export async function searchAssets(query: string): Promise<AssetSummary[]> {
  const res = await authedFetch(`/mobile/recent/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const body = await res.json();
  const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
  return iterable.map((r: Record<string, any>) => ({
    id: r.asset?.id,
    name: r.asset?.name,
    created: r.asset?.created?.readable ?? r.asset?.created?.value ?? "",
    updated: r.asset?.updated?.readable ?? r.asset?.updated?.value ?? "",
  }));
}

export async function getAsset(id: string): Promise<string> {
  const res = await authedFetch(`/mobile/asset/${id}`);
  if (!res.ok) throw new Error(`Asset fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  
  // Try to extract the raw string from the format (Pieces OS schema)
  try {
    return body.original.reference.fragment.string.raw;
  } catch (err) {
    return JSON.stringify(body, null, 2);
  }
}

export interface ConversationMessage {
  id: string;
  role: string;
  text: string;
  timestamp: string;
}

export async function getConversationMessages(id: string): Promise<ConversationMessage[]> {
  const res = await authedFetch(`/mobile/conversation/${id}/messages`);
  if (!res.ok) throw new Error(`Conversation messages failed: HTTP ${res.status}`);
  const body = await res.json();
  const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
  return iterable.map((m: any) => {
    let text = "";
    if (m.fragment?.string?.raw) {
      text = m.fragment.string.raw;
    }
    return {
      id: m.id,
      role: m.role ?? "UNKNOWN",
      text,
      timestamp: m.created?.readable ?? m.created?.value ?? "",
    };
  });
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
