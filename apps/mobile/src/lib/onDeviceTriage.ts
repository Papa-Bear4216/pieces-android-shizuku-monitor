import { Capacitor, registerPlugin } from "@capacitor/core";

const OnDeviceTriage = registerPlugin<any>("OnDeviceTriage");

export type TriageResult = { ok: true; summary: string; category: string } | { ok: false };

// Mirrors bear-house-classic's src/lib/onDeviceVision.ts tryOnDeviceVision
// pattern: every failure path (not native, feature unavailable, download
// needed, inference threw, malformed response) collapses to the same
// { ok: false } shape. Callers never branch on *why* triage didn't run —
// they just fall back to sending the raw captured text, exactly as before
// this existed.
export async function tryOnDeviceTriage(appLabel: string, text: string): Promise<TriageResult> {
  if (!Capacitor.isNativePlatform()) return { ok: false };
  try {
    const avail = await OnDeviceTriage.checkAvailability();
    if (avail.status !== "available") return { ok: false };
    const result = await OnDeviceTriage.triage({ appLabel, text });
    if (!result.ok) return { ok: false };
    return { ok: true, summary: result.summary, category: result.category };
  } catch {
    return { ok: false };
  }
}
