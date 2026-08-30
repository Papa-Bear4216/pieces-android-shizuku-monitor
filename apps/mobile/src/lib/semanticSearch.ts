import { embed, embedBatch, embedderAvailable } from "./textEmbedder";
import { readIndex } from "./captureIndex";
import {
  getWorkstreamSummaries,
  HomeNodeUnreachableError,
  ProxyNotConfiguredError,
  type WorkstreamSummary,
} from "./api";

// Thrown when embedderAvailable() said yes but embedding the query then
// failed — a genuine mid-search error the page surfaces with a Retry.
// (An embedder that's simply absent takes the text-fallback path instead
// and never throws.)
export class EmbedderUnavailableError extends Error {
  constructor() {
    super("On-device embedding failed");
    this.name = "EmbedderUnavailableError";
  }
}

export type SearchHit = {
  text: string;
  score: number; // 0..1 — dot product of L2-normalized vectors (== cosine)
  timestamp: string;
  source: "local" | "server";
  app_label?: string; // local hits only
};

export type SearchResult = {
  hits: SearchHit[];
  serverSkipped: boolean; // home node unreachable / proxy not configured
  mode: "relevant" | "text-fallback";
};

export const MIN_SCORE = 0.2;
export const DEFAULT_LIMIT = 20;

// Session cache of server-summary vectors, keyed by summary id. Server
// summaries live authoritatively on the home node and change server-side,
// so their vectors are never persisted to captureIndex — only memoized for
// the lifetime of this module (one app session).
const serverVectorCache = new Map<string, number[]>();

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function summaryText(s: WorkstreamSummary): string {
  return `${s.name}\n${s.text}`;
}

export async function semanticSearch(
  query: string,
  opts?: { limit?: number },
): Promise<SearchResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], serverSkipped: false, mode: "relevant" };

  if (!(await embedderAvailable())) {
    return textFallback(trimmed, limit);
  }

  const queryEmb = await embed(trimmed);
  if (!queryEmb.ok) throw new EmbedderUnavailableError();
  const q = queryEmb.vector;

  const hits: SearchHit[] = [];

  // Local index
  const index = await readIndex();
  for (const entry of index) {
    hits.push({
      text: entry.text,
      score: dot(q, entry.vector),
      timestamp: entry.timestamp,
      source: "local",
      app_label: entry.app_label,
    });
  }

  // Server summaries
  let serverSkipped = false;
  try {
    const summaries = await getWorkstreamSummaries();
    const missing = summaries.filter((s) => !serverVectorCache.has(s.id));
    if (missing.length > 0) {
      const vectors = await embedBatch(missing.map(summaryText));
      missing.forEach((s, i) => {
        const v = vectors[i];
        if (v) serverVectorCache.set(s.id, v);
      });
    }
    for (const s of summaries) {
      const v = serverVectorCache.get(s.id);
      if (!v) continue;
      hits.push({
        text: s.text,
        score: dot(q, v),
        timestamp: s.created,
        source: "server",
      });
    }
  } catch (err) {
    if (err instanceof HomeNodeUnreachableError || err instanceof ProxyNotConfiguredError) {
      serverSkipped = true;
    } else {
      throw err;
    }
  }

  const ranked = hits
    .filter((h) => h.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { hits: ranked, serverSkipped, mode: "relevant" };
}

async function textFallback(query: string, limit: number): Promise<SearchResult> {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];

  const index = await readIndex();
  for (const entry of index) {
    if (entry.text.toLowerCase().includes(needle)) {
      hits.push({
        text: entry.text,
        score: 1,
        timestamp: entry.timestamp,
        source: "local",
        app_label: entry.app_label,
      });
    }
  }

  let serverSkipped = false;
  try {
    const summaries = await getWorkstreamSummaries();
    for (const s of summaries) {
      if (summaryText(s).toLowerCase().includes(needle)) {
        hits.push({ text: s.text, score: 1, timestamp: s.created, source: "server" });
      }
    }
  } catch (err) {
    if (err instanceof HomeNodeUnreachableError || err instanceof ProxyNotConfiguredError) {
      serverSkipped = true;
    } else {
      throw err;
    }
  }

  return {
    hits: hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit),
    serverSkipped,
    mode: "text-fallback",
  };
}
