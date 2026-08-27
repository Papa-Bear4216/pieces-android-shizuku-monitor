#!/usr/bin/env node
// Reads the usage log (JSONL, one event per line) written by the proxy's
// /mobile/usage-report endpoint and prints a human-readable summary.
//
// Usage: node scripts/usage-report.mjs [path-to-log] [--days N]
//
// Same USAGE_LOG_PATH default as apps/proxy/src/server.ts so running this
// with no arguments reads the live log.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const daysFlagIndex = args.indexOf("--days");
const days = daysFlagIndex !== -1 ? Number(args[daysFlagIndex + 1]) : null;
const explicitPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--days");

const LOG_PATH =
  explicitPath ?? process.env.USAGE_LOG_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-usage-log.jsonl`;

async function processLog() {
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  let eventCount = 0;
  const screenCounts = new Map();
  const askOutcomes = new Map();
  const asks = [];
  const searches = [];
  const setupSaves = [];
  const maxDetailedEvents = 100;

  const stream = createReadStream(LOG_PATH, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (cutoff) {
      const t = new Date(event.timestamp).getTime();
      if (isNaN(t) || t < cutoff) continue;
    }

    eventCount++;

    if (event.screen) {
      screenCounts.set(event.screen, (screenCounts.get(event.screen) || 0) + 1);
    }

    if (event.type === "ask") {
      askOutcomes.set(event.result, (askOutcomes.get(event.result) || 0) + 1);
      if (asks.length < maxDetailedEvents) {
        asks.push({ timestamp: event.timestamp, query: event.query, result: event.result });
      }
    } else if (event.type === "search") {
      if (searches.length < maxDetailedEvents) {
        searches.push({ timestamp: event.timestamp, query: event.query, resultCount: event.resultCount });
      }
    } else if (event.type === "setup_saved") {
      if (setupSaves.length < maxDetailedEvents) {
        setupSaves.push({ timestamp: event.timestamp, mode: event.mode });
      }
    }
  }

  if (eventCount === 0) {
    console.log("No usage events" + (days ? ` in the last ${days} day(s).` : "."));
    return;
  }

  console.log(`Usage report${days ? ` (last ${days} day${days === 1 ? "" : "s"})` : ""}`);
  console.log(`${eventCount} total event(s)\n`);

  console.log("Screen visits:");
  const sortedScreens = Array.from(screenCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [screen, count] of sortedScreens) {
    console.log(`  ${screen}: ${count}`);
  }

  console.log(`\nAsk: ${askOutcomes.size ? Array.from(askOutcomes.values()).reduce((sum, count) => sum + count, 0) : 0} question(s) asked`);
  if (askOutcomes.size > 0) {
    for (const [outcome, count] of askOutcomes.entries()) {
      console.log(`  ${outcome}: ${count}`);
    }
    if (askOutcomes.get("unavailable") === askOutcomes.size) {
      console.log("  Note: every Ask call returned 'unavailable' — this is the known PiecesOS QGPT issue, not a client bug.");
    }
    console.log("  Questions asked:");
    for (const a of asks) {
      console.log(`    [${a.timestamp}] (${a.result}) ${a.query}`);
    }
  }

  console.log(`\nSearch: ${searches.length} search(es)`);
  for (const s of searches) {
    console.log(`    [${s.timestamp}] "${s.query}" → ${s.resultCount} result(s)`);
  }

  if (setupSaves.length > 0) {
    console.log(`\nSetup saved ${setupSaves.length} time(s):`);
    for (const s of setupSaves) {
      console.log(`    [${s.timestamp}] mode=${s.mode}`);
    }
  }
}

try {
  await processLog();
} catch (err) {
  if (err.code === "ENOENT") {
    console.log(`No usage log found at ${LOG_PATH} yet.`);
  } else {
    throw err;
  }
}
