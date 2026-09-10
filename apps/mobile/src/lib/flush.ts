import { getProxyBaseUrl, getProxyToken } from "./config";
import { peekQueue, clearSentEvents } from "./usage";

// Best-effort batch flush of queued usage events. Never throws — telemetry
// must never surface an error to the UI or affect HomeNodeUnreachableError
// handling on the screens driving real user actions.
//
// Only ever sends a PREFIX of the queue up to (not including) the first
// untriaged background capture — never the whole queue unconditionally.
// This is what actually keeps raw captured screen text off the wire: every
// screen in the app calls this directly (Setup/Ask/Recent/Status, plus
// App.tsx's interval) to flush its own screen_view/ask/setup_saved events
// promptly, and none of them should have to know or care whether a
// passive-capture triage pass has run. triageQueue.ts (the only thing that
// actually triages) still calls this too, after rewriting entries — by then
// there's no untriaged prefix left to stop at, so it flushes everything
// that's ready.

let isFlushing = false;

export async function flushUsageEvents(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    let sendCount = events.length;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === "system_telemetry" && e.screen === "background" && e.triaged === undefined) {
        sendCount = i;
        break;
      }
    }
    if (sendCount === 0) return;
    const toSend = events.slice(0, sendCount);

    const [baseUrl, token] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
    if (!baseUrl || !token) return;

    const res = await fetch(`${baseUrl}/mobile/usage-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events: toSend }),
    });

    if (res.ok) {
      await clearSentEvents(toSend);
    }
    // Any non-2xx (including 503 home-offline) leaves the queue intact for the next flush attempt.
  } catch {
    // Network error, offline, whatever — silently retry on the next flush call.
  } finally {
    isFlushing = false;
  }
}
