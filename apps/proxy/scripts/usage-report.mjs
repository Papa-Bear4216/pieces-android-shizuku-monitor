#!/usr/bin/env node
// Reads the usage log (JSONL, one event per line) written by the proxy's
// /mobile/usage-report endpoint and prints a human-readable summary.
//
// Usage: node scripts/usage-report.mjs [path-to-log] [--days N]
//
// Same USAGE_LOG_PATH default as apps/proxy/src/server.ts so running this
// with no arguments reads the live log.

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const daysFlagIndex = args.indexOf("--days");
const days = daysFlagIndex !== -1 ? Number(args[daysFlagIndex + 1]) : null;
const explicitPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--days");

const LOG_PATH =
  explicitPath ?? process.env.USAGE_LOG_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-usage-log.jsonl`;

function parseEvents(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines rather than aborting the whole report
    }
  }
  return events;
}

function withinWindow(event, cutoff) {
  if (!cutoff) return true;
  const t = new Date(event.timestamp).getTime();
  return !Number.isNaN(t) && t >= cutoff;
}

function main(raw) {
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  const events = parseEvents(raw).filter((e) => withinWindow(e, cutoff));

  if (events.length === 0) {
    console.log("No usage events" + (days ? ` in the last ${days} day(s).` : "."));
    return;
  }

  const screenCounts = {};
  const asks = [];
  const searches = [];
  const setupSaves = [];

  for (const e of events) {
    screenCounts[e.screen] = (screenCounts[e.screen] ?? 0) + 1;
    if (e.type === "ask") asks.push(e);
    if (e.type === "search") searches.push(e);
    if (e.type === "setup_saved") setupSaves.push(e);
  }

  const askOutcomes = asks.reduce((acc, a) => {
    acc[a.result] = (acc[a.result] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Usage report${days ? ` (last ${days} day${days === 1 ? "" : "s"})` : ""}`);
  console.log(`${events.length} total event(s)\n`);

  console.log("Screen visits:");
  for (const [screen, count] of Object.entries(screenCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${screen}: ${count}`);
  }

  console.log(`\nAsk: ${asks.length} question(s) asked`);
  if (asks.length > 0) {
    for (const [outcome, count] of Object.entries(askOutcomes)) {
      console.log(`  ${outcome}: ${count}`);
    }
    if (askOutcomes.unavailable === asks.length) {
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
  const raw = await readFile(LOG_PATH, "utf-8");
  main(raw);
} catch (err) {
  if (err.code === "ENOENT") {
    console.log(`No usage log found at ${LOG_PATH} yet.`);
  } else {
    throw err;
  }
}
