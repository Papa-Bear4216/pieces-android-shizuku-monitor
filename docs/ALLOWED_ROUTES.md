# ALLOWED_ROUTES.md — evidence log

Live discovery against PiecesOS 12.5.0, `http://127.0.0.1:39300` (see correction below),
2026-07-26. Every route below was either called directly with `curl` or read verbatim
from the official `@pieces.app/pieces-os-client@4.1.0` TS client source (installed to a
scratch dir and inspected — not guessed, not taken from docs/memory).

**No route is added to the proxy allowlist unless it appears in this file with evidence.**

## Correction to task brief

Brief assumed PiecesOS listens on `http://127.0.0.1:1000`. Live check found:

```
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 39300
  → 127.0.0.1:39300, owned by pieces_for_x (PID confirmed running)
```

Port 1000 is not listening. **Actual base URL: `http://127.0.0.1:39300`.**
Confirm this hasn't drifted before building the proxy against it — PiecesOS is known to
occasionally change its listening port across versions/reinstalls; the proxy setup step
should re-verify at install time rather than hardcode 39300 blindly (see README).

## Confirmed working (200, real response body)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/.well-known/health` | liveness check | `curl` → `ok:29943f30-c772-4530-a0f8-e22071d9e69f` |
| GET | `/.well-known/version` | version string | `curl` → `12.5.0` |
| GET | `/conversations` | list conversations ("Recent") | `curl` → 200, 29549 bytes, real conversation objects (id, name, created, updated, messages.indices) |
| GET | `/assets` | list assets/snippets | `curl` → 200, 81111 bytes, real asset objects (id, name, creator, created, formats) |
| GET | `/assets/search?query=<text>` | full-text-ish search over assets | `curl` → 200, real matching asset returned for query "android" (found the actual task-brief snippet saved earlier this session) |
| POST | `/qgpt/relevance` (body: `{"query": "<text>"}` only, no scope) | first phase of Ask flow — embeds query, returns relevant snippets | `curl` → 200, `{"relevant":{"iterable":[]}}` — clean, documented behavior when no search space (paths/seeds/assets/database) is given |

## Confirmed to exist, but broken/unusable in this PiecesOS install right now

| Method | Path | What happened |
|---|---|---|
| POST | `/qgpt/relevance` with `options.database:true` | HTTP 500 `"qGPT Relevance Endpoint failed."` |
| POST | `/qgpt/relevance` with `assets.iterable:[{"id": "<real-asset-id>"}]` | HTTP 500 `"qGPT Relevance Endpoint failed."` |
| POST | `/qgpt/relevance` with `options.question:true` (any scope) | HTTP 500, same error |
| POST | `/qgpt/question` (direct, `relevant.iterable: []`) | HTTP 500 `"qGPT Question Endpoint failed."` |

**Read on this:** the route/shape itself is real — confirmed from the official TS client's
`QGPTApi.js`, and the plain no-scope relevance call succeeds cleanly at 200. The moment an
actual answer-generation path is exercised (full-DB search, asset-scoped search, or the
`question:true` shortcut), the server 500s consistently. Most likely cause: no LLM
model/runtime configured for this PiecesOS install (local or cloud-backed) — not a wrong
path or wrong request shape on our end. **This blocks a working "Ask" feature until
resolved on the PiecesOS side.** Needs your input: check Pieces desktop app settings for
model configuration before the mobile Ask screen can do anything beyond a "service
unavailable" state.

## Confirmed NOT working

| Method | Path | Result |
|---|---|---|
| POST | `/search/full_text?query=...` | HTTP 404 `Route not found` — either wrong HTTP verb/param shape for this build, or removed/renamed. Not investigated further since `/assets/search` already covers the read-only search need. |

## Real routes seen in the official TS client, not yet called live (candidates only — NOT allowlisted without a live 200)

Pulled directly from `@pieces.app/pieces-os-client@4.1.0`'s generated API classes
(`dist/apis/*.js`), for reference when/if scope expands. Do not add these to the proxy
allowlist without repeating the live-curl-evidence step above.

- `GET /assets/{asset}` — single asset detail
- `GET /assets/{asset}/formats` — asset content/formats
- `GET /conversation/{conversation}` — single conversation detail
- `GET /conversation/{conversation}/messages` — conversation messages
- `WS /qgpt/stream` — streaming Ask variant (untested; may behave differently than the REST `/qgpt/question` path above, worth trying if the REST path stays broken)
- `POST /qgpt/hints` — suggested follow-up questions

## Non-goals reminder (do not implement)

Anything under `/assets/create`, `/assets/{asset}/delete`, `/conversations/create`,
`/asset/update`, `/conversation/update`, or any other write/mutation path — out of scope
per the frozen architecture (read-only Ask/Recent/Status client only).

## Plan B: remote gateway (2026-07-26)

Plan B adds a second entry point — `apps/pieces-gateway`, running on hermes-host, fronted
by Caddy at `https://pieces.dysfunctionjunction.xyz` — that reaches the same PC over
Tailscale instead of requiring the phone to be on the home LAN. It imports the exact same
`packages/allowlist` module as the Plan A proxy, so this table is still the single source
of truth for what's allowed; nothing new was added to the allowlist for Plan B, only a new
path to reach it.

**Two auth layers, not one:**
- Phone → gateway: a per-device JWT (see `apps/pieces-gateway/src/jwt.ts`), issued via
  `npm run enroll` and checked against a revocation registry
  (`apps/pieces-gateway/src/device-registry.ts`) on every request — a stateless JWT alone
  cannot be revoked, so the registry is the actual security boundary here, not token expiry.
- Gateway → home proxy: the same Plan A bearer token, sent over Tailscale to the PC's
  tailnet IP. This value lives in a `.env` file on hermes-host only (`chmod 600`, never
  committed) — see `HOME_PROXY_TOKEN` in `apps/pieces-gateway/src/server.ts`.

**Fail-closed, proven twice:** both the Plan A proxy and the gateway apply a 5-second
`AbortSignal.timeout` to their upstream call and return an explicit `503` on timeout,
rather than hanging. Verified by literally stopping the Plan A proxy and confirming the
gateway 503s in ~5s over the real deployed HTTPS path — see `docs/ACCEPTANCE.md`.

**DNS**: `pieces.dysfunctionjunction.xyz` is an A record → `34.73.193.94` (hermes-host),
added via `vercel dns add` (DNS for this domain is on Vercel, under org
`team_18dH8QMMrUG3oXRNjbX9sSCq`, a different scope than the default CLI login — pass
`--scope team_18dH8QMMrUG3oXRNjbX9sSCq` explicitly if `vercel dns` commands 403). Caddy
issued a real Let's Encrypt cert for this hostname on first run — confirmed via
`certificate obtained successfully` in `docker logs hermes-bridge-caddy-1`.

**Known gap**: no code changes were needed in the mobile app's request logic for Plan B —
both the proxy and gateway expose the identical `/mobile/*` surface and bearer-token auth
model, so the same Setup screen works for either by just pointing at a different
address/token. What did need updating: Setup's copy (now describes both LAN and remote
modes) and a new `HomeNodeUnreachableError` in `apps/mobile/src/lib/api.ts` so a 503 shows
as "home PC offline" instead of a generic error.
