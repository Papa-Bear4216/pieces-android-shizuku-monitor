// Thin client over PiecesOS — only routes proven live in docs/ALLOWED_ROUTES.md.
// Called by apps/proxy and apps/pieces-gateway. Never used directly by the phone.

const DEFAULT_TIMEOUT_MS = 5000;

export interface PiecesClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:39300
  timeoutMs?: number;
}

export interface HealthResult {
  ok: boolean;
  raw: string;
}

export interface VersionResult {
  version: string;
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

export class PiecesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: PiecesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async health(): Promise<HealthResult> {
    const res = await this.fetch("/.well-known/health");
    const text = await res.text();
    return { ok: res.ok && text.startsWith("ok:"), raw: text };
  }

  async version(): Promise<VersionResult> {
    const res = await this.fetch("/.well-known/version");
    const version = await res.text();
    return { version };
  }

  /** GET /conversations — "Recent" screen source. */
  async listConversations(): Promise<ConversationSummary[]> {
    const res = await this.fetch("/conversations");
    if (!res.ok) throw new Error(`listConversations failed: HTTP ${res.status}`);
    const body = await res.json();
    const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
    return iterable.map((c: Record<string, any>) => ({
      id: c.id,
      name: c.name,
      created: c.created?.readable ?? c.created?.value,
      updated: c.updated?.readable ?? c.updated?.value,
    }));
  }

  /** GET /assets — used by Recent as a secondary feed. */
  async listAssets(): Promise<AssetSummary[]> {
    const res = await this.fetch("/assets");
    if (!res.ok) throw new Error(`listAssets failed: HTTP ${res.status}`);
    const body = await res.json();
    const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
    return iterable.map((a: Record<string, any>) => ({
      id: a.id,
      name: a.name,
      created: a.created?.readable ?? a.created?.value,
      updated: a.updated?.readable ?? a.updated?.value,
    }));
  }

  /** GET /assets/search?query= — confirmed live, real matches. */
  async searchAssets(query: string): Promise<AssetSummary[]> {
    const res = await this.fetch(`/assets/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`searchAssets failed: HTTP ${res.status}`);
    const body = await res.json();
    const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
    return iterable.map((r: Record<string, any>) => ({
      id: r.asset?.id,
      name: r.asset?.name,
      created: r.asset?.created?.readable ?? r.asset?.created?.value,
      updated: r.asset?.updated?.readable ?? r.asset?.updated?.value,
    }));
  }

  /**
   * POST /qgpt/relevance + /qgpt/question — per docs/ALLOWED_ROUTES.md, every
   * answer-generation path (database scope, asset scope, question:true shortcut)
   * returns HTTP 500 on this PiecesOS install, most likely because no LLM
   * model is configured. This method surfaces that as a typed "unavailable"
   * result instead of throwing, so the mobile UI can show a clear message
   * rather than a crash. Re-test this once the model config question is
   * resolved — see ALLOWED_ROUTES.md's "broken/unusable" table.
   */
  async ask(query: string): Promise<AskResult> {
    let relevanceRes: Response;
    try {
      relevanceRes = await this.fetch("/qgpt/relevance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, options: { database: true, question: true } }),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return {
        status: "unavailable",
        reason: isTimeout
          ? "PiecesOS did not respond in time."
          : `PiecesOS is unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!relevanceRes.ok) {
      return {
        status: "unavailable",
        reason: `PiecesOS Ask endpoint returned HTTP ${relevanceRes.status}. Likely no LLM model configured — check Pieces desktop app settings.`,
      };
    }

    const body = await relevanceRes.json();
    if (body?.answers) {
      return { status: "answered", answers: body.answers };
    }
    return {
      status: "unavailable",
      reason: "PiecesOS returned 200 but no answers were included — nothing to show.",
    };
  }
}
