# pieces-android

Android companion for PiecesOS — Status, Recent, and Ask (Ask is currently degraded, see
[docs/ALLOWED_ROUTES.md](docs/ALLOWED_ROUTES.md)). Two ways to connect, both live:

- **Plan A (LAN)**: phone and PC on the same Wi-Fi, talking directly to a proxy on the PC.
- **Plan B (remote)**: phone anywhere with internet, routed through a gateway on hermes-host
  over Tailscale back to the same PC — no inbound ports opened on the home network, fails
  closed if the PC is offline/unreachable.

```
apps/proxy/          Node HTTP proxy (Plan A) — bearer auth + deny-by-default allowlist in front of PiecesOS
apps/pieces-gateway/ Node HTTP gateway (Plan B) — JWT device auth + revoke, forwards to apps/proxy over Tailscale
apps/mobile/         Capacitor Android app (Setup / Status / Ask / Recent) — same UI works with either backend
packages/pieces-api/ Typed client for the handful of PiecesOS routes the proxy calls
packages/allowlist/  Shared deny-by-default route list — imported by BOTH apps/proxy and apps/pieces-gateway
docs/                ALLOWED_ROUTES.md (evidence log), ACCEPTANCE.md (test run record)
```

## 1. Run the proxy (on the PC running PiecesOS)

```bash
cd apps/proxy
npm install

# generate a bearer token once, save it somewhere safe
node scripts/generate-token.mjs

# start the proxy
PROXY_BEARER_TOKEN=<paste-token-here> npm start
```

By default it listens on `0.0.0.0:8787` and proxies to PiecesOS at
`http://127.0.0.1:39300`. Override either with env vars if needed:

```bash
PROXY_PORT=8787 PIECES_BASE_URL=http://127.0.0.1:39300 PROXY_BEARER_TOKEN=... npm start
```

**Before exposing this on your LAN**, restrict the port to your Private network profile —
run `apps/proxy/scripts/windows-firewall-rule.ps1` in an elevated PowerShell window. This
is a manual step by design; it is not run automatically by `npm start`.

To keep it running continuously (needed for Plan B, since the gateway depends on this
proxy being reachable at any time), register it as a Windows Scheduled Task instead of
running it manually — see `apps/proxy/scripts/register-service.ps1`. It defaults to S4U
mode (runs at boot and logon, no stored password required — appropriate if your Windows
account is passwordless). Run it once, elevated:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "apps\proxy\scripts\register-service.ps1"
```

Find your PC's LAN IP (`ipconfig`, look for the IPv4 address on your home network
adapter) — the phone will need `http://<that-ip>:8787` for Plan A (LAN) mode.

## 2. (Optional) Set up Plan B — remote access via hermes-host + Tailscale

Skip this section if LAN-only access is enough for you.

Requirements: a Tailscale account (free tier is fine), and a Linux host reachable from the
internet with Docker + Caddy already fronting at least one domain (this was built against
an existing `hermes-host` GCE VM that already ran Caddy for another service — adapt paths
if yours differs).

1. **Join both machines to the same tailnet.** Install Tailscale on the PC running the
   Plan A proxy and on your remote host, then `tailscale up --authkey=<key>` on each
   (generate a reusable auth key at https://login.tailscale.com/admin/settings/keys).
   Verify: from the remote host, `curl http://<pc-tailnet-ip>:8787/mobile/health` should
   return `{"ok":true}` before proceeding — if it doesn't, nothing downstream will work.

2. **Copy `apps/pieces-gateway` and `packages/allowlist`** to the remote host (matching
   relative layout matters — the Dockerfile expects to be built with the repo root as
   context, see the comment at the top of `apps/pieces-gateway/Dockerfile`).

3. **Add a new service to your existing docker-compose.yml**, alongside whatever Caddy
   already fronts — see `apps/pieces-gateway/deploy/docker-compose.snippet.yml` for the
   exact block. Add `pieces-gateway` to Caddy's `depends_on` list too.

4. **Write a `.env` file** at `apps/pieces-gateway/.env` on the remote host (never commit
   this):
   ```
   GATEWAY_JWT_SECRET=<generate with: openssl rand -base64 32>
   HOME_PROXY_BASE_URL=http://<pc-tailnet-ip>:8787
   HOME_PROXY_TOKEN=<the same token from apps/proxy/.bearer-token>
   GATEWAY_PORT=8788
   ```

5. **Add a DNS A record** for whatever subdomain you want (e.g. `pieces.yourdomain.com`)
   pointing at the remote host's public IP, and a matching block in your Caddyfile:
   ```
   pieces.yourdomain.com {
       reverse_proxy pieces-gateway:8788
   }
   ```

6. **Build and start it**: `docker compose up -d --build pieces-gateway`, then
   `docker compose restart caddy` to pick up the new Caddyfile block. Watch
   `docker logs <caddy-container>` for `certificate obtained successfully` for your new
   hostname.

7. **Enroll a device**:
   ```bash
   docker exec --env-file apps/pieces-gateway/.env <gateway-container> npx tsx src/enroll-cli.ts "My Phone"
   ```
   This prints a device token — that's what goes in the phone's Setup screen alongside
   `https://pieces.yourdomain.com`.

To revoke a device later: `docker exec --env-file apps/pieces-gateway/.env <gateway-container> npx tsx src/revoke-cli.ts <deviceId>` (find the ID with `list-devices`).

## 3. Install the APK on your phone

A debug build already exists at
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` after running:

```bash
cd apps/mobile
npm install
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Sideload `app-debug.apk` onto your phone (enable "Install unknown apps" for whatever
transfer method you use — ADB, a file share, email to yourself, etc.).

## 4. Connect the app

Open the app → **Setup** tab. Same two fields either way — just different values:

**Plan A (on your home Wi-Fi):**
1. Server address: `http://<pc-lan-ip>:8787`
2. Token: the value from `apps/proxy/.bearer-token` on the PC

**Plan B (away from home, if you set it up):**
1. Server address: `https://pieces.yourdomain.com`
2. Token: the device token printed by `enroll-cli.ts`

Either way, tap **Test & Save** — it calls the server's unauthenticated `/mobile/health`
first to confirm reachability, then saves both values via Capacitor's native Preferences
storage. Once saved, **Status**, **Ask**, and **Recent** all use the saved address + token
automatically — switch between Plan A and Plan B any time by just changing Setup.

## Known limitations

- **Ask** currently returns "unavailable" for every query — PiecesOS's answer-generation
  endpoints (`/qgpt/relevance` with a search scope, `/qgpt/question`) return HTTP 500 on
  this install, most likely because no LLM model is configured. This is a PiecesOS-side
  gap, not a bug in the proxy or app — see `docs/ALLOWED_ROUTES.md` for the exact evidence
  and re-test once resolved. Status and Recent are fully functional today.
- **Plan A proxy uptime** depends on staying logged into Windows — it's registered to run
  at boot and logon (no stored password, by design), but has not yet been proven to
  survive a fully unattended reboot with nobody signing back in. See `docs/ACCEPTANCE.md`
  for the exact gap and how to test it.
- **Plan B has not been tested from an actual phone on cellular/off-LAN network** — every
  Plan B behavior documented in `docs/ACCEPTANCE.md` was verified via `curl`, not from the
  installed APK itself.
