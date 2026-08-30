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
