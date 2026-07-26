# ACCEPTANCE.md — Plan A local acceptance run

Run 2026-07-26, against a live PiecesOS 12.5.0 instance at `127.0.0.1:39300`.
Each item was actually executed (curl / gradlew / find), not assumed. ✅ = observed
directly this run. ⚠️ = observed, but with a caveat worth reading before relying on it.
⬜ = not yet run (needs an Android device/emulator, out of reach in this shell).

## Proxy: liveness & auth

- ✅ `/mobile/health` returns 200 with no Authorization header (Setup screen's pre-token
  liveness probe works before enrollment).
- ✅ Any other route with no Authorization header returns 401 `{"error":"unauthorized"}`.
- ✅ Any other route with a wrong bearer token returns 401 (constant-time compare, not a
  string `===`, so token length/prefix isn't leaked via timing).
- ✅ Correct token + allowlisted route passes through to PiecesOS successfully.
- ✅ Correct token + a route NOT in `allowlist.ts` returns 404 — deny-by-default confirmed
  even with valid auth, not just unauthenticated requests.
- ✅ Proxy refuses to start at all if `PROXY_BEARER_TOKEN` is unset (`process.exit(1)` with
  a message, rather than silently running open).

## Proxy: functional routes

- ✅ `GET /mobile/status/health` → proxies to PiecesOS `.well-known/health`, returns
  `ok:<uuid>`.
- ✅ `GET /mobile/recent/conversations` → proxies to `/conversations`, real conversation
  list returned.
- ✅ `GET /mobile/recent/search?query=android` → proxies to `/assets/search`, real match
  returned (found this very task's saved snippet).
- ✅ `POST /mobile/ask` → does NOT throw or 500 the proxy when PiecesOS's answer-generation
  path fails; returns a clean typed `{"status":"unavailable","reason":"..."}` at HTTP 200.
  This was verified against the real broken state documented in `ALLOWED_ROUTES.md` — not
  a mocked failure.

## Mobile app: build

- ✅ `npm run build` (tsc -b && vite build) succeeds with zero type errors.
- ✅ `npx cap add android` + `npx cap sync android` succeed, Preferences plugin detected.
- ✅ `./gradlew assembleDebug` succeeds end-to-end (2m28s, 123 tasks), producing
  `android/app/build/outputs/apk/debug/app-debug.apk`.

## Mobile app: functional (not yet run — needs a device)

- ⬜ Install APK on a real Android phone on the same LAN as the PiecesOS host.
- ⬜ Setup screen: enter proxy address + token, "Test & Save" succeeds against the real
  proxy over LAN (not just loopback, as tested above).
- ⬜ Status screen: shows health/version pulled through the proxy.
- ⬜ Recent screen: shows real conversations/assets, search box returns real matches.
- ⬜ Ask screen: given the current broken PiecesOS Ask backend, confirm the UI shows the
  "unavailable" message cleanly rather than a crash or blank screen.
- ⬜ Force-quit and reopen the app: confirm Setup values persist (Capacitor Preferences,
  not lost on process restart).

## Security constraints (from the frozen architecture)

- ✅ PiecesOS itself was never rebound — confirmed still on `127.0.0.1:39300` (loopback
  only) throughout this build; the proxy is the only thing exposed to the LAN.
- ✅ Deny-by-default allowlist confirmed above (404 on non-listed routes).
- ✅ Bearer auth confirmed enforced above.
- ⚠️ Windows Firewall rule (port 8787, Private profile only) — script written
  (`apps/proxy/scripts/windows-firewall-rule.ps1`) but **not yet applied**; it requires an
  elevated PowerShell session, which this run didn't have. **Run this manually before
  actually exposing the proxy on the LAN** — until it's applied, port 8787 has whatever
  firewall behavior Windows defaults to for a new inbound listener, not the private-only
  restriction the plan requires.

## Known limitation carried over from discovery

- ⚠️ Ask is not actually functional yet — PiecesOS's answer-generation path 500s on this
  install (see `ALLOWED_ROUTES.md`), most likely due to no LLM model configured. The app
  handles this gracefully (typed unavailable state, no crash), but there is currently no
  path to a real answer until that's resolved on the PiecesOS side. Not a proxy or mobile
  bug — re-test `docs/ALLOWED_ROUTES.md`'s broken-routes table once resolved.

## Plan A persistence follow-up (2026-07-26)

- ✅ Proxy registered as a Windows Scheduled Task (`PiecesAndroidProxy`), mode `S4U`
  (`LogonType: S4U`, confirmed via `(Get-ScheduledTask ...).Principal`) — runs at boot AND
  logon with no stored password. Chosen specifically because the Windows account is
  intentionally passwordless (a prior unauthorized-access incident is why) — the
  alternative ("run whether logged on or not" with a real stored password) was
  deliberately rejected, not just deferred.
- ✅ Firewall rule applied: TCP 8787, Private profile only, confirmed active (adapter's
  `NetworkCategory` is `Private`).
- ⚠️ **Not yet proven**: whether S4U actually survives a genuinely unattended reboot (PC
  restarts, nobody signs in). The task registered cleanly and the proxy responds
  immediately after registration, but that's not the same test. If the proxy directory
  ever becomes a OneDrive Files-On-Demand placeholder (currently confirmed hydrated,
  `Attributes: Archive`, no `Offline` flag), this would break silently at pre-login boot.
  **Action for next session**: reboot without signing in, then curl the proxy's LAN IP
  from another device.

## Plan B: full run (2026-07-26)

Ran against the real deployed stack — hermes-host's live Caddy/Docker/Tailscale, not a
simulation. Every item below was actually executed.

- ✅ Tailscale joined on both ends with no prior setup existing (`tailscale up
  --authkey=...`), confirmed via `tailscale status` showing all 3 devices (PC, hermes-host,
  phone) on the same tailnet.
- ✅ **Gate test**: `curl http://<pc-tailnet-ip>:8787/mobile/health` from hermes-host →
  `{"ok":true}` HTTP 200, before any gateway code was written.
- ✅ Container DNS/ACME check: `docker exec hermes-bridge-caddy-1 wget ... letsencrypt.org`
  succeeded — the `127.0.0.53:53` DNS failure noted in HANDOFF.md is not currently
  reproducing.
- ✅ `packages/allowlist` extracted from `apps/proxy` into a real shared package (moved, not
  copied) — both the proxy and pieces-gateway import the same module, confirmed by grep.
- ✅ `pieces-gateway` built and deployed as a new Docker service on hermes-host, alongside
  (not replacing) `hermes-bridge` and `caddy`. Verified `hermes-bridge`'s existing route
  (`https://hermes.dysfunctionjunction.xyz` → HTTP 401, matching its known-healthy state)
  was unaffected by the deploy.
- ✅ **Bug caught and fixed during deploy**: pieces-gateway initially bound to
  `127.0.0.1` inside its container (copy-pasted from local bare-metal testing) — Caddy
  couldn't reach it over the compose network. Fixed to `0.0.0.0`, confirmed via
  `docker exec hermes-bridge-caddy-1 wget http://pieces-gateway:8788/mobile/health` →
  `{"ok":true}` before touching Caddy's own config.
- ✅ DNS: `pieces.dysfunctionjunction.xyz` A record added via `vercel dns add` (see
  ALLOWED_ROUTES.md for the scope gotcha), confirmed resolving via `nslookup ... 8.8.8.8`.
- ✅ TLS: Caddy obtained a real Let's Encrypt cert for the new hostname on first restart —
  `"certificate obtained successfully","identifier":"pieces.dysfunctionjunction.xyz"` in
  its logs. (Unrelated pre-existing cert failures for `dysfunctionjunction.xyz` bare domain
  and `bear-house-classic.vercel.app` also appear in the same logs — those domains don't
  point at hermes-host's IP for HTTP-01 challenges and were failing before this change too;
  not something this work introduced or needs to fix.)
- ✅ **Full chain, real internet path**: `curl -H "Authorization: Bearer <jwt>"
  https://pieces.dysfunctionjunction.xyz/mobile/status/health` → `ok:29943f30-...` HTTP
  200 — Caddy TLS → gateway JWT auth → Tailscale → PC's Plan A proxy → PiecesOS → back,
  entirely over the public internet with zero inbound ports opened on the home network.
- ✅ Auth enforcement over the real path: no-token request → 401; non-allowlisted route
  with a valid JWT → 404 (same allowlist module, same deny-by-default as Plan A).
- ✅ Device revocation over the real path: enrolled a device inside the running container
  (`docker exec ... npx tsx src/enroll-cli.ts`), used its JWT successfully, revoked it
  (`revoke-cli.ts`), confirmed the same still-unexpired JWT then returns 401 `"device
  revoked"`.
- ✅ **Fail-closed, proven on the real deployed path**: stopped the Plan A proxy's
  scheduled task on the PC, then hit the gateway's HTTPS endpoint with a valid JWT —
  `503 {"error":"home node unreachable","reason":"timed out reaching the home proxy over
  Tailscale"}` in 5.3 seconds (matches the 5s `AbortSignal.timeout`), not a hang. Proxy
  restarted and reconfirmed working afterward.
- ✅ Mobile app: `npm run build` and `./gradlew assembleDebug` both succeed after adding
  `HomeNodeUnreachableError` handling to Setup/Status/Recent/Ask and updating Setup's copy
  for the two connection modes.
- ⬜ Not yet run: installing the rebuilt APK on a real phone and testing Setup/Ask/Status/
  Recent against `https://pieces.dysfunctionjunction.xyz` from an actual off-LAN network
  (e.g. phone on cellular data, not Wi-Fi). Everything above was curl-verified, not
  phone-verified.
