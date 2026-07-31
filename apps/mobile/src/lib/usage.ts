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
  | { type: "system_telemetry"; screen: "background"; telemetry: string; timestamp: string };

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

/** Removes exactly the given events from the front of the queue — only call after a confirmed 2xx report. */
export async function clearSentEvents(sentCount: number): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.slice(sentCount));
}

export function classifyMode(baseUrl: string): "lan" | "remote" {
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl) ? "lan" : "remote";
}
