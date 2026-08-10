import { createHash } from "node:crypto";

// Surprisal gate: before seeding a telemetry blob into Mem0/PiecesOS, score
// how novel it is relative to recent captures from the same package. Two
// layers, cheapest first:
//
//  1. Exact/near-duplicate backstop — a hash of normalized text, checked
//     against a short-lived per-package cache. Catches the common case
//     (identical or near-identical screen) for free, no model call needed.
//  2. Semantic similarity via local Ollama embeddings — for text that
//     passes layer 1, embed the candidate and compare (cosine similarity)
//     against embeddings of recent history for that package. High
//     similarity to something already seeded means "more of the same" and
//     gets skipped.
//
//     (True logprob-based perplexity was the original design, but Ollama's
//     stable /api/generate does not expose per-token logprobs — only
//     eval_count/eval_duration timing stats. /api/embeddings is the
//     supported local-model primitive that actually exists today, so this
//     uses embedding similarity as the novelty signal instead.)
//
// Fails open: if Ollama is unreachable or slow, the event is treated as
// novel and seeded anyway. This gate exists to cut noise, not to be a
// second point of data loss — an optional quality filter must never
// silently drop real data when its dependency is down.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_SURPRISAL_MODEL ?? "gemma4";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 3000);

// Cosine similarity above this to any recent same-package embedding is
// treated as a near-duplicate and skipped. Tuned conservatively high —
// false negatives (seeding something that was actually redundant) are
// cheap; false positives (dropping real new content) are not.
const SIMILARITY_SKIP_THRESHOLD = Number(process.env.SURPRISAL_SIMILARITY_THRESHOLD ?? 0.97);

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const HISTORY_PER_PACKAGE = 5;

type HistoryEntry = { hash: string; text: string; at: number; embedding?: number[] };
const recentByPackage = new Map<string, HistoryEntry[]>();

function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("\n");
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function pruneOld(entries: HistoryEntry[], now: number): HistoryEntry[] {
  return entries.filter((e) => now - e.at < DEDUPE_WINDOW_MS);
}

/** Layer 1: cheap exact/near-duplicate check against recent same-package history. */
function isNearDuplicate(packageName: string, normalized: string, hash: string, now: number): boolean {
  const entries = pruneOld(recentByPackage.get(packageName) ?? [], now);
  recentByPackage.set(packageName, entries);
  return entries.some((e) => e.hash === hash);
}

function recordHistory(packageName: string, normalized: string, hash: string, now: number, embedding?: number[]): void {
  const entries = pruneOld(recentByPackage.get(packageName) ?? [], now);
  entries.push({ hash, text: normalized, at: now, embedding });
  while (entries.length > HISTORY_PER_PACKAGE) entries.shift();
  recentByPackage.set(packageName, entries);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Get an embedding vector for `text` from local Ollama. Returns null on any
 * failure (timeout, model missing, malformed response) so the caller can
 * fail open.
 */
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { embedding?: number[] };
    return Array.isArray(data.embedding) && data.embedding.length > 0 ? data.embedding : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if `text` should be seeded (novel enough), false if it
 * should be skipped as redundant. Always updates history for the package
 * when the text is seeded, so subsequent calls compare against it.
 */
export async function shouldSeed(packageName: string, text: string): Promise<boolean> {
  const now = Date.now();
  const normalized = normalize(text);
  const hash = hashOf(normalized);

  if (isNearDuplicate(packageName, normalized, hash, now)) {
    return false;
  }

  const embedding = await embed(normalized);
  // Fail open: no embedding available (Ollama down, model missing, etc.)
  // means "seed it" — never let this gate be a silent data-loss path.
  if (embedding === null) {
    recordHistory(packageName, normalized, hash, now);
    return true;
  }

  const history = pruneOld(recentByPackage.get(packageName) ?? [], now);
  const maxSimilarity = history.reduce((max, e) => {
    if (!e.embedding) return max;
    return Math.max(max, cosineSimilarity(embedding, e.embedding));
  }, 0);

  const novel = maxSimilarity < SIMILARITY_SKIP_THRESHOLD;
  if (novel) {
    recordHistory(packageName, normalized, hash, now, embedding);
  }
  return novel;
}
