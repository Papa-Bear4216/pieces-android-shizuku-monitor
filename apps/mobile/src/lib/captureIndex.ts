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
//
// STORAGE LAYOUT: month shards, not one blob. Previously the whole index
// was a single ~3.4 MB JSON blob under `pieces-android:captureIndex`, so
// every appendEntry read+parsed+stringified+wrote all of it and every
// debounced keystroke in Search re-parsed the lot. Now each calendar
// month lives in its own shard:
//
//   pieces-android:captureIndex:YYYY-MM   -> IndexEntry[]  (insertion order == ascending timestamp)
//   pieces-android:captureIndex:months    -> { month: string; count: number }[]  (sorted ascending by month)
//
// The manifest's per-shard `count` is authoritative because appendEntry
// and its eviction are the ONLY writers of shard contents — every path
// that mutates a shard updates its count in the same operation. This lets
// eviction compute the global total in O(1) without reading every shard.

const LEGACY_KEY = "pieces-android:captureIndex";
const MANIFEST_KEY = "pieces-android:captureIndex:months";
const shardKey = (month: string) => `pieces-android:captureIndex:${month}`;

// ~2000 * (100 floats as JSON ~1.5KB + ~200B metadata) ~= 3.4MB, within
// Android's practical Preferences ceiling. Eviction is oldest-first:
// entries within a shard are in insertion (== time) order and shards are
// month-granular, so dropping from the front of the oldest shard drops
// the oldest entries.
export const MAX_INDEX = 2000;

export type IndexEntry = {
  id: string; // `local:${timestamp}` — stable dedupe key
  text: string; // the triaged summary; never raw capture text
  vector: number[]; // L2-normalized, 100-dim
  timestamp: string; // ISO, copied from the source UsageEvent
  source: "local"; // server hits are never persisted here
  app_label?: string;
};

type ManifestShard = { month: string; count: number };

const monthOf = (timestamp: string) => timestamp.slice(0, 7);

async function readManifest(): Promise<ManifestShard[]> {
  const { value } = await Preferences.get({ key: MANIFEST_KEY });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ManifestShard =>
        s && typeof s.month === "string" && typeof s.count === "number",
    );
  } catch {
    return [];
  }
}

async function writeManifest(manifest: ManifestShard[]): Promise<void> {
  manifest.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  await Preferences.set({ key: MANIFEST_KEY, value: JSON.stringify(manifest) });
}

async function readShard(month: string): Promise<IndexEntry[]> {
  const { value } = await Preferences.get({ key: shardKey(month) });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt shard → treated as empty, same tolerance as before
  }
}

async function writeShard(month: string, entries: IndexEntry[]): Promise<void> {
  await Preferences.set({ key: shardKey(month), value: JSON.stringify(entries) });
}

// One-time migration from the legacy single-blob key. The legacy key's
// absence is the "already migrated" signal. Distributes legacy entries
// into month shards, rebuilds the manifest, then removes the legacy key.
async function migrateLegacyIfPresent(): Promise<void> {
  const { value } = await Preferences.get({ key: LEGACY_KEY });
  if (!value) return;

  let legacy: IndexEntry[] = [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) legacy = parsed;
  } catch {
    legacy = [];
  }

  const byMonth = new Map<string, IndexEntry[]>();
  for (const e of legacy) {
    const m = monthOf(e.timestamp);
    const bucket = byMonth.get(m) ?? [];
    if (!bucket.some((x) => x.id === e.id)) bucket.push(e);
    byMonth.set(m, bucket);
  }

  const existing = await readManifest();
  const manifest = new Map(existing.map((s) => [s.month, s.count]));
  for (const [month, entries] of byMonth) {
    const current = await readShard(month);
    for (const e of entries) {
      if (!current.some((x) => x.id === e.id)) current.push(e);
    }
    current.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    await writeShard(month, current);
    manifest.set(month, current.length);
  }

  await writeManifest([...manifest].map(([month, count]) => ({ month, count })));
  await Preferences.remove({ key: LEGACY_KEY });
}

// Enforce the global MAX_INDEX cap by dropping entries from the front of
// the oldest shard(s). `manifest` is mutated in place and persisted by
// the caller.
async function evict(manifest: ManifestShard[]): Promise<void> {
  let total = manifest.reduce((n, s) => n + s.count, 0);
  while (total > MAX_INDEX && manifest.length > 0) {
    const oldest = manifest[0];
    const overflow = total - MAX_INDEX;
    const shard = await readShard(oldest.month);
    if (shard.length <= overflow) {
      // whole shard goes
      await Preferences.remove({ key: shardKey(oldest.month) });
      total -= shard.length;
      manifest.shift();
    } else {
      const kept = shard.slice(overflow);
      await writeShard(oldest.month, kept);
      total -= shard.length - kept.length;
      oldest.count = kept.length;
    }
  }
}

export async function appendEntry(e: IndexEntry): Promise<void> {
  await migrateLegacyIfPresent();

  const month = monthOf(e.timestamp);
  const manifest = await readManifest();

  const shard = await readShard(month);
  if (shard.some((x) => x.id === e.id)) return; // idempotent — triageQueue() may re-walk
  shard.push(e);
  await writeShard(month, shard);

  const idx = manifest.findIndex((s) => s.month === month);
  if (idx === -1) manifest.push({ month, count: shard.length });
  else manifest[idx].count = shard.length;

  await evict(manifest);
  await writeManifest(manifest);
}

export async function readIndex(): Promise<IndexEntry[]> {
  let manifest = await readManifest();
  if (manifest.length === 0) {
    await migrateLegacyIfPresent();
    manifest = await readManifest();
  }

  // newest month → oldest, until we have >= MAX_INDEX entries
  const collected: IndexEntry[] = [];
  for (let i = manifest.length - 1; i >= 0; i--) {
    const shard = await readShard(manifest[i].month);
    collected.push(...shard);
    if (collected.length >= MAX_INDEX) break;
  }

  collected.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return collected.length > MAX_INDEX ? collected.slice(-MAX_INDEX) : collected;
}

export async function clearIndex(): Promise<void> {
  const manifest = await readManifest();
  for (const s of manifest) {
    await Preferences.remove({ key: shardKey(s.month) });
  }
  await Preferences.remove({ key: MANIFEST_KEY });
  await Preferences.remove({ key: LEGACY_KEY }); // in case clear is called pre-migration
}
