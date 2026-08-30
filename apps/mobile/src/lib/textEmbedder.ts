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
