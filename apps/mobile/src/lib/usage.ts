import { Preferences } from "@capacitor/preferences";

// Local queue of usage events, flushed to /mobile/usage-report by flush.ts.
// Stored in Preferences (not localStorage) for consistency with config.ts,
// and because these events can contain real query/question text — the user
// explicitly chose full detail over anonymized/aggregated tracking.

const QUEUE_KEY = "pieces-android:usageQueue";
const MAX_QUEUE_SIZE = 500; // backstop against unbounded growth if flush stays broken for a long time

export type UsageEvent =
  | { type: "ask"; screen: "ask"; query: string; result: "answered" | "unavailable" | "error"; timestamp: string }
  | { type: "search"; screen: "recent"; query: string; resultCount: number; mode: "relevant" | "text" | "text-fallback"; timestamp: string }
  | { type: "screen_view"; screen: "setup" | "status" | "recent" | "ask"; timestamp: string }
  | { type: "setup_saved"; screen: "setup"; mode: "lan" | "remote"; timestamp: string }
  | {
      type: "system_telemetry";
      screen: "background";
      telemetry: string;
      package?: string;
      app_label?: string;
      timestamp: string;
      // Set once triageQueue() has attempted this entry — true if it holds
      // an on-device summary, false if triage ran but fell back to raw
      // text. Undefined means "not yet triaged" (the state every passive
      // capture starts in — see passiveCapture.ts, which deliberately does
      // NOT call tryOnDeviceTriage inline anymore since AICore only permits
      // inference while this app is foreground, never true during a real
      // background capture). triageQueue() is the only writer of this field.
      triaged?: boolean;
    };

async function readQueue(): Promise<UsageEvent[]> {
  const { value } = await Preferences.get({ key: QUEUE_KEY });
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

async function writeQueue(events: UsageEvent[]): Promise<void> {
  await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(events) });
}

export async function recordEvent(event: UsageEvent): Promise<void> {
  const queue = await readQueue();
  queue.push(event);
  if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  await writeQueue(queue);
}

export async function peekQueue(): Promise<UsageEvent[]> {
  return readQueue();
}

// Overwrites the whole queue in place — for triageQueue() rewriting
// individual system_telemetry entries with on-device summaries without
// changing queue order or length (clearSentEvents' front-slice assumption
// depends on order staying stable between peek and clear).
export async function replaceQueue(events: UsageEvent[]): Promise<void> {
  await writeQueue(events);
}

/** Removes exactly the given events from the front of the queue — only call after a confirmed 2xx report. */
export async function clearSentEvents(sentCount: number): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.slice(sentCount));
}

export function classifyMode(baseUrl: string): "lan" | "remote" {
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl) ? "lan" : "remote";
}
