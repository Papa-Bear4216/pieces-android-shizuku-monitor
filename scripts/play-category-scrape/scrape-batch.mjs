#!/usr/bin/env node
// Pops the next BATCH_SIZE packages off queue.json, fetches each Play Store
// listing page, extracts applicationCategory from the embedded JSON-LD, and
// merges results into playCategories.json. Run as one shot per invocation —
// pacing between invocations (randomized ~54-71 min) is handled by whatever
// schedules this script, not by this script itself, so a single run never
// hammers Play in a burst.
//
// One-time local seed generation only. Nothing here runs on-device or at
// app runtime — this produces a static JSON file that ships in the repo.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(DIR, "queue.json");
const DONE_PATH = path.join(DIR, "done.json"); // packages already resolved (success or permanent fail)
const OUT_PATH = path.join(DIR, "..", "..", "apps", "mobile", "src", "data", "playCategories.json");
const LOG_PATH = path.join(DIR, "scrape.log");

// Full-sweep mode: no batch cap, just per-request spacing as politeness
// against Play. ~1100 packages * ~2.5s = ~45 min single run.
const BATCH_SIZE = Infinity;
const REQUEST_DELAY_MS = 2500;

function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(stamped);
  try {
    const prev = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf-8") : "";
    writeFileSync(LOG_PATH, prev + stamped, "utf-8");
  } catch {
    // logging is best-effort, never fatal
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extracts applicationCategory from the raw page HTML. Play doesn't emit a
// clean <script type="application/ld+json"> block for this field — it's
// inline inside a large embedded JS state blob as a literal
// `"applicationCategory":"MUSIC_AND_AUDIO"`-style string, so a direct regex
// against the raw HTML is more reliable than trying to parse it as JSON.
// Falls back to null if the page shape changes or the app isn't found — this
// is scraping an undocumented page structure, so it degrades gracefully
// rather than throwing; one bad package shouldn't kill the whole batch.
function extractCategory(html) {
  const m = html.match(/"applicationCategory"\s*:\s*"([A-Z_]+)"/);
  return m ? m[1] : null;
}

// Play's raw category enum (e.g. "MUSIC_AND_AUDIO") to a readable label
// matching the style already used by AccessibilityPlugin.categoryLabel on
// the Java side, so the two sources merge into one consistent label set.
const CATEGORY_LABELS = {
  APPLICATION: "Uncategorized",
  ART_AND_DESIGN: "Art & Design",
  AUTO_AND_VEHICLES: "Auto & Vehicles",
  BEAUTY: "Beauty",
  BOOKS_AND_REFERENCE: "Books & Reference",
  BUSINESS: "Business",
  COMICS: "Comics",
  COMMUNICATION: "Communication",
  DATING: "Dating",
  EDUCATION: "Education",
  ENTERTAINMENT: "Entertainment",
  EVENTS: "Events",
  FINANCE: "Finance",
  FOOD_AND_DRINK: "Food & Drink",
  GAME: "Game",
  GAME_ACTION: "Game",
  GAME_ADVENTURE: "Game",
  GAME_ARCADE: "Game",
  GAME_BOARD: "Game",
  GAME_CARD: "Game",
  GAME_CASINO: "Game",
  GAME_CASUAL: "Game",
  GAME_EDUCATIONAL: "Game",
  GAME_MUSIC: "Game",
  GAME_PUZZLE: "Game",
  GAME_RACING: "Game",
  GAME_ROLE_PLAYING: "Game",
  GAME_SIMULATION: "Game",
  GAME_SPORTS: "Game",
  GAME_STRATEGY: "Game",
  GAME_TRIVIA: "Game",
  GAME_WORD: "Game",
  HEALTH_AND_FITNESS: "Health & Fitness",
  HOUSE_AND_HOME: "House & Home",
  LIBRARIES_AND_DEMO: "Libraries & Demo",
  LIFESTYLE: "Lifestyle",
  MAPS_AND_NAVIGATION: "Maps & Navigation",
  MEDICAL: "Medical",
  MUSIC_AND_AUDIO: "Audio",
  NEWS_AND_MAGAZINES: "News",
  PARENTING: "Parenting",
  PERSONALIZATION: "Personalization",
  PHOTOGRAPHY: "Image",
  PRODUCTIVITY: "Productivity",
  SHOPPING: "Shopping",
  SOCIAL: "Social",
  SPORTS: "Sports",
  TOOLS: "Tools",
  TRAVEL_AND_LOCAL: "Travel & Local",
  VIDEO_PLAYERS: "Video",
  WEATHER: "Weather",
};

function labelForCategory(rawCategory) {
  return CATEGORY_LABELS[rawCategory] || rawCategory;
}

async function fetchCategory(pkg) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "http_error", code: res.status };
  const html = await res.text();
  const category = extractCategory(html);
  if (!category) return { status: "no_category_found" };
  return { status: "ok", category };
}

async function main() {
  const queue = loadJson(QUEUE_PATH, []);
  const done = loadJson(DONE_PATH, {});
  const results = loadJson(OUT_PATH, {});

  // Skip anything already resolved in a prior run (success or permanent fail)
  // rather than re-fetching — done.json is the checkpoint that makes this
  // resumable across the randomized-interval invocations.
  const remaining = queue.filter((p) => !(p in done));
  if (remaining.length === 0) {
    log("Queue empty — nothing left to scrape.");
    return;
  }

  const batch = remaining.slice(0, BATCH_SIZE);
  log(`Starting batch of ${batch.length} (${remaining.length} remaining before this batch).`);

  // Flush to disk every FLUSH_EVERY packages, not just once at the end — a
  // full sweep runs 30-45+ min unattended, and losing everything to a crash
  // near the end (network blip, process kill) would mean re-fetching
  // hundreds of already-successful requests for no reason.
  const FLUSH_EVERY = 25;
  let sinceFlush = 0;

  for (const pkg of batch) {
    try {
      const result = await fetchCategory(pkg);
      done[pkg] = result.status;
      if (result.status === "ok") {
        results[pkg] = labelForCategory(result.category);
        log(`  ${pkg} -> ${result.category} (${results[pkg]})`);
      } else {
        log(`  ${pkg} -> ${result.status}`);
      }
    } catch (err) {
      done[pkg] = "fetch_error";
      log(`  ${pkg} -> fetch_error: ${err.message}`);
    }
    sinceFlush++;
    if (sinceFlush >= FLUSH_EVERY) {
      writeFileSync(DONE_PATH, JSON.stringify(done, null, 2), "utf-8");
      writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf-8");
      sinceFlush = 0;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  writeFileSync(DONE_PATH, JSON.stringify(done, null, 2), "utf-8");
  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf-8");

  const remainingAfter = queue.filter((p) => !(p in done)).length;
  log(`Batch complete. ${remainingAfter} packages left in queue.`);
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
