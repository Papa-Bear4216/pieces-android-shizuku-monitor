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
