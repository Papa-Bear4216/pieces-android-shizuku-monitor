export type TelemetryEvent = {
  type: string;
  screen?: string;
  query?: string;
  result?: string;
  resultCount?: number;
  mode?: string;
  telemetry?: string;
  timestamp?: string;
};

export function summarizeTelemetry(e: TelemetryEvent): string {
  if (e.type !== "system_telemetry") {
    return JSON.stringify(e, null, 2);
  }

  const header = [
    "AndroidContext v1",
    `kind: ${e.type}`,
    `source: shizuku_or_accessibility`,
    e.timestamp ? `captured_at: ${e.timestamp}` : null,
  ].filter(Boolean).join("\n");

  const summaryLines: string[] = [];
  const raw = e.telemetry ?? "";

  // Best effort parsing for meminfo
  if (raw.includes("Total RAM:") && raw.includes("Free RAM:")) {
    const totalMatch = raw.match(/Total RAM:\s*(.+)/);
    const freeMatch = raw.match(/Free RAM:\s*(.+)/);
    const usedMatch = raw.match(/Used RAM:\s*(.+)/);
    if (totalMatch) summaryLines.push(`- Total RAM: ${totalMatch[1].trim()}`);
    if (usedMatch) summaryLines.push(`- Used RAM: ${usedMatch[1].trim()}`);
    if (freeMatch) summaryLines.push(`- Free RAM: ${freeMatch[1].trim()}`);
  } else {
    summaryLines.push("- Raw telemetry block captured");
  }

  return `${header}\n\nsummary:\n${summaryLines.join("\n")}\n\nraw:\n${raw}`;
}

export async function seedToPiecesOS(piecesBaseUrl: string, bodyText: string, title: string) {
  // 1) Identify the client application
  const appRes = await fetch(`${piecesBaseUrl}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      application: {
        name: "PiecesAndroidProxy",
        version: "0.0.1",
        platform: "DESKTOP",
      },
    }),
  });
  
  if (!appRes.ok) throw new Error("Failed to connect to Pieces OS");
  const context = await appRes.json();
  const application = context.application;

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
