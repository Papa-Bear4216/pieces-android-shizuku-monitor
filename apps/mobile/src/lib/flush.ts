import { getConnectionTargets } from "./config";
import { peekQueue, clearSentEvents } from "./usage";

// Best-effort batch flush of queued usage events with auto-failover.
// Tries LAN proxy first; if disconnected/away from home, falls back to remote gateway.
export async function flushUsageEvents(): Promise<void> {
  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    const targets = await getConnectionTargets();
    if (targets.length === 0) return;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const timeoutMs = targets.length > 1 && i === 0 && target.mode === "lan" ? 2500 : 8000;

      try {
        const res = await fetch(`${target.baseUrl}/mobile/usage-report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.token}`,
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          await clearSentEvents(events.length);
          return;
        }
      } catch {
        // Fall back to next target (e.g. Plan B gateway)
      }
    }
  } catch {
    // Network error, offline, whatever — silently retry on the next flush call.
  }
}
