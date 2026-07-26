import { createServer } from "node:http";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { verifyToken } from "./jwt.js";

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
// Home PC's Tailscale IP, not its LAN IP - this gateway runs on hermes-host,
// off the home network entirely, and only the tailnet bridges the two.
const HOME_PROXY_BASE_URL = process.env.HOME_PROXY_BASE_URL;
// The Plan A proxy's own bearer token - this is a SECOND auth layer, distinct
// from the JWT below. Phone -> gateway is JWT; gateway -> home proxy is still
// the original Plan A bearer token. Never commit this value; it lives in the
// hermes-host compose env only.
const HOME_PROXY_TOKEN = process.env.HOME_PROXY_TOKEN;
const JWT_SECRET = process.env.GATEWAY_JWT_SECRET;
const UPSTREAM_TIMEOUT_MS = 5000;

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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

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

  // Ask needs the same special-casing as Plan A's proxy (typed
  // unavailable-vs-answered), so it forwards to the home proxy's own
  // /mobile/ask rather than being routed through the generic allowlist below.
  const isAsk = method === "POST" && url.pathname === "/mobile/ask";
  const route = isAsk ? { piecesPath: "" } : findAllowedRoute(method, url.pathname);

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
    if (isAsk) {
      let body = "";
      for await (const chunk of req) body += chunk;
      upstreamReq.body = body;
      upstreamReq.headers = { ...upstreamReq.headers, "Content-Type": "application/json" };
    }

    const homeRes = await fetch(target, upstreamReq);
    const text = await homeRes.text();
    res.writeHead(homeRes.status, { "Content-Type": homeRes.headers.get("content-type") ?? "application/json" });
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
