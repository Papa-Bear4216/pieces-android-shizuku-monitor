import { createServer } from "node:http";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { verifyToken } from "./jwt.js";

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
// Home PC's Tailscale IP, not its LAN IP - this gateway runs on a remote host
// off the home network entirely, and only the tailnet bridges the two.
const HOME_PROXY_BASE_URL = process.env.HOME_PROXY_BASE_URL;
// The Plan A proxy's own bearer token - this is a SECOND auth layer, distinct
// from the JWT below. Phone -> gateway is JWT; gateway -> home proxy is still
// the original Plan A bearer token. Never commit this value; it lives in the
// remote host's compose env only.
const HOME_PROXY_TOKEN = process.env.HOME_PROXY_TOKEN;
const JWT_SECRET = process.env.GATEWAY_JWT_SECRET;
// The Plan A proxy itself allows up to 20s for /assets (a real DB scan that
// can legitimately take several seconds) — this gateway sits in front of it
// and must allow at least as long, or it kills a request the proxy was
// about to complete successfully.
const UPSTREAM_TIMEOUT_MS = 20000;

if (!JWT_SECRET) {
  console.error("GATEWAY_JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (!HOME_PROXY_BASE_URL) {
  console.error("HOME_PROXY_BASE_URL is not set (expected the PC's Tailscale IP, e.g. http://100.x.x.x:8787).");
  process.exit(1);
}
if (!HOME_PROXY_TOKEN) {
  console.error("HOME_PROXY_TOKEN is not set (the Plan A proxy's bearer token).");
  process.exit(1);
}

// Capacitor's WebView makes requests from its own origin (typically
// https://localhost), not the gateway's own origin - without this header,
// the WebView's fetch() rejects immediately once it sees the response has no
// CORS allowance, even though the network request itself succeeded. This is
// why "could not reach proxy" showed instantly despite curl/browser working
// fine from the same network: curl and a plain browser tab don't enforce
// CORS, but a WebView's fetch() does.
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

  // Unauthenticated liveness check for the gateway process itself - does NOT
  // prove the home node is reachable, just that this service is up. The
  // mobile app's Setup screen should treat this as "gateway is up", separate
  // from an actual proxied call succeeding.
  if (method === "GET" && url.pathname === "/mobile/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const auth = verifyToken(req.headers.authorization, JWT_SECRET);
  if (!auth.ok) {
    sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
    return;
  }

  // Ask and usage-report both need their raw POST body forwarded rather than
  // being routed through the generic allowlist below - neither maps to a
  // PiecesOS path (packages/allowlist only knows mobile-path -> PiecesOS-path
  // mappings), and both terminate at the home proxy itself. usage-report
  // forwards rather than logging locally so Plan A and Plan B events land in
  // the same file on the PC instead of splitting across two logs.
  const isAsk = method === "POST" && url.pathname === "/mobile/ask";
  const isRelevantSearch = method === "GET" && url.pathname === "/mobile/search/relevant";
  const isUsageReport = method === "POST" && url.pathname === "/mobile/usage-report";
  const isAssetFetch = method === "GET" && url.pathname.startsWith("/mobile/asset/");
  const isConversationFetch = method === "GET" && url.pathname.startsWith("/mobile/conversation/") && url.pathname.endsWith("/messages");
  const route = isAsk || isRelevantSearch || isUsageReport || isAssetFetch || isConversationFetch ? { piecesPath: "" } : findAllowedRoute(method, url.pathname);

  if (!route) {
    // Deny-by-default: same allowlist module as Plan A. Anything not listed
    // there is a 404 here too, even with a valid JWT.
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const target = new URL(url.pathname + url.search, HOME_PROXY_BASE_URL);
    const upstreamReq: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${HOME_PROXY_TOKEN}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };
    if (isAsk || isUsageReport) {
      upstreamReq.body = req;
      upstreamReq.headers = { ...upstreamReq.headers, "Content-Type": "application/json" };
      // Node.js native fetch requires duplex: 'half' when streaming a body.
      // @ts-expect-error duplex is not properly typed in early TS node fetch definitions
      upstreamReq.duplex = "half";
    }

    const homeRes = await fetch(target, upstreamReq);
    const text = await homeRes.text();
    res.writeHead(homeRes.status, {
      "Content-Type": homeRes.headers.get("content-type") ?? "application/json",
      ...CORS_HEADERS,
    });
    res.end(text);
  } catch (err) {
    // Fail closed: if the tailnet path to the home PC is down (PC asleep,
    // Tailscale down, home proxy not running because the user is logged
    // out), this returns an explicit 503 within UPSTREAM_TIMEOUT_MS rather
    // than hanging the phone indefinitely.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    sendJson(res, 503, {
      error: "home node unreachable",
      reason: isTimeout ? "timed out reaching the home proxy over Tailscale" : (err instanceof Error ? err.message : String(err)),
    });
  }
});

// 0.0.0.0, not 127.0.0.1: this runs inside a Docker container reached by
// Caddy over the compose network, not on bare metal. It is still not
// internet-facing - only exposed (not published) in docker-compose.yml, so
// only other containers on the same compose network can reach it directly.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`pieces-gateway listening on 0.0.0.0:${PORT} (reached via Caddy over the compose network, not published to the internet directly)`);
  console.log(`forwarding to home proxy at ${HOME_PROXY_BASE_URL}`);
});
