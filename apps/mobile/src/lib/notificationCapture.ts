import { registerPlugin } from "@capacitor/core";
import { recordEvent } from "./usage";

const NotificationCapture = registerPlugin<any>("NotificationCapture");

export type LastNotificationCapture = { pkg: string; appLabel: string; at: string };

// Registered once from App.tsx (app-lifetime), same reasoning as
// passiveCapture.ts: a listener tied to a screen's mount only fires while that
// screen is open, which defeats a background capture stream.
let started = false;
let lastCapture: LastNotificationCapture | null = null;
const subscribers = new Set<(c: LastNotificationCapture) => void>();

export function onNotificationCapture(cb: (c: LastNotificationCapture) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getLastNotificationCapture(): LastNotificationCapture | null {
  return lastCapture;
}

export function startNotificationCaptureListener(): void {
  if (started) return;
  started = true;

  // Captures arrive already deduped/denylist-filtered on the Java side
  // (NotificationCaptureService). Forward each into the same untriaged
  // usage-event pipeline as passive screen captures — triageQueue() runs
  // the on-device summarization pass later (the only time AICore works),
  // and is the only thing that flushes. Nothing leaves the device from here.
  NotificationCapture.addListener(
    "notification",
    async (data: { package: string; appLabel: string; title: string; text: string; postedAt: number }) => {
      const timestamp = data.postedAt
        ? new Date(data.postedAt).toISOString()
        : new Date().toISOString();

      const titleLine = data.title ? `TITLE: ${data.title}\n` : "";
      await recordEvent({
        type: "system_telemetry",
        screen: "background",
        // Prefix parsed by apps/proxy/src/seeder.ts summarizeTelemetry.
        telemetry: `Notification from ${data.appLabel} (${data.package})\n${titleLine}${data.text}`,
        package: data.package,
        app_label: data.appLabel,
        timestamp,
      });

      lastCapture = { pkg: data.package, appLabel: data.appLabel, at: timestamp };
      for (const cb of subscribers) cb(lastCapture);
    }
  );
}

// --- Setup-screen helpers -------------------------------------------------

export async function isNotificationListenerGranted(): Promise<boolean> {
  try {
    const { enabled } = await NotificationCapture.isListenerEnabled();
    return !!enabled;
  } catch {
    return false;
  }
}

export async function getNotificationCaptureConfig(): Promise<{ enabled: boolean; allApps: boolean }> {
  try {
    const r = await NotificationCapture.getCaptureConfig();
    return { enabled: !!r.enabled, allApps: !!r.allApps };
  } catch {
    return { enabled: false, allApps: false };
  }
}

export async function setNotificationCapture(enabled: boolean, allApps?: boolean): Promise<void> {
  await NotificationCapture.setCaptureEnabled({ enabled, ...(allApps !== undefined ? { allApps } : {}) });
}

/** Grant the listener via Shizuku. Throws with the native reject message on failure. */
export async function grantNotificationListenerViaShizuku(): Promise<void> {
  await NotificationCapture.enableViaShizuku();
}

export async function openNotificationListenerSettings(): Promise<void> {
  await NotificationCapture.openSettings();
}
