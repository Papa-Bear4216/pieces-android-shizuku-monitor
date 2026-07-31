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

**Root cause confirmed (2026-08-01):** `GET /models` (documented in the
`pieces-os-client-openapi-spec` repo, not in `docs.pieces.app`) returns a live snapshot of
every model PiecesOS knows about. On this install, all 98 models — cloud and local —
show `"downloaded": false, "loaded": false`. That's the entire explanation: `/qgpt/*`
500s because there is genuinely no model backing answer generation, not a request-shape
or path problem. `GET /model/{id}` returns the same per-model detail; `POST
/model/{id}/download` then `POST /model/{id}/load` are the fix (both accept only the
model's UUID as a path param, no request body). Download is async — the response comes
back immediately with `downloaded: false`, so poll `GET /model/{id}` for `downloaded:
true` before calling `/load`.

Triggered a live test: `POST /model/6023776a-aea6-4369-8041-e26b690eaddb/download`
(`qwen3:4b-q4_K_S` — chosen because it's small, fully local, and needs no cloud API key,
unlike every `cloud: true` entry in the list such as the Claude/GPT/Gemini chat models).

**Download succeeded** — polled `GET /model/{id}` until `downloaded: true` (confirmed,
persists across calls). **`POST /model/{id}/load` then failed with HTTP 500**:

```
Model load failed: Bad state: Local LLM engine is not initialized. Call
LocalLlmFacade.initialize() first.
```

`LocalLlmFacade.initialize()` is not exposed anywhere in the OpenAPI spec (checked —
grepped all 392 routes for engine/llm/runtime/initialize, nothing matches) — it's internal
PiecesOS engine plumbing, not a callable API route.

**Correction — there is no Settings → Models page.** Walked the actual Pieces Desktop UI
(6.1.0) end to end: profile avatar → Settings has 8 sections (All, Account, Long-Term
Memory, MCP, Connectors, Appearance, Language, Troubleshooting) and none of them expose
model download/load/enable controls. Model selection lives entirely in the chat composer
itself (a "Claude · Extra Thinking"-style dropdown, options Claude/Gemini/GPT/Grok, all
`cloud:true`), not in Settings — so the `qwen3:4b` local-model download/load path above
was very likely the wrong lever entirely, not just blocked on a missing manual step.

**PiecesOS update changed the picture.** While finding Settings, Pieces Desktop flagged
"PiecesOS Update Required" (had drifted to require ≥12.6.0; this install was still on
12.5.0). Updated via the in-app "Download Update & Restart" button — confirmed via
`GET /.well-known/version` → `12.6.0` post-restart. **Re-ran the full test matrix
afterward with real evidence, not assumptions:**

| Call | Result after 12.6.0 update |
|---|---|
| `/qgpt/relevance`, no scope | 200 (unchanged, was already working) |
| `/qgpt/relevance`, `options.database:true` | **200 — now returns ~100 real matched asset IDs.** Previously 500. **Fixed by the version update alone**, nothing to do with model config. |
| `/qgpt/relevance`, `options.database:true, options.question:true` | Still 500 `"qGPT Relevance Endpoint failed."` |
| `/qgpt/question` (direct), empty `relevant.iterable`, no `model` | Still 500 `"qGPT Question Endpoint failed."` |
| `/qgpt/question`, explicit `model` = a random unloaded local model ID | Still 500 (expected — bad test, that model genuinely isn't loaded) |
| `/qgpt/question`, explicit `model` = `a737e3fb-3673-4872-90c1-c8ad70c88099` (`Claude 4.5 Sonnet Chat Model`, a `cloud:true` model matching what the working desktop chat UI uses) | **Still 500**, identical error |

**Revised conclusion:** the 12.6.0 update fixed the *relevance/search* half of Ask
(database-scoped semantic search over assets — genuinely useful on its own for e.g. a
"search my notes" feature) but did **not** fix *answer generation*
(`question:true` / `/qgpt/question`). Ruled out "wrong or unloaded model ID" as the cause
of the remaining 500 — an explicit, correctly-typed cloud chat-model ID (the same category
the desktop app's own working chat uses) still 500s identically to no model specified at
all. This points to either (a) `/qgpt/question` being broken/deprecated server-side
independent of model config — worth trying the `WS /qgpt/stream` variant noted below
instead, since the desktop app's chat may route through that, not the REST endpoint — or
(b) some other undiscovered prerequisite. Not resolvable further via REST alone without
more PiecesOS-side error detail than the plain-text 500 body provides.

**Current state for the mobile Ask feature:** still not viable end-to-end. Recommend
narrowing scope to what's now proven working — database-scoped `/qgpt/relevance` as a
"search your memories" feature — rather than continuing to block on full Q&A-style Ask
until the `/qgpt/question` / `WS /qgpt/stream` question is resolved.

## Semantic search shipped (2026-08-01)

Wired up `/qgpt/relevance` with `options.database:true` as a real feature, separate from
the still-broken Ask/`/qgpt/question` path:

- `PiecesClient.relevantAssets(query)` in `packages/pieces-api` — calls the relevance
  endpoint, then hydrates each returned asset ID via `GET /asset/{id}` (name/created/
  updated) since the relevance response only carries bare IDs. Preserves relevance-ranked
  order; does not re-sort.
- **Timeout note:** the raw relevance call alone measured 5.5s against 108 real assets,
  already over the client's 5s default (tuned for single-call passthrough routes) before
  hydration even starts. `relevantAssets()` uses its own 15s budget (`RELEVANCE_TIMEOUT_MS`)
  for both the relevance call and the hydration fan-out — added a `timeoutMs` override
  param to `PiecesClient`'s private `fetch()` to support this without changing the
  client-wide default other routes rely on.
- `GET /mobile/search/relevant?query=` in `apps/proxy` — special-cased like `/mobile/ask`
  (needs the typed hydration step, not a raw allowlist passthrough). Mirrored into
  `apps/pieces-gateway`'s `isRelevantSearch` passthrough check for the remote-access path;
  no gateway body-forwarding change needed since it's a GET with the query in `url.search`.
- `searchRelevant()` in `apps/mobile/src/lib/api.ts`, wired into `Recent.tsx`'s existing
  search box: tries semantic search first, falls back to the pre-existing
  `searchAssets()` (plain text match via `/assets/search`) if relevance search throws —
  so search keeps working even if PiecesOS regresses on `/qgpt/relevance` again or an
  older home proxy build is in the path. `UsageEvent`'s `"search"` variant gained a
  `mode: "relevant" | "text" | "text-fallback"` field to distinguish which path served
  a given search in the usage log.

**Verified end-to-end** against the live proxy (test instance, port 8799): query
`"pieces-android"` → 200, real hydrated results with names in ~8s (e.g. "AndroidContext
v1: Android Context with Raw Telemetry Block" — genuinely relevant hits pulled from this
debugging session's own captured telemetry, not placeholder data). `apps/mobile` typechecks
and builds clean (`npx tsc --noEmit`, `npm run build`). `apps/proxy` and
`apps/pieces-gateway` have no tsconfig/static typecheck gate (run via `tsx`, validated by
this live test instead).

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
