export type TelemetryEvent = {
  type: string;
  screen?: string;
  query?: string;
  result?: string;
  resultCount?: number;
  mode?: string;
  telemetry?: string;
  package?: string;
  timestamp?: string;
};

// Matches PiecesAccessibilityService.extractText's "role|text" tagging —
// role is one of "title" | "button" | "text". Lines that don't match this
// shape (e.g. dumpsys output from the Shizuku diagnostics path, which has
// no role tagging at all) fall through untouched to the raw block.
const ROLE_LINE = /^(title|button|text)\|(.*)$/;

type ScreenStructure = {
  title: string | null;
  buttons: string[];
  text: string[];
};

function parseScreenStructure(raw: string): ScreenStructure | null {
  const lines = raw.split("\n");
  let matchedAny = false;
  const structure: ScreenStructure = { title: null, buttons: [], text: [] };

  for (const line of lines) {
    const match = ROLE_LINE.exec(line);
    if (!match) continue;
    matchedAny = true;
    const [, role, value] = match;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (role === "title" && structure.title === null) {
      structure.title = trimmed;
    } else if (role === "button") {
      structure.buttons.push(trimmed);
    } else {
      structure.text.push(trimmed);
    }
  }

  return matchedAny ? structure : null;
}

export function summarizeTelemetry(e: TelemetryEvent): string {
  if (e.type !== "system_telemetry") {
    return JSON.stringify(e, null, 2);
  }

  const packageName = e.package ?? (/^Package:\s*(\S+)/.exec(e.telemetry ?? "")?.[1] ?? null);

  const header = [
    "AndroidContext v1",
    `kind: ${e.type}`,
    `source: shizuku_or_accessibility`,
    packageName ? `package: ${packageName}` : null,
    e.timestamp ? `captured_at: ${e.timestamp}` : null,
  ].filter(Boolean).join("\n");

  const raw = e.telemetry ?? "";
  const summaryLines: string[] = [];

  // Best-effort parsing for meminfo dumpsys output (Shizuku diagnostics path
  // has no role tagging, so this stays a special case rather than folding
  // into parseScreenStructure).
  if (raw.includes("Total RAM:") && raw.includes("Free RAM:")) {
    const totalMatch = raw.match(/Total RAM:\s*(.+)/);
    const freeMatch = raw.match(/Free RAM:\s*(.+)/);
    const usedMatch = raw.match(/Used RAM:\s*(.+)/);
    if (totalMatch) summaryLines.push(`- Total RAM: ${totalMatch[1].trim()}`);
    if (usedMatch) summaryLines.push(`- Used RAM: ${usedMatch[1].trim()}`);
    if (freeMatch) summaryLines.push(`- Free RAM: ${freeMatch[1].trim()}`);

    return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
  }

  const structure = parseScreenStructure(raw);
  if (structure) {
    if (structure.title) summaryLines.push(`- Screen: ${structure.title}`);
    if (structure.buttons.length > 0) {
      // Capped and deduped — a scrollable list can repeat the same button
      // (e.g. "Like", "Reply") dozens of times; the set of distinct actions
      // available is the useful signal, not the count of each.
      const distinctButtons = [...new Set(structure.buttons)].slice(0, 20);
      summaryLines.push(`- Available actions: ${distinctButtons.join(", ")}`);
    }
    if (structure.text.length > 0) {
      summaryLines.push(`- Visible text (${structure.text.length} items):`);
      for (const line of structure.text.slice(0, 30)) {
        summaryLines.push(`  - ${line}`);
      }
    }
    if (summaryLines.length === 0) summaryLines.push("- No labeled content on screen");

    return `${header}\n\nsummary:\n${summaryLines.join("\n")}`;
  }

  // Neither meminfo nor role-tagged (e.g. an older client build, or a
  // Shizuku dumpsys command) — fall back to the raw dump rather than
  // claiming structure that isn't there.
  summaryLines.push("- Raw telemetry block captured");
  return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
}

// /connect's response identifies this proxy as an application to PiecesOS —
// static input, static output, so it's fetched once and reused for every
// seed instead of paying a round-trip on every single write. A rejected
// promise is never cached (reset to null in .catch) so one PiecesOS hiccup
// doesn't permanently break seeding — the next seed just retries /connect.
let cachedApplication: Promise<any> | null = null;

async function getApplication(piecesBaseUrl: string): Promise<any> {
  if (!cachedApplication) {
    cachedApplication = fetch(`${piecesBaseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        application: {
          name: "PiecesAndroidProxy",
          version: "0.0.1",
          platform: "DESKTOP",
        },
      }),
    }).then(async (res) => {
      if (!res.ok) throw new Error("Failed to connect to Pieces OS");
      const context = await res.json();
      return context.application;
    }).catch((err) => {
      cachedApplication = null;
      throw err;
    });
  }
  return cachedApplication;
}

export async function seedToPiecesOS(piecesBaseUrl: string, bodyText: string, title: string) {
  // 1) Identify the client application (cached — see getApplication above)
  const application = await getApplication(piecesBaseUrl);

  // 2) Create an asset
  const createRes = await fetch(`${piecesBaseUrl}/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "SEEDED_ASSET",
      asset: {
        application,
        metadata: { name: title },
        format: {
          fragment: {
            string: { raw: bodyText },
          },
        },
      },
    }),
  });

  if (!createRes.ok) throw new Error("Failed to create Asset in Pieces OS");
}

// Writes to PiecesOS's workstream-event stream — a separate store from
// assets (confirmed live: 2,495+ existing native events — calendar, IDE,
// browser activity — completely distinct from the assets list). Assets are
// good for "save this snippet" and are searchable via /qgpt/relevance, but
// they don't feed PiecesOS's own timeline/rollup generation the way
// workstream events do. Written alongside assets (not instead of), so both
// surfaces stay populated for this data.
//
// Body shape confirmed by live testing against this PiecesOS install
// (12.6.1), not just inferred from the vendored @pieces.app/pieces-os-client
// SDK — the SDK's `seededWorkstreamEvent` wrapper key does NOT work against
// the real server; the body must be flat: { application, trigger, readable }.
export async function seedWorkstreamEvent(piecesBaseUrl: string, readable: string) {
  const application = await getApplication(piecesBaseUrl);

  const res = await fetch(`${piecesBaseUrl}/workstream_events/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      application,
      // checkIn matches this data's actual semantics best: a periodic
      // "this app was in the foreground, here's what was on screen" signal,
      // not a discrete copy/paste/tab-switch/file-open action.
      trigger: { checkIn: true },
      readable,
    }),
  });

  if (!res.ok) throw new Error("Failed to create WorkstreamEvent in Pieces OS");
}
