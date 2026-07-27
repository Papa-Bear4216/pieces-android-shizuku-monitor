import { getProxyBaseUrl, getProxyToken } from "./config";
import { peekQueue, clearSentEvents } from "./usage";

// Best-effort batch flush of queued usage events. Never throws — telemetry
// must never surface an error to the UI or affect HomeNodeUnreachableError
// handling on the screens driving real user actions.
export async function flushUsageEvents(): Promise<void> {
  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    const [baseUrl, token] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
    if (!baseUrl || !token) return;

    const res = await fetch(`${baseUrl}/mobile/usage-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });

    if (res.ok) {
      await clearSentEvents(events.length);
    }
    // Any non-2xx (including 503 home-offline) leaves the queue intact for the next flush attempt.
  } catch {
    // Network error, offline, whatever — silently retry on the next flush call.
  }
}
