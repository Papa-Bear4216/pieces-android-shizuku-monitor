# Follow-up fixes report — local semantic search

Base: 059dc14 on shizuku-master. Two commits:
- 69aded7 perf: month-shard the capture index to avoid whole-blob rewrites
- 1ae09c3 build: restrict native ABIs to arm64-v8a, cut debug APK by ~28mb

## FIX A — month-sharded capture index

### Storage layout
- Shard key: pieces-android:captureIndex:YYYY-MM, month = entry.timestamp.slice(0,7). Value IndexEntry[] in insertion (== ascending timestamp) order.
- Manifest key: pieces-android:captureIndex:months. Value {month:string;count:number}[], sorted ascending by month.
  DEVIATION from spec's string[]: manifest also stores per-shard count so eviction's global total is O(1) (reduce over manifest, no shard reads) — matters because 2000+ sequential appends would be O(n^2) parse work otherwise. Count is authoritative because appendEntry + evict() are the only writers of shard contents and every mutation updates count in the same op. Documented in file header.

### Eviction
evict(manifest): total = sum(manifest[].count). While total > MAX_INDEX: read oldest shard (front of manifest). If shard.length <= overflow -> Preferences.remove whole shard key + manifest.shift(); else shard.slice(overflow) written back, oldest.count updated. Manifest persisted once by appendEntry after evict. Oldest-first eviction / newest MAX_INDEX kept preserved.

### Migration
migrateLegacyIfPresent() runs at top of appendEntry and (when manifest empty) in readIndex. Reads legacy pieces-android:captureIndex blob, buckets by month (dedupe on id), merges into existing shards, sorts each ascending, rewrites manifest counts, then Preferences.remove the legacy key. Legacy key absence = "already migrated" signal, so runs at most once.

### readIndex
Reads manifest (migrating first if empty and legacy present). Walks shards newest->oldest concatenating, stops once >= MAX_INDEX collected. Sorts collected ascending by timestamp, returns slice(-MAX_INDEX) if over. Corrupt shard JSON -> [].

### clearIndex
Reads manifest, removes every shard key, removes manifest key, removes legacy key.

### Public API unchanged
IndexEntry, MAX_INDEX=2000, appendEntry, readIndex (oldest->newest), clearIndex. triageQueue.ts / semanticSearch.ts untouched.

### Test setup
src/test/setup.ts already exported __store; NOT modified. captureIndex.test.ts imports __store, calls store.clear() + vi.mocked(Preferences.set).mockClear() in beforeEach (old single-key remove leaked shards/manifest between tests).

### Tests (src/lib/captureIndex.test.ts, 8 cases, all pass)
1. appendEntry then readIndex returns the entry
2. appendEntry is idempotent on duplicate id (same month)
3. entries across multiple months all show up, ascending by timestamp
4. eviction: appending past MAX_INDEX drops oldest, empties old shards, prunes manifest — seeds 3 in 2026-01 then MAX_INDEX+2 across 2026-02/03; asserts readIndex length == MAX_INDEX, no 2026-01 entries, 2026-01 absent from manifest, 2026-01 shard key undefined, manifest counts sum to MAX_INDEX
5. corrupt shard blob -> that shard treated as empty, others still returned
6. clearIndex removes all shards + manifest + legacy key
7. migration: legacy blob distributed into shards and legacy key removed — pre-seeds legacy key with 2 entries in different months, readIndex returns them ascending, legacy key gone, manifest has both months
8. append does NOT rewrite unrelated months' shards — seeds 2026-01 and 2026-03, mockClear()s Preferences.set, appends into 2026-03, filters Preferences.set calls to shard-shaped keys (startsWith prefix, excluding manifest key), asserts result == ["pieces-android:captureIndex:2026-03"] and does not contain the 2026-01 shard key

Test #8 evidence: PASSES — only the March shard key is written during an append into March; the January shard is never touched.

## FIX B — ABI filter

Added to apps/mobile/android/app/build.gradle, android{defaultConfig{...}} after versionName:
        ndk {
            abiFilters 'arm64-v8a'
        }

### APK size
OLD 58,716,445 bytes
NEW 29,116,050 bytes
saved 29,600,395 bytes (~28.2 MiB / ~29.6 MB)

### armeabi-v7a
Cannot verify install base here. Only arm64-v8a shipped. If 32-bit-only Android devices are in scope, armeabi-v7a must be added back — noted in both docs.

### Docs updated
- docs/ACCEPTANCE.md section 4 APK-size bullet — new number, "filter now applied", armeabi-v7a note
- docs/superpowers/specs/2026-08-30-local-semantic-search-design.md line ~82 (model-asset bullet) and line ~228 (verification step 4) — new number, filter applied, armeabi-v7a note; model ~6 MB + MediaPipe native libs explanation retained

## Verification output

npm test
 Test Files  5 passed (5)
      Tests  31 passed (31)

npm run build
tsc -b && vite build
103 modules transformed. built in 173ms. clean, no tsc errors.

npx cap sync android
Sync finished in 0.113s — no tracked-file changes produced (git status clean except the 3 intended files)

./gradlew :app:assembleDebug
BUILD SUCCESSFUL in 6s
130 actionable tasks: 21 executed, 109 up-to-date

stat -c %s app/build/outputs/apk/debug/app-debug.apk
29116050   (OLD: 58716445)

local.properties and app/build/ are gitignored and not committed.

---

## FIX round 2 — eviction correctness (commit follows)

### BUG 1 (Critical) — evict() ran on an unsorted manifest
`captureIndex.ts` appendEntry — previously `manifest.push(...)` then `await evict(manifest)` with sorting only inside `writeManifest` (after eviction). A backdated/re-walked append left the in-memory manifest month-unsorted, so `evict` treated `manifest[0]` (not the oldest month) as oldest and dropped the wrong entries.
Fix: `captureIndex.ts:166-168` — `manifest.sort((a,b) => a.month<b.month?-1:...)` immediately before `await evict(manifest)`.

### BUG 2 (Critical) — one corrupt shard wiped the whole index during eviction
`captureIndex.ts` evict() — `total` came from `manifest[].count` but was decremented by parsed `shard.length`. Corrupt shard → `readShard` returns `[]` → `0 <= overflow` → remove key, `total -= 0`, `manifest.shift()`, loop keeps deleting every shard.
Fix: `captureIndex.ts:135-142` — each iteration, before the branch logic, reconcile: if `shard.length !== oldest.count`, `total += shard.length - oldest.count; oldest.count = shard.length; if (total <= MAX_INDEX) break;`. Loop then proceeds on a true total.

### BUG 3 (Important) — appendEntry didn't maintain intra-shard timestamp order
`captureIndex.ts` appendEntry — `shard.push(e)` with no sort, but `evict`'s `shard.slice(overflow)` and header comments assume front-of-shard == oldest. `migrateLegacyIfPresent` sorted; appendEntry didn't.
Fix: `captureIndex.ts:160-164` — after `shard.push(e)`, before `writeShard`: `shard.sort((a,b) => a.timestamp<b.timestamp?-1:...)`.

Also confirmed: corrupt legacy JSON in `migrateLegacyIfPresent` was already handled (`catch { legacy = []; }`) and the legacy key is removed unconditionally — regression test added to lock it.

### New regression tests (captureIndex.test.ts — now 12 cases)
- `out-of-order month appends crossing MAX_INDEX drop oldest by timestamp, not last-appended month` — appends months 03,01,02 past MAX_INDEX; asserts the 2026-01 shard is the one shrunk and 2026-03 is untouched.
- `corrupt shard during eviction does not wipe the index` — 3 shards, manifest lies about the middle (corrupt) shard's count, total > MAX_INDEX; appendEntry triggers eviction; asserts March's MAX_INDEX entries survive, Jan fully evicted, index length == MAX_INDEX (not wiped to 0).
- `out-of-order same-month appends then eviction drop the older-timestamp entry` — two Jan entries appended newest-first + Feb filled to MAX_INDEX-1; asserts the surviving Jan entry is the newer-timestamp one.
- `corrupt legacy JSON in migration → readIndex returns [] and legacy key removed` — legacy key = `"{bad json"`, readIndex returns `[]` without throwing, legacy key gone.

### Verification
```
$ npm test
 Test Files  5 passed (5)
      Tests  35 passed (35)

$ npm run build
tsc -b && vite build
✓ built in 196ms   (clean)
```
No gradle/native change — assembleDebug not re-run.
