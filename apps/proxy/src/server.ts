import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PiecesClient } from "@pieces-android/pieces-api";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { isValidBearerToken } from "./auth.js";
import { summarizeTelemetry, seedToPiecesOS, TelemetryEvent } from "./seeder.js";
import { SeedQueue } from "./seed-queue.js";
import { shouldSeed } from "./surprisal.js";
import { MemoryClient } from "mem0ai";

// Mem0 integration is optional — most PiecesOS users won't have an account.
// Unset MEM0_API_KEY entirely disables it; failures are always non-fatal
// (logged and swallowed) so a bad/expired key never breaks the proxy itself.
const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_USER_ID = process.env.MEM0_USER_ID ?? "pieces-android-user";
const mem0Client = MEM0_API_KEY ? new MemoryClient({ apiKey: MEM0_API_KEY }) : null;

async function addToMem0(content: string) {
  if (!mem0Client) return;
  try {
    await mem0Client.add([{ role: "user", content }], { user_id: MEM0_USER_ID });
  } catch (e) {
    console.warn("Failed to save to Mem0", e);
  }
}

const UPSTREAM_TIMEOUT_MS = 5000;

// Deliberately outside the repo (which lives under OneDrive) — this file can
// contain real query/question text and must never be committed or synced.
const USAGE_LOG_PATH =
  process.env.USAGE_LOG_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-usage-log.jsonl`;
const MAX_EVENTS_PER_BATCH = 500;

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const PIECES_BASE_URL = process.env.PIECES_BASE_URL ?? "http://127.0.0.1:39300";
const BEARER_TOKEN = process.env.PROXY_BEARER_TOKEN;

// Anything that fails to seed into PiecesOS (e.g. it's restarting) lands
// here instead of being silently dropped — a background loop retries it
// until it succeeds or MAX_ATTEMPTS is hit. USAGE_LOG_PATH still gets every
// event unconditionally regardless of seed outcome, so this queue is purely
// about reconciling into PiecesOS, not about not losing the data at all.
const SEED_QUEUE_PATH =
  process.env.SEED_QUEUE_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-seed-queue.jsonl`;
const seedQueue = new SeedQueue(SEED_QUEUE_PATH, PIECES_BASE_URL);

if (!BEARER_TOKEN) {
  console.error(
    "PROXY_BEARER_TOKEN is not set. Refusing to start — this proxy must never run without auth. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  );
  process.exit(1);
}

const pieces = new PiecesClient({ baseUrl: PIECES_BASE_URL });

// Capacitor's WebView makes requests from its own origin (typically
// https://localhost), not the proxy's origin - without this header, the
// WebView's fetch() rejects immediately once it sees the response has no
// CORS allowance, even though the network request itself succeeded.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // /mobile/health is intentionally unauthenticated — a bare liveness check
  // for the app's Setup screen before a token has been entered. It reveals
  // nothing about PiecesOS itself, just that the proxy process is up.
  if (method === "GET" && url.pathname === "/mobile/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isValidBearerToken(req.headers.authorization, BEARER_TOKEN)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  // Ask is not a plain passthrough — it needs PiecesClient.ask()'s typed
  // unavailable-vs-answered handling, so it's special-cased rather than
  // routed through the generic allowlist proxy below.
  if (method === "POST" && url.pathname === "/mobile/ask") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let query: string;
    try {
      query = JSON.parse(body)?.query;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof query !== "string" || query.trim() === "") {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    
    await addToMem0(query);

    const result = await pieces.ask(query);
    sendJson(res, 200, result);
    return;
  }

  // Semantic (embeddings-based) search, distinct from /mobile/recent/search's
  // plain text match — special-cased like /mobile/ask because it needs
  // PiecesClient.relevantAssets()'s ID-hydration step, not a raw passthrough.
  if (method === "GET" && url.pathname === "/mobile/search/relevant") {
    const query = url.searchParams.get("query");
    if (!query || query.trim() === "") {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    try {
      const results = await pieces.relevantAssets(query);
      sendJson(res, 200, { iterable: results });
    } catch (err) {
      sendJson(res, 502, { error: "PiecesOS relevance search failed", detail: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Not a PiecesOS route — terminates here and writes to the local usage log.
  // Special-cased for the same reason /mobile/ask is: packages/allowlist maps
  // mobile paths to PiecesOS paths, and this route has no PiecesOS counterpart.
  if (method === "POST" && url.pathname === "/mobile/usage-report") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let events: unknown;
    try {
      events = JSON.parse(body)?.events;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      sendJson(res, 400, { error: "events array is required" });
      return;
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      sendJson(res, 400, { error: `batch too large (max ${MAX_EVENTS_PER_BATCH})` });
      return;
    }
    try {
      await mkdir(dirname(USAGE_LOG_PATH), { recursive: true });
      const lines = (events as any[]).map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(USAGE_LOG_PATH, lines, "utf-8");
      
      // Batch consecutive same-package system_telemetry events in this
      // request into a single seed instead of one seed call per event — a
      // scroll-heavy burst that survives client-side dedup previously wrote
      // to both Mem0 and PiecesOS once per surviving event.
      //
      // The Android package name isn't a separate field on the event — it's
      // embedded as "Package: <name>\n\n<text>" inside `telemetry` (see
      // Status.tsx's passiveCapture handler) — so it's extracted from there.
      const packageOf = (e: TelemetryEvent): string => {
        const match = /^Package:\s*(\S+)/.exec(e.telemetry ?? "");
        return match ? match[1] : "unknown";
      };

      const telemetryEvents = (events as TelemetryEvent[]).filter((e) => e.type === "system_telemetry");
      const batches: TelemetryEvent[][] = [];
      for (const e of telemetryEvents) {
        const last = batches[batches.length - 1];
        if (last && packageOf(last[0]) === packageOf(e)) {
          last.push(e);
        } else {
          batches.push([e]);
        }
      }

      for (const batch of batches) {
        const packageName = packageOf(batch[0]);
        const bodyText =
          batch.length === 1
            ? summarizeTelemetry(batch[0])
            : batch.map((e) => summarizeTelemetry(e)).join("\n\n===\n\n");
        const title =
          batch.length === 1
            ? "Android Context: System Telemetry"
            : `Android Context: System Telemetry (${batch.length} events batched)`;

        // Surprisal gate: skip seeding near-duplicate/unsurprising content.
        // Fails open (see surprisal.ts) — never a silent data-loss path.
        const novel = await shouldSeed(packageName, bodyText);
        if (!novel) continue;

        await addToMem0(bodyText);

        try {
          await seedToPiecesOS(PIECES_BASE_URL, bodyText, title);
        } catch (err) {
          console.warn("PiecesOS not reachable for seeding; queued for retry.", err);
          await seedQueue.enqueue(bodyText, title);
        }
      }

      sendJson(res, 200, { accepted: (events as any[]).length });
    } catch (err) {
      sendJson(res, 500, { error: "failed to persist usage events", detail: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Specialized route for fetching a specific asset's content by ID
  if (method === "GET" && url.pathname.startsWith("/mobile/asset/")) {
    const assetId = url.pathname.split("/").pop();
    if (!assetId) {
      sendJson(res, 400, { error: "missing asset ID" });
      return;
    }
    try {
      const target = new URL(`/asset/${assetId}`, PIECES_BASE_URL);
      const piecesRes = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const text = await piecesRes.text();
      res.writeHead(piecesRes.status, {
        "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
        ...CORS_HEADERS,
      });
      res.end(text);
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      sendJson(res, isTimeout ? 503 : 502, {
        error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Specialized route for fetching a conversation's messages
  if (method === "GET" && url.pathname.startsWith("/mobile/conversation/") && url.pathname.endsWith("/messages")) {
    const convoId = url.pathname.split("/")[3];
    if (!convoId) {
      sendJson(res, 400, { error: "missing conversation ID" });
      return;
    }
    try {
      const target = new URL(`/conversation/${convoId}/messages`, PIECES_BASE_URL);
      const piecesRes = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const text = await piecesRes.text();
      res.writeHead(piecesRes.status, {
        "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
        ...CORS_HEADERS,
      });
      res.end(text);
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      sendJson(res, isTimeout ? 503 : 502, {
        error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const route = findAllowedRoute(method, url.pathname);
  if (!route) {
    // Deny-by-default: anything not explicitly listed in allowlist.ts is a 404,
    // not proxied. Do not add a catch-all fallback here.
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const target = new URL(route.piecesPath, PIECES_BASE_URL);
    target.search = url.search;
    const piecesRes = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const text = await piecesRes.text();
    res.writeHead(piecesRes.status, {
      "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
      ...CORS_HEADERS,
    });
    res.end(text);
  } catch (err) {
    // Fail closed: a hung/unreachable PiecesOS must return an explicit 503
    // within UPSTREAM_TIMEOUT_MS, not leave the caller hanging indefinitely.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    sendJson(res, isTimeout ? 503 : 502, {
      error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pieces-android proxy listening on 0.0.0.0:${PORT} (LAN, private-profile firewall assumed)`);
  console.log(`proxying to PiecesOS at ${PIECES_BASE_URL}`);
});

// A client disconnecting mid-request (flaky WiFi, phone sleep, app backgrounded)
// throws ECONNRESET from inside Node's HTTP internals — outside any try/catch
// in our own request handler. Left uncaught, this kills the whole process, so
// the proxy has been silently dying under completely normal phone network
// flakiness rather than staying up like a long-running service should.
process.on("uncaughtException", (err) => {
  console.error("[proxy] uncaught exception (ignoring, staying alive):", err);
});

// Also drain once on startup — covers the case where the proxy itself was
// down (not just PiecesOS) and items piled up while nothing was retrying.
seedQueue.drain().catch((err) => console.warn("[seed-queue] initial drain failed", err));
seedQueue.startRetryLoop();
