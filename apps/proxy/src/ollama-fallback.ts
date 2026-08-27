import { PiecesClient } from "@pieces-android/pieces-api";

// Used only when PiecesClient.ask() reports "unavailable" (currently always,
// per docs/ALLOWED_ROUTES.md's "Ask root cause" section — the account's cloud
// allocation is broken, not this repo). Grounds a local Ollama model in the
// user's real Pieces data instead of answering from the model's own general
// knowledge, which is the thing we explicitly rejected in Gemini's patch.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:latest";
// Generation time varies widely run-to-run on this machine — two similarly
// sized (~3.5KB) real prompts measured 23.8s and >45s (timed out) back to
// back, most likely CPU contention rather than anything prompt-size-related.
// 90s accepts this as a genuinely slow local-inference path rather than
// chasing a tighter budget; the mobile UI must show a real loading state.
const OLLAMA_TIMEOUT_MS = 90000;
// Measured exactly at its 15000ms ceiling once already under load — real
// timeout, not a fluke. 20s gives headroom without individually blocking
// gatherContext's Promise.all much longer than relevantAssets() itself.
const WORKSTREAM_EVENTS_TIMEOUT_MS = 20000;
// Fixed split rather than a shared pool — relevantAssets() alone returned 49
// matches on a real test query and crowded out workstream events entirely,
// which turned out to hold the actually-relevant answer. Each source gets
// its own cap so neither can starve the other; unused slots from one source
// are not reassigned to the other, so a real answer may see fewer than
// MAX_ASSET_SNIPPETS + MAX_EVENT_SNIPPETS total.
// Kept small — CPU-bound local generation scales with prompt size, and a
// smaller test prompt already took 47.6s. Trading context depth for a
// response that finishes within OLLAMA_TIMEOUT_MS.
const MAX_ASSET_SNIPPETS = 5;
const MAX_EVENT_SNIPPETS = 7;
const MAX_SNIPPET_CHARS = 400;

export type OllamaFallbackResult =
  | { status: "answered"; answers: string; source: "ollama-fallback"; groundedSnippetCount: number }
  | { status: "unavailable"; reason: string };

type WorkstreamEvent = {
  readable?: string;
  updated?: { value?: string };
  created?: { value?: string };
};

function keywordsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length >= 3);
}

function matchScore(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((score, word) => (lower.includes(word) ? score + 1 : score), 0);
}

/** GET /workstream_events, no query support on this PiecesOS install (confirmed
 * live 2026-08-25 — /workstream_events/search errors regardless of params) —
 * fetch recent events and filter client-side, same plain-text-match spirit as
 * PiecesClient.searchAssets(). */
async function fetchRelevantWorkstreamEvents(piecesBaseUrl: string, query: string): Promise<string[]> {
  const res = await fetch(`${piecesBaseUrl.replace(/\/$/, "")}/workstream_events`, {
    signal: AbortSignal.timeout(WORKSTREAM_EVENTS_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const body = await res.json();
  const iterable: WorkstreamEvent[] = Array.isArray(body?.iterable) ? body.iterable : [];

  const keywords = keywordsOf(query);
  const scored = iterable
    .map((e) => ({ event: e, score: keywords.length === 0 ? 0 : matchScore(e.readable ?? "", keywords) }))
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = a.event.updated?.value ?? a.event.created?.value ?? "";
    const bTime = b.event.updated?.value ?? b.event.created?.value ?? "";
    return bTime.localeCompare(aTime);
  });

  return scored
    .slice(0, MAX_EVENT_SNIPPETS)
    .map(({ event }) => (event.readable ?? "").slice(0, MAX_SNIPPET_CHARS));
}

async function gatherContext(pieces: PiecesClient, piecesBaseUrl: string, query: string): Promise<string[]> {
  const t0 = Date.now();
  const [assets, events] = await Promise.all([
    pieces.relevantAssets(query).catch(() => []),
    fetchRelevantWorkstreamEvents(piecesBaseUrl, query).catch(() => []),
  ]);
  console.error(`[ollama-fallback] gatherContext took ${Date.now() - t0}ms`);

  const assetSnippets = assets
    .slice(0, MAX_ASSET_SNIPPETS)
    .map((a) => {
      let snippet = `Asset: ${a.name} (updated ${a.updated})`;
      if (a.content) {
        snippet += `\n${a.content.slice(0, MAX_SNIPPET_CHARS)}`;
      }
      return snippet;
    });
  return [...assetSnippets, ...events];
}

async function generate(query: string, snippets: string[]): Promise<string> {
  const prompt =
    snippets.length > 0
      ? [
          "You are answering a question using ONLY the notes below, pulled from the user's Pieces memory.",
          "If the notes don't contain the answer, say so plainly instead of guessing.",
          "",
          "--- Notes ---",
          ...snippets.map((s, i) => `[${i + 1}] ${s}`),
          "--- End notes ---",
          "",
          `Question: ${query}`,
        ].join("\n")
      : [
          "No matching notes were found in the user's Pieces memory for this question.",
          "Say that plainly, then answer from general knowledge if you can, making clear it is not grounded in their data.",
          "",
          `Question: ${query}`,
        ].join("\n");

  console.error(`[ollama-fallback] prompt length: ${prompt.length} chars`);
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  console.error(`[ollama-fallback] generate took ${Date.now() - t0}ms`);
  if (!res.ok) throw new Error(`Ollama generate failed: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.response !== "string") throw new Error("Ollama returned no response text");
  return body.response;
}

export async function askOllamaFallback(
  pieces: PiecesClient,
  piecesBaseUrl: string,
  query: string,
): Promise<OllamaFallbackResult> {
  try {
    const snippets = await gatherContext(pieces, piecesBaseUrl, query);
    const answer = await generate(query, snippets);
    return {
      status: "answered",
      answers: answer,
      source: "ollama-fallback",
      groundedSnippetCount: snippets.length,
    };
  } catch (err) {
    console.error("[ollama-fallback] failed:", err);
    return {
      status: "unavailable",
      reason: `Ollama fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
