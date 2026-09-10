# Local Semantic Search — Design

**Date:** 2026-08-30
**Status:** Approved design, pending spec review
**Roadmap position:** Step 2 of 4 (from the "what's next" brainstorm). Depends on Step 1 (on-device triage, shipped `8ef6e54`). Blocks Step 3 (proactive nudges) and Step 4 (cross-app context stitching).

## Goal

A `/search` page that answers "when did I look at X?" / "what did I see about Y?" using semantic (meaning-based) matching, working fully offline for on-device history and additionally covering the home node's workstream summaries when it's reachable.

Search runs over the **union of two sources**:

1. **Local capture history** — on-device triaged summaries of passive captures, persisted in a new index that survives the flush-and-delete cycle.
2. **Server workstream summaries** — the `WorkstreamSummary[]` that `Recent.tsx` already fetches from the home node via `api.ts`.

## Key constraints discovered during design

- Triaged summaries are **not currently stored locally**. `triageQueue()` rewrites a queue entry with its summary, `flushUsageEvents()` sends it, `clearSentEvents()` deletes it. This design adds the missing local persistence.
- Only `triaged === true` entries (real on-device summaries) may be embedded/indexed. Raw accessibility text must never be embedded or persisted to the index — matches the existing `flushUsageEvents` "stop at first untriaged background capture" privacy guarantee.
- MediaPipe Text Embedder is not GenAI, so it is **not** subject to AICore's "no inference while a third-party app is foreground" restriction that shaped the deferred-triage design. Embedding can run at capture-index time and at search time without that limitation.
- The `search` UsageEvent type (`{ type: "search"; screen: "recent"; query; resultCount; mode: "relevant" | "text" | "text-fallback" }`) already exists in `usage.ts`'s union but has no emitter. This feature is its first emitter.

## Architecture

Five units, each independently testable:

| Unit | File(s) | Purpose | Depends on |
|---|---|---|---|
| TextEmbedder plugin | `android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java`, `src/lib/textEmbedder.ts` | text → `number[]` (L2-normalized embedding), fully offline via bundled `.tflite` | MediaPipe Tasks (Gradle) |
| Capture index store | `src/lib/captureIndex.ts` | append / read / evict `IndexEntry[]` in `@capacitor/preferences` | `@capacitor/preferences` |
| Indexer hook | edit `src/lib/triageQueue.ts` | after a successful triage, embed the summary and append to the index | `textEmbedder`, `captureIndex` |
| Semantic search | `src/lib/semanticSearch.ts` | query → embed → brute-force cosine over (local index ∪ server summaries) → ranked hits | `textEmbedder`, `captureIndex`, `api.ts` |
| Search page | `src/pages/Search.tsx` + route + tabbar entry in all pages | search box, debounced query, results list with source badges, fallback + error UI | `semanticSearch` |

### Data flow — indexing (write path)

```
background capture
  → recordEvent(system_telemetry, screen:"background", triaged:undefined)   [existing]
  → app foreground → triageQueue()                                          [existing]
    → tryOnDeviceTriage() succeeds → queue[i] rewritten, triaged:true        [existing]
    → embed(summary)                                                        [NEW]
    → captureIndex.appendEntry({ id:`local:${timestamp}`, text:summary,
        vector, timestamp, source:"local", app_label })                     [NEW]
  → flushUsageEvents() → clearSentEvents()                                   [existing]
```

The queue entry is still sent and deleted as before. The index entry is a separate, longer-lived copy of just the summary.

### Data flow — search (read path)

```
user types query (debounced 300ms)
  → embed(query)
      fails → EmbedderUnavailableError → page falls back to substring filter
  → local:  captureIndex.readIndex() → dot-product query·entry.vector for each
  → server: api.getWorkstreamSummaries()
      HomeNodeUnreachableError → skip server, set serverSkipped flag
      else → embedBatch(name + "\n" + text for each) → dot-product
             (session-cached in a module-level Map keyed by summary id)
  → merge local + server hits → sort by score desc
  → drop hits below MIN_SCORE (0.2) → take limit (default 20)
  → recordEvent({ type:"search", screen:"recent", query, resultCount,
       mode: "relevant" | "text-fallback" })
```

Server summaries are embedded on demand at search time and cached only for the session — they live authoritatively on the home node and change server-side, so persisting their vectors locally would risk staleness.

## Unit detail

### 1. TextEmbedder plugin

**Native — `TextEmbedderPlugin.java`** (mirrors `OnDeviceTriagePlugin.java` structure and error discipline):

| Method | Returns | Notes |
|---|---|---|
| `checkAvailability()` | `{ status: "available" \| "unavailable" }` | `unavailable` if the model asset fails to load at init. No download step. |
| `embed({ text })` | `{ ok: true, vector: number[] } \| { ok: false }` | Wraps MediaPipe `TextEmbedder.embed()`; converts the result `FloatBuffer` → JS array. Any throwable → `{ ok: false }`. |
| `embedBatch({ texts })` | `{ vectors: (number[] \| null)[] }` | One native round-trip for the server-summary set (~10–50 texts). Per-text failure → `null` at that index. |

- **Options:** `TextEmbedderOptions` with `.setL2Normalize(true)` so cosine similarity reduces to a dot product in `semanticSearch.ts`.
- **Model asset:** `universal_sentence_encoder.tflite` (~6 MB, 100-dim output) committed to `apps/mobile/android/app/src/main/assets/`. Treated as a release artifact like `apps/mobile/src/data/playCategories.json`. The `.tflite` itself adds ~6 MB, but pulling in MediaPipe `tasks-text` also bundles its native libraries (TFLite runtime + sentencepiece/regex `.so`). `ndk { abiFilters 'arm64-v8a' }` is now applied in `build.gradle`, so those `.so` libs ship for arm64 only rather than all four ABIs; the debug APK is ~39.7 MB (39,654,449 bytes; was ~37.0 MB on `tasks-text:0.10.14`, grew after bumping to `0.10.35` for 16 KB ELF page alignment), down from ~58.7 MB. `armeabi-v7a` may need adding back if 32-bit devices are in scope.
- **Gradle:** add `implementation 'com.google.mediapipe:tasks-text:0.10.35'` to `apps/mobile/android/app/build.gradle` `dependencies` block. (Pin to the exact version verified during implementation. `0.10.35` — MediaPipe added 16 KB ELF page alignment around 0.10.21; `packaging { jniLibs { useLegacyPackaging = false } }` is also set so AGP packages the `.so` files uncompressed and page-aligned.)
- **Registration:** `registerPlugin(TextEmbedderPlugin.class);` in `MainActivity.java` alongside the existing three.
- **minSdk:** no bump needed. minSdk is currently 26 (bumped for ML Kit GenAI during triage work); MediaPipe Tasks Text requires 24.

**TS wrapper — `src/lib/textEmbedder.ts`** (same collapse-to-`{ok:false}` discipline as `onDeviceTriage.ts`):

```ts
export type EmbedResult = { ok: true; vector: number[] } | { ok: false };

export async function embed(text: string): Promise<EmbedResult>;
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]>;
export async function embedderAvailable(): Promise<boolean>;
```

- Non-native platform → `embed` returns `{ ok: false }`, `embedBatch` returns `texts.map(() => null)`, `embedderAvailable` returns `false`. Exactly parallels `onDeviceTriage.ts`.
- Callers never branch on *why* embedding failed.

### 2. Capture index store — `src/lib/captureIndex.ts`

```ts
export type IndexEntry = {
  id: string;          // `local:${timestamp}` — stable dedupe key
  text: string;        // the triaged summary; never raw capture text
  vector: number[];    // L2-normalized, 100-dim
  timestamp: string;   // ISO, copied from the source UsageEvent
  source: "local";     // server hits are never persisted here
  app_label?: string;  // carried through for display / future filtering
};
```

- **Preferences key:** `pieces-android:captureIndex`.
- **`MAX_INDEX = 2000`** — named constant.

| Function | Behavior |
|---|---|
| `appendEntry(e: IndexEntry): Promise<void>` | read → if an entry with `e.id` already exists, return without change (idempotent — `triageQueue()` may re-walk after a flush that didn't clear) → push → if `length > MAX_INDEX`, keep the last `MAX_INDEX` (`slice(-MAX_INDEX)`; append order == time order, so this evicts oldest) → write |
| `readIndex(): Promise<IndexEntry[]>` | parse the blob; return `[]` on missing or corrupt JSON (same try/catch pattern as `usage.ts` `readQueue`) |
| `clearIndex(): Promise<void>` | delete the key; for a future Status-page "reset local data" affordance and for tests |

- **Size estimate:** 2000 × (100 floats serialized as JSON ≈ 1.5 KB + ~200 B metadata) ≈ 3.4 MB. Within Android's practical Preferences ceiling.
- **File header documents the privacy invariant:** only `triaged === true` summaries reach this store; raw accessibility text is never embedded or persisted here.

### 3. Indexer hook — edit `src/lib/triageQueue.ts`

Inside the existing `for` loop, within the `if (triaged.ok)` branch, immediately after `queue[i] = rewritten;`:

```ts
const emb = await embed(triaged.summary);
if (emb.ok) {
  await appendEntry({
    id: `local:${event.timestamp}`,
    text: triaged.summary,
    vector: emb.vector,
    timestamp: event.timestamp,
    source: "local",
    app_label: event.app_label,
  });
}
```

- Embedding failure → the entry is simply not indexed; triage and flush proceed unchanged. Non-fatal, consistent with the module's existing tolerance for triage fallback.
- `id` keyed on `event.timestamp` → re-running `triageQueue()` will not double-index (`appendEntry` dedupes on `id`).
- Runs sequentially with triage; adds ~10 ms per entry, negligible against the ~2–3 s inference already in the loop.
- New imports: `embed` from `./textEmbedder`, `appendEntry` from `./captureIndex`.

### 4. Semantic search — `src/lib/semanticSearch.ts`

```ts
export class EmbedderUnavailableError extends Error {}

export type SearchHit = {
  text: string;
  score: number;              // 0..1 (dot product of L2-normalized vectors)
  timestamp: string;
  source: "local" | "server";
  app_label?: string;         // local hits only
};

export type SearchResult = {
  hits: SearchHit[];
  serverSkipped: boolean;     // true when the home node was unreachable
  mode: "relevant" | "text-fallback";
};

export async function semanticSearch(
  query: string,
  opts?: { limit?: number },
): Promise<SearchResult>;
```

- **`MIN_SCORE = 0.2`**, **`DEFAULT_LIMIT = 20`** — named constants.

Flow:

1. If `!(await embedderAvailable())` → run the **text-fallback** path (see §5) and return `{ hits, serverSkipped, mode: "text-fallback" }`.
2. `embed(query)` → if `{ ok: false }` → `throw new EmbedderUnavailableError()`.
3. **Local:** `readIndex()`; for each entry, `score = dot(queryVec, entry.vector)`.
4. **Server:** `getWorkstreamSummaries()`.
   - `HomeNodeUnreachableError` or `ProxyNotConfiguredError` → skip server, `serverSkipped = true` (for `ProxyNotConfiguredError`, `serverSkipped` still communicates "no server results" to the page).
   - else → for each summary, embed `` `${s.name}\n${s.text}` `` via `embedBatch`, caching `{ id → vector }` in a module-level `Map` for the session; `score = dot(queryVec, summaryVec)` (skip entries whose batch slot came back `null`).
5. Merge local + server hits, sort by `score` descending, filter `score >= MIN_SCORE`, take `opts.limit ?? DEFAULT_LIMIT`.
6. Return `{ hits, serverSkipped, mode: "relevant" }`.

Telemetry is emitted by the **page**, not this module (the module is pure/testable; the page owns side effects) — see §5.

### 5. Search page — `src/pages/Search.tsx`

New route `/search`. Added as a 5th entry to the `tabbar` `<nav>` in all pages (`Setup.tsx`, `Status.tsx`, `Recent.tsx`, `Ask.tsx`, `Search.tsx`) — it replaces nothing.

**States:** `idle | searching | results | embedder-unavailable | error`.

- Search box, query debounced 300 ms; also a submit button for immediate search.
- On a completed search, `recordEvent({ type: "search", screen: "recent", query, resultCount: hits.length, mode })` where `mode` is `result.mode` (`"relevant"` or `"text-fallback"`). (`screen: "recent"` is dictated by the existing type union; the search feature is conceptually an extension of Recent.)
- **Results:** list of cards — summary text (truncated), relative timestamp, a source badge: **"On this device"** (`source: "local"`) or **"From home PC"** (`source: "server"`). Score is not displayed. Tapping a card expands the full text (same expand pattern as `Recent.tsx`).
- **`serverSkipped` banner:** "Home PC offline — showing device results only."
- **Empty results:** "Nothing matched. Captures are indexed as they're triaged — that happens when you reopen the app."
- **`embedder-unavailable` state:** reached when `semanticSearch` returns `mode: "text-fallback"`. The page still shows results (from the substring filter) plus a one-line note: "Meaning-based search isn't available on this device — showing text matches."
- **`error` state:** `EmbedderUnavailableError` thrown mid-search, or any unexpected throw. Message + Retry button.

**Text-fallback path** (inside `semanticSearch.ts`, invoked at step 1): case-insensitive substring match of the query against `readIndex()` entries' `text` and, if the server is reachable, against `getWorkstreamSummaries()` summaries' `name` + `text`. Same `SearchHit` shape, `score` set to `1` for a match / entries not matching are excluded, `serverSkipped` set the same way. Keeps the page useful in a browser dev environment and on any device where the `.tflite` won't load.

## Error handling summary

| Failure | Behavior |
|---|---|
| Embedder unavailable (non-native, or model load failed) | Text-substring fallback; page works; telemetry `mode: "text-fallback"` |
| Query embed throws mid-search | `error` state, Retry button |
| Home node offline / proxy not configured | Local-only results + "Home PC offline" banner |
| Corrupt index blob | `readIndex()` returns `[]`; page shows empty state |
| Empty index (nothing triaged yet) | Empty state with explanation |
| Individual server summary fails to embed in the batch | That summary is skipped; others rank normally |

## Testing

**Automated (Vitest, mocking `@capacitor/preferences` and `../lib/textEmbedder`):**

- `captureIndex.test.ts` — append; dedupe on repeated `id`; eviction keeps newest `MAX_INDEX` and drops oldest; corrupt blob → `[]`; `clearIndex` empties the key.
- `semanticSearch.test.ts` — ranking order with hand-constructed vectors; `MIN_SCORE` filter drops low hits; server-skip path sets `serverSkipped` and still returns local hits; `ProxyNotConfiguredError` handled; text-fallback path triggered when `embedderAvailable()` is `false`; `limit` honored.
- `textEmbedder.test.ts` — non-native platform: `embed` → `{ ok: false }`, `embedBatch` → all `null`, `embedderAvailable` → `false`.

**Manual (documented in `docs/ACCEPTANCE.md`, as on-device triage was):**

1. Trigger a real passive capture in an allowed app. Reopen the companion app (triggers `triageQueue()`). Open `/search`, search a term related to what was on screen → a hit appears with the **"On this device"** badge.
2. Enable airplane mode. Search again → device hits still return; a **"Home PC offline"** banner shows.
3. With the home node reachable, search a term matching a known workstream summary → a hit appears with the **"From home PC"** badge.
4. Confirm the debug APK is ~39.7 MB (39,654,449 bytes; the `.tflite` is ~6 MB of that; MediaPipe `tasks-text` native libs, now arm64-v8a only via `abiFilters`, account for most of the rest) and the app launches without an ANR (model loads off the main thread or lazily).

## Out of scope (YAGNI — revisit at roadmap step 3)

- Re-embedding the index when the model changes.
- Incremental / cached sync of server summaries across sessions.
- Filters by app, date range, or source.
- Search history / recent queries.
- Highlighting matched spans within a result.
- A "reset local data" button (the `clearIndex` function is built; wiring a Status-page button is deferred).

## Files touched

**New:**
- `apps/mobile/android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java`
- `apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite`
- `apps/mobile/src/lib/textEmbedder.ts`
- `apps/mobile/src/lib/captureIndex.ts`
- `apps/mobile/src/lib/semanticSearch.ts`
- `apps/mobile/src/pages/Search.tsx`
- `apps/mobile/src/lib/captureIndex.test.ts`
- `apps/mobile/src/lib/semanticSearch.test.ts`
- `apps/mobile/src/lib/textEmbedder.test.ts`

**Edited:**
- `apps/mobile/android/app/build.gradle` — add `com.google.mediapipe:tasks-text` dependency
- `apps/mobile/android/app/src/main/java/com/pieces/android/companion/MainActivity.java` — register `TextEmbedderPlugin`
- `apps/mobile/src/lib/triageQueue.ts` — embed + index after successful triage
- `apps/mobile/src/App.tsx` — add `/search` route
- `apps/mobile/src/pages/Setup.tsx`, `Status.tsx`, `Recent.tsx`, `Ask.tsx` — add Search tab to `tabbar`
- `docs/ACCEPTANCE.md` — manual acceptance steps
