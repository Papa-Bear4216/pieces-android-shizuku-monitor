import { registerPlugin } from "@capacitor/core";
import { recordEvent } from "./usage";
import { flushUsageEvents } from "./flush";

const AccessibilityScanner = registerPlugin<any>("AccessibilityScanner");

export type LastPassiveCapture = { pkg: string; at: string };

// Registered once from App.tsx (mounted for the app's entire lifetime), not
// from Status.tsx — a listener tied to a screen's component lifecycle only
// receives captures while that screen happens to be open, which defeats the
// entire point of "passive" mode running in the background regardless of
// which tab is visible.
let started = false;
let lastCapture: LastPassiveCapture | null = null;
const subscribers = new Set<(capture: LastPassiveCapture) => void>();

export function onPassiveCapture(cb: (capture: LastPassiveCapture) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getLastPassiveCapture(): LastPassiveCapture | null {
  return lastCapture;
}

export function startPassiveCaptureListener(): void {
  if (started) return;
  started = true;

  // Passive captures arrive here already debounced/deduped on the Java side
  // (PiecesAccessibilityService) — this forwards each one into the same
  // usage-event pipeline as a manual "Scan Screen Text" tap.
  AccessibilityScanner.addListener("passiveCapture", async (data: { package: string; textNodes: string }) => {
    const timestamp = new Date().toISOString();
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: `Package: ${data.package}\n\n${data.textNodes}`,
      timestamp,
    });
    await flushUsageEvents();
    lastCapture = { pkg: data.package, at: timestamp };
    for (const cb of subscribers) cb(lastCapture);
  });
}
