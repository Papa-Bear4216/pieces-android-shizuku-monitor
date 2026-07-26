import { createServer } from "node:http";
import { PiecesClient } from "@pieces-android/pieces-api";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { isValidBearerToken } from "./auth.js";

const UPSTREAM_TIMEOUT_MS = 5000;

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const PIECES_BASE_URL = process.env.PIECES_BASE_URL ?? "http://127.0.0.1:39300";
const BEARER_TOKEN = process.env.PROXY_BEARER_TOKEN;

if (!BEARER_TOKEN) {
  console.error(
    "PROXY_BEARER_TOKEN is not set. Refusing to start — this proxy must never run without auth. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  );
  process.exit(1);
}

const pieces = new PiecesClient({ baseUrl: PIECES_BASE_URL });

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

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
    const result = await pieces.ask(query);
    sendJson(res, 200, result);
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
    res.writeHead(piecesRes.status, { "Content-Type": piecesRes.headers.get("content-type") ?? "application/json" });
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
