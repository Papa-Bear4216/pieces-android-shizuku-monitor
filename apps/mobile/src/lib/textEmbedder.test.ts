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
