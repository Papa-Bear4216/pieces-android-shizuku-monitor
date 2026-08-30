#!/usr/bin/env node
// Diffs AccessibilityPlugin.java's EXCLUDED_PREFIXES / EXCLUDED_NOISE_PREFIXES
// against a real connected device's installed package list, flagging any
// prefix that matches zero real packages — the exact class of bug found
// 2026-08-30 (Wells Fargo's real package, com.wf.wellsfargomobile, didn't
// match the hardcoded guess "com.wellsfargo").
//
// Parses the prefix lists directly out of the Java source (not a hand-kept
// copy here) so this audit can never silently drift out of sync with the
// actual enforced list.
//
// Usage: node audit-exclusions.mjs [--device <adb-serial>]
//
// Requires: adb on PATH, one connected/authorized device (or pass --device).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(
  DIR, "..", "..", "apps", "mobile", "android", "app", "src", "main", "java",
  "com", "pieces", "android", "companion", "AccessibilityPlugin.java"
);

function parseArgs(argv) {
  const out = { device: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--device" && argv[i + 1]) {
      out.device = argv[++i];
    }
  }
  return out;
}

// Extracts a Java List.of(...)/Arrays.asList(...) block by the variable name
// it's assigned to, then pulls every quoted string literal out of it. Skips
// commented-out lines to avoid the // annotations sprinkled through the list
// (e.g. "com.chase" has a trailing comment, not an issue, but a whole line
// starting with // should never be treated as a live entry).
function extractPrefixList(source, varName) {
  const declStart = source.indexOf(`List<String> ${varName}`);
  if (declStart === -1) {
    throw new Error(`Could not find declaration for ${varName} in ${PLUGIN_PATH}`);
  }
  const blockStart = source.indexOf("(", declStart);
  if (blockStart === -1) {
    throw new Error(`Could not find the opening ( for ${varName}`);
  }
  // Found empirically 2026-08-30: a naive indexOf(");") false-matched
  // inside a // comment containing the literal text "404'd);" partway
  // through the list, silently truncating it. The actual closing paren
  // always sits alone on its own trimmed line in this file's formatting
  // (Arrays.asList(\n    "a",\n    "b"\n);), so scanning line-by-line for
  // exactly that is immune to any "); substring appearing inside comment
  // prose, wherever it happens to fall.
  const restLines = source.slice(blockStart).split("\n");
  let blockEndLineIdx = -1;
  for (let i = 0; i < restLines.length; i++) {
    if (restLines[i].trim() === ");") {
      blockEndLineIdx = i;
      break;
    }
  }
  if (blockEndLineIdx === -1) {
    throw new Error(`Could not find the closing ); line for ${varName}`);
  }
  const block = restLines.slice(0, blockEndLineIdx).join("\n");

  const prefixes = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line === "") continue;
    // A trailing // comment on an otherwise-valid line (e.g. `"com.chase",
    // // Chase`) must not have its comment text scanned for quotes — strip
    // it first. A quoted string can't legally contain "//" in this file (no
    // URLs are quoted here), so this split is safe.
    const codeOnly = line.split("//")[0];
    // Multiple keywords/prefixes can share one line (e.g. the label-keyword
    // list), so every quoted string on the line must be captured, not just
    // the first.
    for (const m of codeOnly.matchAll(/"([^"]+)"/g)) {
      prefixes.push(m[1]);
    }
  }
  return prefixes;
}

function extractLabelKeywords(source) {
  return extractPrefixList(source, "EXCLUDED_LABEL_KEYWORDS");
}

function getDevicePackages(device) {
  const args = ["shell", "pm", "list", "packages", "--user", "0"];
  const fullArgs = device ? ["-s", device, ...args] : args;
  let output;
  try {
    output = execFileSync("adb", fullArgs, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(
      `adb command failed — is a device connected and authorized? (${err.message})`
    );
  }
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length));
}

function main() {
  const { device } = parseArgs(process.argv.slice(2));

  const source = readFileSync(PLUGIN_PATH, "utf-8");
  const excludedPrefixes = extractPrefixList(source, "EXCLUDED_PREFIXES");
  const noisePrefixes = extractPrefixList(source, "EXCLUDED_NOISE_PREFIXES");
  const labelKeywords = extractLabelKeywords(source);

  console.log(`Parsed ${excludedPrefixes.length} EXCLUDED_PREFIXES, ` +
    `${noisePrefixes.length} EXCLUDED_NOISE_PREFIXES, ` +
    `${labelKeywords.length} EXCLUDED_LABEL_KEYWORDS from AccessibilityPlugin.java\n`);

  let packages;
  try {
    packages = getDevicePackages(device);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Fetched ${packages.length} installed packages from device.\n`);

  const deadPrefixes = [];
  for (const prefix of [...excludedPrefixes, ...noisePrefixes]) {
    const hit = packages.some((pkg) => pkg.startsWith(prefix));
    if (!hit) deadPrefixes.push(prefix);
  }

  if (deadPrefixes.length === 0) {
    console.log("✅ Every EXCLUDED_PREFIXES / EXCLUDED_NOISE_PREFIXES entry matches at " +
      "least one real installed package on this device.");
  } else {
    console.log(`⚠️  ${deadPrefixes.length} prefix(es) match ZERO packages on this device ` +
      `— dead guesses, same class of bug as the original Wells Fargo gap:\n`);
    for (const p of deadPrefixes) console.log(`   - ${p}`);
    console.log(
      "\nNote: a dead prefix here is not proof it's wrong everywhere — it may be a " +
      "correct guess for an app simply not installed on THIS device. But it's worth " +
      "checking against the vendor's real published package id (Play Store URL contains " +
      "it) rather than assuming. The label-keyword layer (EXCLUDED_LABEL_KEYWORDS) is the " +
      "actual safety net for gaps like this — dead prefixes are a coverage/hygiene issue, " +
      "not by themselves an active vulnerability, as long as the matching label keyword " +
      "for that vendor is present."
    );
  }

  // Reverse check: does every category with a label keyword also have at
  // least one prefix representing it? A label-only vendor (no prefix at
  // all) means the fast-path never catches it and every request pays the
  // label-lookup cost — not wrong, but worth knowing.
  // Fixed 2026-08-30: the original 5-char-prefix-slice heuristic produced
  // false positives for real matches like "1password" -> com.onepassword
  // ("1pass" never appears in "onepassword") and "citibank" ->
  // com.citi.citimobile ("citib" never appears in "citi.citimobile").
  // Matching on the longest word in the keyword (>=4 chars, so short noise
  // words like "app"/"pay" don't cause spurious matches) against the whole
  // prefix string is more forgiving of exactly this kind of legitimate
  // wording difference between a display name and a package id.
  console.log("\n--- Coverage cross-check (informational) ---");
  const uncoveredKeywords = labelKeywords.filter((kw) => {
    const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    const candidates = words.length > 0 ? words : [kw.toLowerCase().replace(/\s+/g, "")];
    return !excludedPrefixes.some((p) => {
      const lowerPrefix = p.toLowerCase();
      return candidates.some((w) => lowerPrefix.includes(w));
    });
  });
  if (uncoveredKeywords.length > 0) {
    console.log(`${uncoveredKeywords.length} label keyword(s) with no obviously-matching ` +
      `prefix entry (heuristic check, may have false positives):`);
    for (const kw of uncoveredKeywords) console.log(`   - "${kw}"`);
  } else {
    console.log("Every label keyword has an apparent prefix counterpart.");
  }
}

main();
