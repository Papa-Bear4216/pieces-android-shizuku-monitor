# Local Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/search` page that finds past activity by meaning, searching the union of on-device triaged capture history and the home node's workstream summaries.

**Architecture:** A new native Capacitor plugin wraps MediaPipe Text Embedder (a bundled `.tflite` model) to turn text into L2-normalized vectors offline. A new `@capacitor/preferences`-backed capture index stores triaged summaries with their vectors, populated from the existing `triageQueue()` pass so summaries survive the flush-and-delete cycle. Search embeds the query, brute-forces cosine similarity (a dot product, since vectors are normalized) over the local index plus freshly-embedded server summaries, and renders ranked hits with source badges. When the embedder or model is unavailable (browser dev, model load failure) the page falls back to a plain substring filter.

**Tech Stack:** TypeScript, React 19, react-router 8 (HashRouter), `@capacitor/preferences`, Capacitor 8 Android plugin (Java), MediaPipe Tasks Text (`com.google.mediapipe:tasks-text`), Vitest (added by this plan).

**Spec:** `docs/superpowers/specs/2026-08-30-local-semantic-search-design.md`

## Global Constraints

- **All new TS library modules follow the "collapse to a failure value" discipline** used by `src/lib/onDeviceTriage.ts`: callers never branch on *why* something failed. Non-native platform always returns the failure value, never throws.
- **Privacy invariant:** only `triaged === true` summaries may be embedded or persisted to the capture index. Raw accessibility capture text must never be embedded, never written to the index.
- **`MAX_INDEX = 2000`**, **`MIN_SCORE = 0.2`**, **`DEFAULT_LIMIT = 20`** — named constants, exact values.
- **Preferences key for the index:** `pieces-android:captureIndex` (exact string).
- **Embedding model:** `universal_sentence_encoder.tflite`, 100-dim output, `TextEmbedderOptions.setL2Normalize(true)`.
- **minSdk stays 26** (already set). MediaPipe Tasks Text needs 24 — no bump.
- **Gradle dependency:** `implementation 'com.google.mediapipe:tasks-text:0.10.14'` — pin to the exact version that resolves; `0.10.14` is the target, adjust only if it fails to resolve and note the change.
- **The `search` UsageEvent** must use the existing type-union shape verbatim: `{ type: "search"; screen: "recent"; query: string; resultCount: number; mode: "relevant" | "text" | "text-fallback"; timestamp: string }`. This feature emits `mode: "relevant"` or `mode: "text-fallback"` only.
- **Working directory for all commands:** `apps/mobile/` unless a path says otherwise.
- **Commit style:** end messages with the repo's existing trailer convention (Co-Authored-By line). Frequent commits — one per task minimum.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `apps/mobile/android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java` | Native: load the tflite model, expose `checkAvailability` / `embed` / `embedBatch` over the Capacitor bridge |
| `apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite` | The bundled embedding model (binary, committed) |
| `apps/mobile/src/lib/textEmbedder.ts` | TS wrapper over the plugin; `embed` / `embedBatch` / `embedderAvailable`; non-native → failure values |
| `apps/mobile/src/lib/captureIndex.ts` | Preferences-backed `IndexEntry[]` store: `appendEntry` (dedupe + evict) / `readIndex` / `clearIndex` |
| `apps/mobile/src/lib/semanticSearch.ts` | `semanticSearch(query, opts)` → ranked `SearchHit[]` over local index ∪ server summaries; text-fallback path; `EmbedderUnavailableError` |
| `apps/mobile/src/pages/Search.tsx` | The `/search` page: debounced search box, result cards with source badges, fallback + error + empty states, telemetry emission |
| `apps/mobile/src/lib/captureIndex.test.ts` | Vitest: append / dedupe / evict / corrupt-blob / clear |
| `apps/mobile/src/lib/semanticSearch.test.ts` | Vitest: ranking / MIN_SCORE / server-skip / fallback / limit |
| `apps/mobile/src/lib/textEmbedder.test.ts` | Vitest: non-native returns failure values |
| `apps/mobile/src/test/setup.ts` | Vitest setup: mock `@capacitor/core` `Capacitor.isNativePlatform` default |

**Modified:**

| File | Change |
|---|---|
| `apps/mobile/package.json` | add `vitest`, `@vitest/... ` not needed; add `test` script |
| `apps/mobile/vite.config.ts` | add a `test` block (vitest reads vite config) |
| `apps/mobile/android/app/build.gradle` | add the MediaPipe Tasks Text dependency |
| `apps/mobile/android/app/src/main/java/com/pieces/android/companion/MainActivity.java` | `registerPlugin(TextEmbedderPlugin.class);` |
| `apps/mobile/src/lib/triageQueue.ts` | after a successful triage: `embed(summary)` + `appendEntry(...)` |
| `apps/mobile/src/App.tsx` | import `Search`, add `<Route path="/search" element={<Search />} />` |
| `apps/mobile/src/pages/Setup.tsx`, `Status.tsx`, `Recent.tsx`, `Ask.tsx` | add a Search button to the `.tabbar` `<nav>` |
| `docs/ACCEPTANCE.md` | append the manual acceptance steps |

---

## Task 1: Test infrastructure (Vitest)

No test framework is currently installed. This task adds it so every later task can do TDD.

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/vite.config.ts`
- Create: `apps/mobile/src/test/setup.ts`
- Create: `apps/mobile/src/lib/sanity.test.ts` (temporary, deleted in Step 6)

**Interfaces:**
- Produces: a working `npm test` (Vitest, jsdom env) that every later task's test steps depend on.

- [ ] **Step 1: Install Vitest and jsdom**

Run (in `apps/mobile/`):
```bash
npm install -D vitest jsdom @testing-library/react @testing-library/dom
```

- [ ] **Step 2: Add the test script to `package.json`**

In the `"scripts"` block, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Configure Vitest in `vite.config.ts`**

Replace the file contents with:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
})
```

- [ ] **Step 4: Create the setup file `src/test/setup.ts`**

```ts
import { vi } from "vitest";

// Default every test to the non-native (browser) platform. Individual tests
// that exercise native paths override this with vi.mocked(...).mockReturnValue(true).
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: vi.fn(() => false),
    },
    registerPlugin: vi.fn(() => ({})),
  };
});

// @capacitor/preferences → in-memory store, reset per test file via beforeEach in each test.
const store = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
  },
  __store: store,
}));
```

- [ ] **Step 5: Write a sanity test `src/lib/sanity.test.ts`**

```ts
import { expect, test } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 6: Run it, confirm pass, then delete the sanity test**

Run: `npm test`
Expected: PASS, 1 test.
Then: `rm src/lib/sanity.test.ts`

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/vite.config.ts apps/mobile/src/test/setup.ts
git commit -m "test: add Vitest with jsdom + Capacitor mocks

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Capture index store

**Files:**
- Create: `apps/mobile/src/lib/captureIndex.ts`
- Test: `apps/mobile/src/lib/captureIndex.test.ts`

**Interfaces:**
- Consumes: `@capacitor/preferences` `Preferences` (mocked in tests via `src/test/setup.ts`).
- Produces:
  ```ts
  export type IndexEntry = {
    id: string;          // `local:${timestamp}`
    text: string;
    vector: number[];    // L2-normalized, 100-dim
    timestamp: string;   // ISO
    source: "local";
    app_label?: string;
  };
  export const MAX_INDEX = 2000;
  export async function appendEntry(e: IndexEntry): Promise<void>;
  export async function readIndex(): Promise<IndexEntry[]>;
  export async function clearIndex(): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/lib/captureIndex.test.ts`:
```ts
import { beforeEach, describe, expect, test } from "vitest";
import { Preferences } from "@capacitor/preferences";
import { appendEntry, readIndex, clearIndex, MAX_INDEX, type IndexEntry } from "./captureIndex";

const KEY = "pieces-android:captureIndex";

function entry(ts: string): IndexEntry {
  return { id: `local:${ts}`, text: `summary ${ts}`, vector: [0.1, 0.2], timestamp: ts, source: "local" };
}

beforeEach(async () => {
  await Preferences.remove({ key: KEY });
});

describe("captureIndex", () => {
  test("appendEntry then readIndex returns the entry", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    const index = await readIndex();
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe("local:2026-01-01T00:00:00Z");
  });

  test("appendEntry is idempotent on duplicate id", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    expect(await readIndex()).toHaveLength(1);
  });

  test("appendEntry evicts oldest past MAX_INDEX, keeping newest", async () => {
    for (let i = 0; i < MAX_INDEX + 5; i++) {
      const ts = `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
      await appendEntry({ ...entry(ts) });
    }
    const index = await readIndex();
    expect(index).toHaveLength(MAX_INDEX);
    // oldest 5 dropped
    expect(index[0].id).toBe("local:2026-01-01T00:00:05.000Z");
  });

  test("readIndex returns [] on corrupt blob", async () => {
    await Preferences.set({ key: KEY, value: "{not json" });
    expect(await readIndex()).toEqual([]);
  });

  test("clearIndex empties the store", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    await clearIndex();
    expect(await readIndex()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- captureIndex`
Expected: FAIL — cannot find module `./captureIndex`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/lib/captureIndex.ts`:
```ts
import { Preferences } from "@capacitor/preferences";

// Local, longer-lived store of TRIAGED capture summaries and their
// embedding vectors, powering /search. Separate from usage.ts's queue:
// that queue is flushed to the gateway and deleted (clearSentEvents), so
// without this store there'd be no on-device history to search.
//
// PRIVACY INVARIANT: only entries built from a successful on-device triage
// (triaged === true in usage.ts) are ever written here. Raw accessibility
// capture text is never embedded and never persisted to this index — the
// same guarantee flush.ts enforces on the wire.
//
// Stored in Preferences (not localStorage) for consistency with usage.ts
// and config.ts, and because Capacitor WebView IndexedDB persistence has
// historically been unreliable across Android WebView updates.

const KEY = "pieces-android:captureIndex";

// ~2000 * (100 floats as JSON ~1.5KB + ~200B metadata) ~= 3.4MB, within
// Android's practical Preferences ceiling. Eviction is oldest-first:
// append order equals time order, so slice(-MAX_INDEX) drops the oldest.
export const MAX_INDEX = 2000;

export type IndexEntry = {
  id: string; // `local:${timestamp}` — stable dedupe key
  text: string; // the triaged summary; never raw capture text
  vector: number[]; // L2-normalized, 100-dim
  timestamp: string; // ISO, copied from the source UsageEvent
  source: "local"; // server hits are never persisted here
  app_label?: string;
};

async function read(): Promise<IndexEntry[]> {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function write(entries: IndexEntry[]): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(entries) });
}

export async function appendEntry(e: IndexEntry): Promise<void> {
  const entries = await read();
  if (entries.some((x) => x.id === e.id)) return; // idempotent — triageQueue() may re-walk
  entries.push(e);
  const trimmed = entries.length > MAX_INDEX ? entries.slice(-MAX_INDEX) : entries;
  await write(trimmed);
}

export async function readIndex(): Promise<IndexEntry[]> {
  return read();
}

export async function clearIndex(): Promise<void> {
  await Preferences.remove({ key: KEY });
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- captureIndex`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/captureIndex.ts apps/mobile/src/lib/captureIndex.test.ts
git commit -m "feat: add Preferences-backed capture index store

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: TextEmbedder TS wrapper (non-native path + tests)

The native plugin comes in Task 4. This task builds the TS wrapper and locks its contract with tests that run in the browser environment (non-native path only).

**Files:**
- Create: `apps/mobile/src/lib/textEmbedder.ts`
- Test: `apps/mobile/src/lib/textEmbedder.test.ts`

**Interfaces:**
- Consumes: `@capacitor/core` `Capacitor.isNativePlatform`, `registerPlugin` (both mocked in tests).
- Produces:
  ```ts
  export type EmbedResult = { ok: true; vector: number[] } | { ok: false };
  export async function embed(text: string): Promise<EmbedResult>;
  export async function embedBatch(texts: string[]): Promise<(number[] | null)[]>;
  export async function embedderAvailable(): Promise<boolean>;
  ```
  Native contract the plugin (Task 4) must satisfy:
  - `TextEmbedder.checkAvailability()` → `{ status: "available" | "unavailable" }`
  - `TextEmbedder.embed({ text })` → `{ ok: true, vector: number[] } | { ok: false }`
  - `TextEmbedder.embedBatch({ texts })` → `{ vectors: (number[] | null)[] }`

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/lib/textEmbedder.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { embed, embedBatch, embedderAvailable } from "./textEmbedder";

// setup.ts mocks Capacitor.isNativePlatform to return false by default.
describe("textEmbedder (non-native)", () => {
  test("embed returns { ok: false } off-device", async () => {
    expect(await embed("hello")).toEqual({ ok: false });
  });

  test("embedBatch returns one null per input off-device", async () => {
    expect(await embedBatch(["a", "b", "c"])).toEqual([null, null, null]);
  });

  test("embedderAvailable returns false off-device", async () => {
    expect(await embedderAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- textEmbedder`
Expected: FAIL — cannot find module `./textEmbedder`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/lib/textEmbedder.ts`:
```ts
import { Capacitor, registerPlugin } from "@capacitor/core";

const TextEmbedder = registerPlugin<any>("TextEmbedder");

// Mirrors onDeviceTriage.ts: every failure path (not native, model
// unavailable, native call threw, malformed response) collapses to the
// same failure value. Callers never branch on why embedding didn't work —
// semanticSearch.ts falls back to a plain substring filter.
//
// MediaPipe Text Embedder is NOT GenAI, so unlike OnDeviceTriage it is not
// subject to AICore's "no inference while a third-party app is foreground"
// restriction — it can run at capture-index time and at search time.
export type EmbedResult = { ok: true; vector: number[] } | { ok: false };

export async function embedderAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const res = await TextEmbedder.checkAvailability();
    return res?.status === "available";
  } catch {
    return false;
  }
}

export async function embed(text: string): Promise<EmbedResult> {
  if (!Capacitor.isNativePlatform()) return { ok: false };
  try {
    const res = await TextEmbedder.embed({ text });
    if (!res?.ok || !Array.isArray(res.vector)) return { ok: false };
    return { ok: true, vector: res.vector };
  } catch {
    return { ok: false };
  }
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!Capacitor.isNativePlatform()) return texts.map(() => null);
  try {
    const res = await TextEmbedder.embedBatch({ texts });
    const vectors = res?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      return texts.map(() => null);
    }
    return vectors.map((v: unknown) => (Array.isArray(v) ? (v as number[]) : null));
  } catch {
    return texts.map(() => null);
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- textEmbedder`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/textEmbedder.ts apps/mobile/src/lib/textEmbedder.test.ts
git commit -m "feat: add TextEmbedder TS wrapper (non-native fallback)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: TextEmbedder native plugin

Native Android plugin. Not unit-testable in Vitest — verified by build success here and by on-device acceptance in Task 9.

**Files:**
- Create: `apps/mobile/android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java`
- Create: `apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite`
- Modify: `apps/mobile/android/app/build.gradle` (dependencies block, around line 33-49)
- Modify: `apps/mobile/android/app/src/main/java/com/pieces/android/companion/MainActivity.java:11` (after `registerPlugin(OnDeviceTriagePlugin.class);`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `TextEmbedder` native plugin satisfying the contract in Task 3's Interfaces block.

- [ ] **Step 1: Download the model asset**

Run (from repo root):
```bash
mkdir -p apps/mobile/android/app/src/main/assets
curl -L -o apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite \
  https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/latest/universal_sentence_encoder.tflite
```
Verify: `ls -la apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite` shows a file ~6 MB. If the URL 404s, get the current link from https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder/index#models and note the substituted URL in the commit message.

- [ ] **Step 2: Add the Gradle dependency**

In `apps/mobile/android/app/build.gradle`, inside `dependencies { ... }`, after the `genai-prompt` line, add:
```gradle
    // MediaPipe Text Embedder for local semantic search — bundled tflite,
    // L2-normalized 100-dim embeddings, fully offline. Not GenAI, so not
    // subject to AICore's foreground-app inference restriction.
    implementation 'com.google.mediapipe:tasks-text:0.10.14'
```

- [ ] **Step 3: Write the plugin**

`apps/mobile/android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java`:
```java
package com.pieces.android.companion;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.components.containers.Embedding;
import com.google.mediapipe.tasks.components.containers.EmbeddingResult;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder;
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder.TextEmbedderOptions;

import org.json.JSONArray;

import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * MediaPipe Text Embedder over the Capacitor bridge, powering /search's
 * local semantic ranking. Same plugin shape and "collapse every failure to
 * ok=false" discipline as OnDeviceTriagePlugin — callers (textEmbedder.ts →
 * semanticSearch.ts) fall back to a plain substring filter when embedding
 * is unavailable.
 *
 * The model ("universal_sentence_encoder.tflite", ~6MB, 100-dim output) is
 * bundled in assets/ and committed to the repo as a release artifact, like
 * src/data/playCategories.json. setL2Normalize(true) means cosine
 * similarity in JS is a plain dot product.
 */
@CapacitorPlugin(name = "TextEmbedder")
public class TextEmbedderPlugin extends Plugin {

    private static final String MODEL_ASSET = "universal_sentence_encoder.tflite";

    private final Executor executor = Executors.newSingleThreadExecutor();
    private TextEmbedder embedder;
    private boolean initFailed = false;

    @Override
    public void load() {
        try {
            BaseOptions baseOptions = BaseOptions.builder().setModelAssetPath(MODEL_ASSET).build();
            TextEmbedderOptions options = TextEmbedderOptions.builder()
                    .setBaseOptions(baseOptions)
                    .setL2Normalize(true)
                    .setQuantize(false)
                    .build();
            embedder = TextEmbedder.createFromOptions(getContext(), options);
        } catch (Throwable t) {
            initFailed = true;
        }
    }

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("status", (embedder != null && !initFailed) ? "available" : "unavailable");
        call.resolve(ret);
    }

    @PluginMethod
    public void embed(PluginCall call) {
        String text = call.getString("text", "");
        executor.execute(() -> {
            JSObject ret = new JSObject();
            try {
                if (embedder == null) {
                    ret.put("ok", false);
                    call.resolve(ret);
                    return;
                }
                EmbeddingResult result = embedder.embed(text).embeddingResult();
                List<Embedding> embeddings = result.embeddings();
                if (embeddings.isEmpty()) {
                    ret.put("ok", false);
                    call.resolve(ret);
                    return;
                }
                ret.put("ok", true);
                ret.put("vector", floatArrayToJson(embeddings.get(0).floatEmbedding()));
                call.resolve(ret);
            } catch (Throwable t) {
                ret.put("ok", false);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void embedBatch(PluginCall call) {
        JSArray textsArr = call.getArray("texts", new JSArray());
        executor.execute(() -> {
            JSObject ret = new JSObject();
            JSONArray vectors = new JSONArray();
            try {
                for (int i = 0; i < textsArr.length(); i++) {
                    try {
                        String text = textsArr.getString(i);
                        if (embedder == null) {
                            vectors.put(JSONObject_NULL());
                            continue;
                        }
                        EmbeddingResult result = embedder.embed(text).embeddingResult();
                        List<Embedding> embeddings = result.embeddings();
                        if (embeddings.isEmpty()) {
                            vectors.put(JSONObject_NULL());
                        } else {
                            vectors.put(floatArrayToJson(embeddings.get(0).floatEmbedding()));
                        }
                    } catch (Throwable inner) {
                        vectors.put(JSONObject_NULL());
                    }
                }
            } catch (Throwable t) {
                // fall through — return whatever we accumulated
            }
            ret.put("vectors", vectors);
            call.resolve(ret);
        });
    }

    private static Object JSONObject_NULL() {
        return org.json.JSONObject.NULL;
    }

    private static JSONArray floatArrayToJson(float[] arr) {
        JSONArray out = new JSONArray();
        for (float v : arr) out.put((double) v);
        return out;
    }
}
```

- [ ] **Step 4: Register the plugin**

In `apps/mobile/android/app/src/main/java/com/pieces/android/companion/MainActivity.java`, after line 11 (`registerPlugin(OnDeviceTriagePlugin.class);`), add:
```java
        registerPlugin(TextEmbedderPlugin.class);
```

- [ ] **Step 5: Build the Android app to verify compilation**

Run (from repo root):
```bash
cd apps/mobile && npm run build && npx cap sync android && cd android && ./gradlew :app:compileDebugJavaWithJavac
```
Expected: BUILD SUCCESSFUL. If `tasks-text:0.10.14` fails to resolve, try the latest `0.10.x` from https://mvnrepository.com/artifact/com.google.mediapipe/tasks-text and update the constraint + this plan's Global Constraints note.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/android/app/src/main/java/com/pieces/android/companion/TextEmbedderPlugin.java \
        apps/mobile/android/app/src/main/assets/universal_sentence_encoder.tflite \
        apps/mobile/android/app/build.gradle \
        apps/mobile/android/app/src/main/java/com/pieces/android/companion/MainActivity.java
git commit -m "feat: add TextEmbedder native plugin (MediaPipe Tasks Text)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Wire indexing into triageQueue

**Files:**
- Modify: `apps/mobile/src/lib/triageQueue.ts`
- Test: `apps/mobile/src/lib/triageQueue.test.ts` (new)

**Interfaces:**
- Consumes: `embed` from `./textEmbedder` (Task 3), `appendEntry` + `IndexEntry` from `./captureIndex` (Task 2).
- Produces: no new exports. Side effect: every `triaged === true` rewrite also appends a `{ source: "local" }` entry to the capture index.

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/lib/triageQueue.test.ts`:
```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./onDeviceTriage", () => ({
  tryOnDeviceTriage: vi.fn(),
}));
vi.mock("./textEmbedder", () => ({
  embed: vi.fn(),
}));
vi.mock("./flush", () => ({
  flushUsageEvents: vi.fn(async () => {}),
}));

import { tryOnDeviceTriage } from "./onDeviceTriage";
import { embed } from "./textEmbedder";
import { triageQueue } from "./triageQueue";
import { recordEvent, peekQueue } from "./usage";
import { readIndex, clearIndex } from "./captureIndex";
import { Preferences } from "@capacitor/preferences";

beforeEach(async () => {
  await Preferences.remove({ key: "pieces-android:usageQueue" });
  await clearIndex();
  vi.clearAllMocks();
});

describe("triageQueue indexing", () => {
  test("a successful triage appends an embedded entry to the capture index", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw screen text",
      package: "com.example",
      app_label: "Example",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: true, summary: "looked at a thing", category: "shopping" });
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [0.5, 0.5] });

    await triageQueue();

    const index = await readIndex();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: "local:2026-02-01T10:00:00.000Z",
      text: "looked at a thing",
      vector: [0.5, 0.5],
      source: "local",
      app_label: "Example",
    });
  });

  test("a failed triage does NOT touch the capture index", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw",
      timestamp: "2026-02-01T11:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: false });

    await triageQueue();

    expect(await readIndex()).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  test("embed failure is non-fatal — queue still rewritten, index untouched", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw",
      timestamp: "2026-02-01T12:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: true, summary: "s", category: "c" });
    vi.mocked(embed).mockResolvedValue({ ok: false });

    await triageQueue();

    expect(await readIndex()).toEqual([]);
    const queue = await peekQueue();
    expect(queue[0]).toMatchObject({ triaged: true });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- triageQueue`
Expected: FAIL — index stays empty / `embed` never imported.

- [ ] **Step 3: Edit `triageQueue.ts`**

Add imports at the top:
```ts
import { embed } from "./textEmbedder";
import { appendEntry } from "./captureIndex";
```

In the loop, inside `if (triaged.ok) {`, immediately after `queue[i] = rewritten;`, add:
```ts
      // Also persist the summary to the searchable capture index (survives
      // the flush-and-delete cycle below). Embedding failure is non-fatal —
      // the entry just isn't indexed, exactly like a triage fallback.
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

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- triageQueue`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite to check nothing regressed**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/triageQueue.ts apps/mobile/src/lib/triageQueue.test.ts
git commit -m "feat: index triaged summaries into the capture index

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Semantic search module

**Files:**
- Create: `apps/mobile/src/lib/semanticSearch.ts`
- Test: `apps/mobile/src/lib/semanticSearch.test.ts`

**Interfaces:**
- Consumes: `embed` / `embedBatch` / `embedderAvailable` from `./textEmbedder`; `readIndex` from `./captureIndex`; `getWorkstreamSummaries`, `WorkstreamSummary`, `HomeNodeUnreachableError`, `ProxyNotConfiguredError` from `./api`.
- Produces:
  ```ts
  export class EmbedderUnavailableError extends Error {}
  export type SearchHit = {
    text: string;
    score: number;
    timestamp: string;
    source: "local" | "server";
    app_label?: string;
  };
  export type SearchResult = {
    hits: SearchHit[];
    serverSkipped: boolean;
    mode: "relevant" | "text-fallback";
  };
  export const MIN_SCORE = 0.2;
  export const DEFAULT_LIMIT = 20;
  export async function semanticSearch(query: string, opts?: { limit?: number }): Promise<SearchResult>;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/lib/semanticSearch.test.ts`:
```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./textEmbedder", () => ({
  embed: vi.fn(),
  embedBatch: vi.fn(),
  embedderAvailable: vi.fn(),
}));
vi.mock("./captureIndex", () => ({
  readIndex: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getWorkstreamSummaries: vi.fn() };
});

import { embed, embedBatch, embedderAvailable } from "./textEmbedder";
import { readIndex } from "./captureIndex";
import { getWorkstreamSummaries, HomeNodeUnreachableError } from "./api";
import { semanticSearch, EmbedderUnavailableError, MIN_SCORE } from "./semanticSearch";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(embedderAvailable).mockResolvedValue(true);
  vi.mocked(getWorkstreamSummaries).mockResolvedValue([]);
  vi.mocked(embedBatch).mockResolvedValue([]);
});

describe("semanticSearch", () => {
  test("ranks local hits by cosine (dot product of normalized vectors), descending", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "near", vector: [0.9, 0.1], timestamp: "t1", source: "local" },
      { id: "local:b", text: "far", vector: [0.1, 0.9], timestamp: "t2", source: "local" },
      { id: "local:c", text: "exact", vector: [1, 0], timestamp: "t3", source: "local" },
    ]);
    const res = await semanticSearch("q");
    expect(res.hits.map((h) => h.text)).toEqual(["exact", "near"]); // "far" (0.1) below MIN_SCORE 0.2
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
    expect(res.mode).toBe("relevant");
  });

  test("drops hits below MIN_SCORE", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "weak", vector: [MIN_SCORE - 0.05, 1], timestamp: "t", source: "local" },
    ]);
    const res = await semanticSearch("q");
    expect(res.hits).toHaveLength(0);
  });

  test("throws EmbedderUnavailableError when query embed fails but embedder reported available", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: false });
    await expect(semanticSearch("q")).rejects.toBeInstanceOf(EmbedderUnavailableError);
  });

  test("home node unreachable → serverSkipped true, local hits still returned", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "local hit", vector: [1, 0], timestamp: "t", source: "local" },
    ]);
    vi.mocked(getWorkstreamSummaries).mockRejectedValue(new HomeNodeUnreachableError("offline"));
    const res = await semanticSearch("q");
    expect(res.serverSkipped).toBe(true);
    expect(res.hits.map((h) => h.text)).toEqual(["local hit"]);
  });

  test("server summaries are embedded and merged with a 'server' source", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([]);
    vi.mocked(getWorkstreamSummaries).mockResolvedValue([
      { id: "s1", name: "Report", created: "y", text: "wrote the report" },
    ]);
    vi.mocked(embedBatch).mockResolvedValue([[1, 0]]);
    const res = await semanticSearch("q");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ text: "wrote the report", source: "server" });
  });

  test("honors opts.limit", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        id: `local:${i}`,
        text: `hit ${i}`,
        vector: [1, 0] as number[],
        timestamp: `t${i}`,
        source: "local" as const,
      })),
    );
    const res = await semanticSearch("q", { limit: 5 });
    expect(res.hits).toHaveLength(5);
  });

  test("text-fallback path when embedder unavailable: substring match, mode text-fallback", async () => {
    vi.mocked(embedderAvailable).mockResolvedValue(false);
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "bought a lamp", vector: [], timestamp: "t1", source: "local" },
      { id: "local:b", text: "read the news", vector: [], timestamp: "t2", source: "local" },
    ]);
    const res = await semanticSearch("LAMP");
    expect(res.mode).toBe("text-fallback");
    expect(res.hits.map((h) => h.text)).toEqual(["bought a lamp"]);
    expect(embed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npm test -- semanticSearch`
Expected: FAIL — cannot find module `./semanticSearch`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/lib/semanticSearch.ts`:
```ts
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
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -- semanticSearch`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/semanticSearch.ts apps/mobile/src/lib/semanticSearch.test.ts
git commit -m "feat: add semanticSearch — local index + server summaries, text fallback

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Search page + route

**Files:**
- Create: `apps/mobile/src/pages/Search.tsx`
- Modify: `apps/mobile/src/App.tsx` (import + route)
- Test: `apps/mobile/src/pages/Search.test.tsx` (new)

**Interfaces:**
- Consumes: `semanticSearch`, `SearchHit`, `SearchResult`, `EmbedderUnavailableError` from `../lib/semanticSearch`; `recordEvent` from `../lib/usage`; `useNavigate` from `react-router`.
- Produces: default-exported `Search` React component; `/search` route.

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/pages/Search.test.tsx`:
```tsx
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/semanticSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/semanticSearch")>();
  return { ...actual, semanticSearch: vi.fn() };
});
vi.mock("../lib/usage", () => ({ recordEvent: vi.fn() }));

import { semanticSearch } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";
import Search from "./Search";

beforeEach(() => vi.clearAllMocks());

async function type(value: string) {
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
}

describe("Search page", () => {
  test("renders hits with source badges and records a telemetry event", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [
        { text: "bought a lamp", score: 0.8, timestamp: "2026-02-01T00:00:00Z", source: "local", app_label: "Amazon" },
        { text: "wrote the report", score: 0.7, timestamp: "2026-02-02T00:00:00Z", source: "server" },
      ],
      serverSkipped: false,
      mode: "relevant",
    });
    render(<Search />);
    await type("stuff");
    await waitFor(() => expect(screen.getByText("bought a lamp")).toBeTruthy());
    expect(screen.getByText(/on this device/i)).toBeTruthy();
    expect(screen.getByText(/from home pc/i)).toBeTruthy();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "search", screen: "recent", query: "stuff", resultCount: 2, mode: "relevant" }),
    );
  });

  test("shows the offline banner when serverSkipped", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: true, mode: "relevant" });
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByText(/home pc offline/i)).toBeTruthy());
  });

  test("shows the empty state when there are no hits", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: false, mode: "relevant" });
    render(<Search />);
    await type("nothing");
    await waitFor(() => expect(screen.getByText(/nothing matched/i)).toBeTruthy());
  });

  test("shows the fallback note when mode is text-fallback", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [{ text: "t", score: 1, timestamp: "2026-02-01T00:00:00Z", source: "local" }],
      serverSkipped: false,
      mode: "text-fallback",
    });
    render(<Search />);
    await type("t");
    await waitFor(() => expect(screen.getByText(/meaning-based search isn't available/i)).toBeTruthy());
  });

  test("shows an error + retry when semanticSearch throws", async () => {
    vi.mocked(semanticSearch).mockRejectedValue(new Error("boom"));
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- Search`
Expected: FAIL — cannot find module `./Search`.

- [ ] **Step 3: Write the page**

`apps/mobile/src/pages/Search.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { semanticSearch, type SearchHit } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";

type State =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; hits: SearchHit[]; serverSkipped: boolean; fallback: boolean }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 300;

export default function Search() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [expanded, setExpanded] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "searching" });
    try {
      const result = await semanticSearch(trimmed);
      setState({
        kind: "results",
        hits: result.hits,
        serverSkipped: result.serverSkipped,
        fallback: result.mode === "text-fallback",
      });
      recordEvent({
        type: "search",
        screen: "recent",
        query: trimmed,
        resultCount: result.hits.length,
        mode: result.mode === "text-fallback" ? "text-fallback" : "relevant",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    recordEvent({ type: "screen_view", screen: "recent", timestamp: new Date().toISOString() });
    return () => clearTimeout(timer.current);
  }, []);

  function onChange(value: string) {
    setQuery(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(value), DEBOUNCE_MS);
  }

  function onSubmit() {
    clearTimeout(timer.current);
    run(query);
  }

  return (
    <div className="page">
      <h1>Search</h1>
      <p className="hint">Find past activity by meaning — on this device and, when your home PC is reachable, its workflow summaries.</p>

      <div className="card-row" style={{ gap: 8 }}>
        <input
          type="search"
          placeholder="Search your activity…"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          style={{ flex: 1 }}
        />
        <button onClick={onSubmit}>Search</button>
      </div>

      {state.kind === "searching" && <p>Searching…</p>}

      {state.kind === "error" && (
        <>
          <p className="status-error">{state.message}</p>
          <button onClick={onSubmit}>Retry</button>
        </>
      )}

      {state.kind === "results" && (
        <>
          {state.fallback && (
            <p className="hint setup-note">Meaning-based search isn't available on this device — showing text matches.</p>
          )}
          {state.serverSkipped && (
            <p className="status-error">Home PC offline — showing device results only.</p>
          )}
          {state.hits.length === 0 && (
            <p className="hint">Nothing matched. Captures are indexed as they're triaged — that happens when you reopen the app.</p>
          )}
          <ul>
            {state.hits.map((h, i) => (
              <li key={i} className="card clickable" onClick={() => setExpanded(expanded === i ? null : i)}>
                <div className="card-row">
                  <span className="card-title">{h.source === "local" ? "On this device" : "From home PC"}</span>
                  <span className="card-meta">{new Date(h.timestamp).toLocaleString()}</span>
                </div>
                <div className={expanded === i ? "card-body" : "card-body truncated"}>{h.text}</div>
                {h.app_label && <span className="card-meta">{h.app_label}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
      </nav>
    </div>
  );
}
```

- [ ] **Step 4: Add the route in `App.tsx`**

Add the import near the other page imports:
```ts
import Search from "./pages/Search";
```
Add the route inside `<Routes>`, after the `/recent` route:
```tsx
          <Route path="/search" element={<Search />} />
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- Search`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc -b` clean; vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/pages/Search.tsx apps/mobile/src/pages/Search.test.tsx apps/mobile/src/App.tsx
git commit -m "feat: add /search page with semantic search UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Search tab in the nav bar of every page

Each existing page has its own `.tabbar` `<nav>` listing the *other* pages. Add a Search button to each, and add the missing existing-page buttons where Search's nav omitted them is not the concern here — only add Search.

**Files:**
- Modify: `apps/mobile/src/pages/Setup.tsx`
- Modify: `apps/mobile/src/pages/Status.tsx`
- Modify: `apps/mobile/src/pages/Recent.tsx`
- Modify: `apps/mobile/src/pages/Ask.tsx`

**Interfaces:**
- Consumes: each page already has `useNavigate` in scope.
- Produces: nothing new.

- [ ] **Step 1: Add the Search button to each page's `<nav className="tabbar">`**

In each of the four files, find the `<nav className="tabbar">` block and add, as the last button before `</nav>`:
```tsx
        <button onClick={() => navigate("/search")}>Search</button>
```
Confirm each file already imports/derives `navigate` from `useNavigate()` (they do — they already have `navigate(...)` calls in the same nav).

- [ ] **Step 2: Verify build + tests**

Run: `npm test && npm run build`
Expected: PASS / clean.

- [ ] **Step 3: Manual check in the dev server**

Run: `npm run dev`, open the printed URL, click through Setup → Status → Recent → Ask, confirm a "Search" tab is present on each and navigates to the search page.
Stop the dev server (Ctrl-C) when done.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/pages/Setup.tsx apps/mobile/src/pages/Status.tsx apps/mobile/src/pages/Recent.tsx apps/mobile/src/pages/Ask.tsx
git commit -m "feat: add Search tab to every page's nav bar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: On-device acceptance + docs

**Files:**
- Modify: `docs/ACCEPTANCE.md`

**Interfaces:** none.

- [ ] **Step 1: Append the acceptance section to `docs/ACCEPTANCE.md`**

```markdown
## Local Semantic Search (/search)

Prerequisites: a debug build installed on a device where on-device triage
already works (Gemini Nano available), screen context enabled.

1. **Local capture is indexed and searchable.**
   - Open an allowed app (e.g. a shopping app), let a passive capture happen.
   - Reopen the companion app (this runs `triageQueue()`, which triages then indexes).
   - Go to the Search tab, search a word related to what was on screen.
   - Expect: a result card with the **"On this device"** badge and the triaged summary text.

2. **Offline still returns device results.**
   - Enable airplane mode.
   - Search again for the same term.
   - Expect: the device hit still appears; a **"Home PC offline — showing device results only."** banner is shown.

3. **Server summaries are covered when the home node is reachable.**
   - Disable airplane mode, confirm Status shows the home PC online.
   - Search a term matching a known "What Got Done" summary.
   - Expect: a result card with the **"From home PC"** badge.

4. **APK size / launch.**
   - Confirm the debug APK is ~6 MB larger than the previous build (the bundled `.tflite`).
   - Confirm the app launches without an ANR (model loads off the main thread in `TextEmbedderPlugin.load()` — inference is on a single-thread executor).

5. **Model-unavailable fallback (optional, emulator without the model).**
   - On a build/device where the embedder can't initialize, `/search` still returns substring matches and shows "Meaning-based search isn't available on this device — showing text matches."
```

- [ ] **Step 2: Build the release-config debug APK and eyeball the size**

Run (from repo root):
```bash
cd apps/mobile && npm run build && npx cap sync android && cd android && ./gradlew :app:assembleDebug
ls -la app/build/outputs/apk/debug/app-debug.apk
```
Expected: BUILD SUCCESSFUL; note the APK size (compare against a pre-feature build if available).

- [ ] **Step 3: Commit**

```bash
git add docs/ACCEPTANCE.md
git commit -m "docs: acceptance steps for local semantic search

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Run the on-device acceptance checklist**

Follow the steps added in Step 1 on a real device. Record pass/fail for each in the session notes. Any failure → stop, diagnose with `superpowers:systematic-debugging`, do not mark the plan complete.

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|---|---|
| TextEmbedder plugin (native) | Task 4 |
| TextEmbedder TS wrapper | Task 3 |
| Model asset bundled + committed | Task 4 Step 1 |
| Gradle dependency + minSdk note | Task 4 Step 2 / Global Constraints |
| Plugin registration | Task 4 Step 4 |
| Capture index store (`appendEntry`/`readIndex`/`clearIndex`, MAX_INDEX, dedupe, evict, corrupt→[]) | Task 2 |
| Privacy invariant (only `triaged===true`) | Task 5 tests ("failed triage does NOT touch index") + captureIndex header |
| Indexer hook in triageQueue | Task 5 |
| `id` keyed on timestamp / idempotent | Task 2 (dedupe test) + Task 5 |
| semanticSearch: query embed, local dot-product, server embedBatch + session cache, merge/sort/MIN_SCORE/limit | Task 6 |
| `EmbedderUnavailableError` | Task 6 |
| Server-skip on `HomeNodeUnreachableError` / `ProxyNotConfiguredError` | Task 6 tests |
| Telemetry `search` event, `mode` relevant/text-fallback, `screen:"recent"` | Task 7 Step 3 + test |
| Text-fallback path | Task 6 (`textFallback`) + Task 7 (note UI) |
| Search page: states, debounce, badges, banners, empty state, error+retry | Task 7 |
| `/search` route (HashRouter) | Task 7 Step 4 |
| Search tab in all 5 pages | Task 7 (Search's own nav) + Task 8 (other 4) |
| Error handling table | Tasks 6 + 7 tests cover each row |
| Automated tests (captureIndex, semanticSearch, textEmbedder) | Tasks 2, 3, 6 (+ triageQueue Task 5, Search Task 7) |
| Manual acceptance in ACCEPTANCE.md | Task 9 |
| Vitest not yet installed | Task 1 (prerequisite, discovered during planning) |

No gaps.

**2. Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". The one version caveat (`tasks-text:0.10.14`) has an explicit fallback procedure and is called out in Global Constraints. The model-download URL has an explicit fallback ("if the URL 404s, get the current link from …").

**3. Type consistency:**
- `IndexEntry` shape identical in Task 2 (definition), Task 5 (`appendEntry` call), Task 6 (`readIndex` consumption).
- `embed` returns `{ ok: true; vector: number[] } | { ok: false }` in Task 3, consumed with `.ok` / `.vector` in Tasks 5 and 6 — matches.
- `embedBatch` returns `(number[] | null)[]` in Task 3, consumed as `vectors[i]` with null-check in Task 6 — matches.
- `SearchHit` / `SearchResult` identical in Task 6 (definition) and Task 7 (consumption): `hits`, `serverSkipped`, `mode`.
- `semanticSearch(query, opts?: { limit?: number })` — Task 6 signature, Task 7 calls `semanticSearch(trimmed)` (no opts) — valid.
- `recordEvent` `search` event matches the existing `usage.ts` union exactly (`type`, `screen:"recent"`, `query`, `resultCount`, `mode`, `timestamp`).
- Native method names (`checkAvailability`, `embed`, `embedBatch`) consistent between Task 3 (contract) and Task 4 (`@PluginMethod` implementations).

No inconsistencies.
