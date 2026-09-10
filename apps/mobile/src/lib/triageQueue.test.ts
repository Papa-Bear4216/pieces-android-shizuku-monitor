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
