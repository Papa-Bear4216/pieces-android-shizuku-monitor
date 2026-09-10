import { beforeEach, describe, expect, test, vi } from "vitest";
import { Preferences } from "@capacitor/preferences";
// @ts-expect-error — test-only export from the setup mock
import { __store } from "@capacitor/preferences";
import { appendEntry, readIndex, clearIndex, MAX_INDEX, type IndexEntry } from "./captureIndex";

const LEGACY_KEY = "pieces-android:captureIndex";
const MANIFEST_KEY = "pieces-android:captureIndex:months";
const shardKey = (month: string) => `pieces-android:captureIndex:${month}`;

const store = __store as Map<string, string>;

function entry(ts: string): IndexEntry {
  return { id: `local:${ts}`, text: `summary ${ts}`, vector: [0.1, 0.2], timestamp: ts, source: "local" };
}

beforeEach(() => {
  store.clear();
  vi.mocked(Preferences.set).mockClear();
});

describe("captureIndex", () => {
  test("appendEntry then readIndex returns the entry", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    const index = await readIndex();
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe("local:2026-01-01T00:00:00Z");
  });

  test("appendEntry is idempotent on duplicate id (same month)", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    expect(await readIndex()).toHaveLength(1);
  });

  test("entries across multiple months all show up, ascending by timestamp", async () => {
    await appendEntry(entry("2026-03-15T00:00:00Z"));
    await appendEntry(entry("2026-01-05T00:00:00Z"));
    await appendEntry(entry("2026-02-20T00:00:00Z"));
    const index = await readIndex();
    expect(index.map((e) => e.timestamp)).toEqual([
      "2026-01-05T00:00:00Z",
      "2026-02-20T00:00:00Z",
      "2026-03-15T00:00:00Z",
    ]);
  });

  test("eviction: appending past MAX_INDEX drops oldest, empties old shards, prunes manifest", async () => {
    // Small first month that must be fully drained by eviction.
    for (let i = 0; i < 3; i++) {
      await appendEntry(entry(`2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    }
    // Remaining MAX_INDEX + 2 spread across Feb/Mar so total overflows by 5,
    // fully draining the 3-entry January shard plus 2 more from February.
    const extra = MAX_INDEX + 2;
    for (let i = 0; i < extra; i++) {
      const month = i < extra / 2 ? "02" : "03";
      const day = String((i % 27) + 1).padStart(2, "0");
      const sec = String(i % 60).padStart(2, "0");
      await appendEntry(entry(`2026-${month}-${day}T00:00:${sec}.${String(i).padStart(3, "0")}Z`));
    }

    const index = await readIndex();
    expect(index).toHaveLength(MAX_INDEX);
    // The 3 January entries and the 2 oldest February entries were dropped.
    expect(index.some((e) => e.timestamp.startsWith("2026-01"))).toBe(false);

    const manifest = JSON.parse(store.get(MANIFEST_KEY)!) as { month: string; count: number }[];
    expect(manifest.some((s) => s.month === "2026-01")).toBe(false);
    expect(store.get(shardKey("2026-01"))).toBeUndefined();
    expect(manifest.reduce((n, s) => n + s.count, 0)).toBe(MAX_INDEX);
  });

  test("corrupt shard blob → that shard treated as empty, others still returned", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    await appendEntry(entry("2026-02-01T00:00:00Z"));
    store.set(shardKey("2026-02"), "{not json");
    const index = await readIndex();
    expect(index.map((e) => e.timestamp)).toEqual(["2026-01-01T00:00:00Z"]);
  });

  test("clearIndex removes all shards + manifest + legacy key", async () => {
    await appendEntry(entry("2026-01-01T00:00:00Z"));
    await appendEntry(entry("2026-02-01T00:00:00Z"));
    store.set(LEGACY_KEY, "[]");
    await clearIndex();
    expect(await readIndex()).toEqual([]);
    expect(store.get(MANIFEST_KEY)).toBeUndefined();
    expect(store.get(shardKey("2026-01"))).toBeUndefined();
    expect(store.get(shardKey("2026-02"))).toBeUndefined();
    expect(store.get(LEGACY_KEY)).toBeUndefined();
  });

  test("migration: legacy blob is distributed into shards and the legacy key removed", async () => {
    const legacy = [entry("2026-01-10T00:00:00Z"), entry("2026-02-11T00:00:00Z")];
    store.set(LEGACY_KEY, JSON.stringify(legacy));

    const index = await readIndex();
    expect(index.map((e) => e.timestamp)).toEqual([
      "2026-01-10T00:00:00Z",
      "2026-02-11T00:00:00Z",
    ]);
    expect(store.get(LEGACY_KEY)).toBeUndefined();
    const manifest = JSON.parse(store.get(MANIFEST_KEY)!) as { month: string }[];
    expect(manifest.map((s) => s.month).sort()).toEqual(["2026-01", "2026-02"]);
  });

  test("out-of-order month appends crossing MAX_INDEX drop oldest by timestamp, not last-appended month", async () => {
    // Append in month order 03, 01, 02; enough to exceed MAX_INDEX by 4.
    const perMonth = Math.ceil((MAX_INDEX + 4) / 3);
    for (const month of ["03", "01", "02"]) {
      for (let i = 0; i < perMonth; i++) {
        const day = String((i % 27) + 1).padStart(2, "0");
        const sec = String(i % 60).padStart(2, "0");
        await appendEntry(entry(`2026-${month}-${day}T00:00:${sec}.${String(i).padStart(3, "0")}Z`));
      }
    }
    const index = await readIndex();
    expect(index).toHaveLength(MAX_INDEX);
    // Dropped entries are the oldest by timestamp → from 2026-01, not 2026-03.
    const jan = JSON.parse(store.get(shardKey("2026-01"))!) as IndexEntry[];
    expect(jan.length).toBeLessThan(perMonth); // Jan shard shrank
    expect(store.get(shardKey("2026-03"))!.length).toBeGreaterThan(0);
    const marCount = (JSON.parse(store.get(shardKey("2026-03"))!) as IndexEntry[]).length;
    expect(marCount).toBe(perMonth); // March untouched
  });

  test("corrupt shard during eviction does not wipe the index", async () => {
    // Jan small so eviction must walk PAST it to the corrupt Feb shard.
    const manifest = [
      { month: "2026-01", count: 3 },
      { month: "2026-02", count: 5 }, // manifest lies — shard is corrupt (real 0)
      { month: "2026-03", count: MAX_INDEX },
    ];
    store.set(MANIFEST_KEY, JSON.stringify(manifest));
    store.set(
      shardKey("2026-01"),
      JSON.stringify(
        Array.from({ length: 3 }, (_, i) => entry(`2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`)),
      ),
    );
    store.set(shardKey("2026-02"), "{corrupt"); // middle shard corrupt
    store.set(
      shardKey("2026-03"),
      JSON.stringify(
        Array.from({ length: MAX_INDEX }, (_, i) =>
          entry(`2026-03-01T00:00:00.${String(i).padStart(4, "0")}Z`),
        ),
      ),
    );

    // total per (lying) manifest = MAX_INDEX + 8 → eviction fires, hits Feb
    await appendEntry(entry("2026-03-15T12:00:00.000Z"));

    const index = await readIndex();
    // Not wiped: eviction drops the 3 Jan entries, self-heals on corrupt Feb,
    // and stops — the MAX_INDEX March entries survive intact.
    expect(index.some((e) => e.timestamp.startsWith("2026-03"))).toBe(true);
    expect(index.some((e) => e.timestamp.startsWith("2026-01"))).toBe(false); // Jan fully evicted
    expect(index.length).toBe(MAX_INDEX);
    expect(store.get(shardKey("2026-03"))).toBeDefined();
    expect((JSON.parse(store.get(shardKey("2026-03"))!) as IndexEntry[]).length).toBeGreaterThanOrEqual(
      MAX_INDEX - 1,
    );
  });

  test("out-of-order same-month appends then eviction drop the older-timestamp entry", async () => {
    // Fill Feb to MAX_INDEX - 1.
    for (let i = 0; i < MAX_INDEX - 1; i++) {
      await appendEntry(entry(`2026-02-01T00:00:00.${String(i).padStart(4, "0")}Z`));
    }
    // Two Jan entries appended newest-first; one must be dropped (total = MAX_INDEX + 1).
    await appendEntry(entry("2026-01-01T00:00:09.000Z")); // newer
    await appendEntry(entry("2026-01-01T00:00:01.000Z")); // older

    const index = await readIndex();
    expect(index).toHaveLength(MAX_INDEX);
    const janLeft = index.filter((e) => e.timestamp.startsWith("2026-01"));
    expect(janLeft).toHaveLength(1);
    expect(janLeft[0].timestamp).toBe("2026-01-01T00:00:09.000Z"); // older one dropped
  });

  test("corrupt legacy JSON in migration → readIndex returns [] and legacy key removed", async () => {
    store.set(LEGACY_KEY, "{bad json");
    expect(await readIndex()).toEqual([]);
    expect(store.get(LEGACY_KEY)).toBeUndefined();
  });

  test("append does NOT rewrite unrelated months' shards", async () => {
    await appendEntry(entry("2026-01-15T00:00:00Z"));
    await appendEntry(entry("2026-03-15T00:00:00Z"));

    vi.mocked(Preferences.set).mockClear();
    await appendEntry(entry("2026-03-16T00:00:00Z")); // append into March

    const shardWrites = vi.mocked(Preferences.set).mock.calls
      .map((c) => c[0].key)
      .filter((k) => k.startsWith("pieces-android:captureIndex:") && k !== MANIFEST_KEY);
    expect(shardWrites).toEqual([shardKey("2026-03")]);
    expect(shardWrites).not.toContain(shardKey("2026-01"));
  });
});
