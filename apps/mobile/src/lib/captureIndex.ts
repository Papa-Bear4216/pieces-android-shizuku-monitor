import { Preferences } from "@capacitor/preferences";

// Local, longer-lived store of TRIAGED capture summaries and their
// embedding vectors, powering /search. Separate from usage.ts's queue:
// that queue is flushed to the gateway and deleted (clearSentEvents), so
// without this store there'd be no on-device history to search.
//
// PRIVACY INVARIANT: only entries built from a successful on-device triage
// (triaged === true in usage.ts) are ever written here. Raw accessibility
// capture text is never embedded and never persisted to this index — the
// same guarantee flush.ts enforces on the wire.
//
// Stored in Preferences (not localStorage) for consistency with usage.ts
// and config.ts, and because Capacitor WebView IndexedDB persistence has
// historically been unreliable across Android WebView updates.

const KEY = "pieces-android:captureIndex";

// ~2000 * (100 floats as JSON ~1.5KB + ~200B metadata) ~= 3.4MB, within
// Android's practical Preferences ceiling. Eviction is oldest-first:
// append order equals time order, so slice(-MAX_INDEX) drops the oldest.
export const MAX_INDEX = 2000;

export type IndexEntry = {
  id: string; // `local:${timestamp}` — stable dedupe key
  text: string; // the triaged summary; never raw capture text
  vector: number[]; // L2-normalized, 100-dim
  timestamp: string; // ISO, copied from the source UsageEvent
  source: "local"; // server hits are never persisted here
  app_label?: string;
};

async function read(): Promise<IndexEntry[]> {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function write(entries: IndexEntry[]): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(entries) });
}

export async function appendEntry(e: IndexEntry): Promise<void> {
  const entries = await read();
  if (entries.some((x) => x.id === e.id)) return; // idempotent — triageQueue() may re-walk
  entries.push(e);
  const trimmed = entries.length > MAX_INDEX ? entries.slice(-MAX_INDEX) : entries;
  await write(trimmed);
}

export async function readIndex(): Promise<IndexEntry[]> {
  return read();
}

export async function clearIndex(): Promise<void> {
  await Preferences.remove({ key: KEY });
}
