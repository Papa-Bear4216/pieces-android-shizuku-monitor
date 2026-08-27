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
  content?: string;
}

export type AskResult =
  | { status: "answered"; answers: unknown }
  | { status: "unavailable"; reason: string; likelyNoModelConfigured?: boolean };

export class PiecesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: PiecesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private fetch(path: string, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
   * POST /qgpt/relevance with options.database:true — semantic (embeddings-based)
   * search over assets, distinct from searchAssets()'s plain text match. Confirmed
   * live on PiecesOS 12.6.0 in docs/ALLOWED_ROUTES.md (was HTTP 500 on 12.5.0).
   * The relevance response only carries asset IDs, so each hit is hydrated via
   * GET /asset/{id} to get name/created/updated for display — same shape as
   * searchAssets() so callers can treat both the same way.
   *
   * Uses a longer timeout than the client default: measured 5.5s for the raw
   * relevance call alone against 108 real assets, already exceeding the 5s
   * default tuned for single-call passthrough routes, before hydration even
   * starts. RELEVANCE_TIMEOUT_MS gives headroom for the search plus the
   * parallel hydration fan-out.
   */
  async relevantAssets(query: string, limit = 25): Promise<AssetSummary[]> {
    const RELEVANCE_TIMEOUT_MS = 15000;
    const res = await this.fetch(
      "/qgpt/relevance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, options: { database: true } }),
      },
      RELEVANCE_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`relevantAssets failed: HTTP ${res.status}`);
    const body = await res.json();
    const iterable = Array.isArray(body?.relevant?.iterable) ? body.relevant.iterable : [];
    const ids: string[] = iterable
      .map((r: Record<string, any>) => r.asset?.id ?? r.id)
      .filter((id: unknown): id is string => typeof id === "string")
      .slice(0, limit);

    const hydrated = await Promise.all(
      ids.map(async (id) => {
        try {
          const assetRes = await this.fetch(`/asset/${id}`, undefined, RELEVANCE_TIMEOUT_MS);
          if (!assetRes.ok) return null;
          const asset = await assetRes.json();
          let content: string | undefined;
          // Extract raw string content from asset formats
          if (asset.formats?.iterable) {
            for (const format of asset.formats.iterable) {
              if (format?.fragment?.string?.raw) {
                content = format.fragment.string.raw;
                break;
              }
            }
          }

          return {
            id: asset.id,
            name: asset.name ?? "(untitled)",
            created: asset.created?.readable ?? asset.created?.value ?? "",
            updated: asset.updated?.readable ?? asset.updated?.value ?? "",
            content,
          };
        } catch {
          return null;
        }
      }),
    );
    // Relevance order matters (it's ranked by match quality) — filter, don't re-sort.
    return hydrated.filter((a): a is AssetSummary => a !== null);
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
    // question:true makes PiecesOS run the LLM generation step inline with
    // the relevance search, not just a vector lookup — same reasoning as
    // relevantAssets()'s RELEVANCE_TIMEOUT_MS (measured 5.5s for search alone
    // against 108 assets); the default 5s here was cutting off the real
    // answer path with a false "did not respond in time" once the database
    // grew past a trivial size.
    const ASK_TIMEOUT_MS = 20000;
    let relevanceRes: Response;
    try {
      relevanceRes = await this.fetch(
        "/qgpt/relevance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, options: { database: true, question: true } }),
        },
        ASK_TIMEOUT_MS,
      );
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
      // A 500 specifically on this endpoint (as opposed to a network error or
      // other status) matches the known no-model-configured failure mode
      // documented in docs/ALLOWED_ROUTES.md — distinct enough from a generic
      // failure that the UI can point the user at the fix instead of just
      // saying "something went wrong."
      return {
        status: "unavailable",
        reason: `PiecesOS Ask endpoint returned HTTP ${relevanceRes.status}.`,
        likelyNoModelConfigured: relevanceRes.status === 500,
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
