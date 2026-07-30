# Reboot test — proxy auto-start verification

Context for whoever (Claude or Michael) picks this up.

## Status: CONFIRMED WORKING (2026-07-30)

The `PiecesAndroidProxy` Windows Scheduled Task reliably brings the proxy up
on boot with nobody signed in. This was an open gap flagged in
`docs/ACCEPTANCE.md` — it's now closed. No further action needed on this
specific item unless it's observed to fail again.

## What we tested and found

Task Scheduler's history logging was OFF by default the whole time, so
there was no event-log record of whether the scheduled task had ever
actually fired — an earlier working assumption that it "never ran" was
wrong, just based on absent evidence. Fixed by enabling the log:
```powershell
wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true
```

**Round 1 reboot**: task fired (`LastRunTime` ~14s after boot,
`LastTaskResult: 0`), but the proxy wasn't listening on 8787 afterward. A
node process was running, but turned out to be an unrelated tool
(`openclaw gateway --port 18789`), not the proxy at all — the actual proxy
process was never present. `service-wrapper.ps1` had zero output capture,
so there was no way to see why it failed silently at boot.

**Fix**: rewrote `apps/proxy/scripts/service-wrapper.ps1` (commit
`7168bd3`) to log everything to `~/.claude/pieces-proxy-service.log` —
start marker, full PATH, working directory before/after `Set-Location`,
token file existence check, all `npx tsx` stdout/stderr, and an exit-code
marker.

**Round 2 reboot** (~05:41 AM): log shows a fresh `service-wrapper starting`
entry ~34s after boot, with `PWD before Set-Location: C:\WINDOWS\system32`
(confirming a genuine boot-time S4U launch, not a manual test). ProxyDir
and TokenFile both existed, `Set-Location` succeeded, and the log ends with
`pieces-android proxy listening on 0.0.0.0:8787`. Verified independently
minutes later: `curl http://127.0.0.1:8787/mobile/health` → `{"ok":true}`.

The round-1 failure looks like a one-off/transient issue at that specific
boot rather than a structural problem — the logging fix is what made it
possible to tell "never ran" apart from "ran, but something failed," and
is worth keeping in place as an early-warning signal if this ever
regresses.

## If it ever fails again, check

1. **Is the proxy listening?**
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue
   ```
   or from another device on the LAN: `curl http://<pc-lan-ip>:8787/mobile/health`

2. **Did the scheduled task fire, and what did it log?**
   ```powershell
   Get-ScheduledTaskInfo -TaskName "PiecesAndroidProxy" | Select LastRunTime, LastTaskResult
   Get-Content "$env:USERPROFILE\.claude\pieces-proxy-service.log" -Tail 50
   ```
   If the log file doesn't exist at all after a reboot, the wrapper script
   itself never launched (task-definition/trigger issue) — check
   `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'}`
   for `PiecesAndroidProxy` entries.

3. **Other known risk factors** (from `docs/ACCEPTANCE.md`): the proxy's
   working directory lives under OneDrive — Files-On-Demand hydration
   timing could theoretically cause a boot-time failure if the repo isn't
   fully synced yet; `PROXY_BEARER_TOKEN` is read from a token file on disk
   specifically because S4U sessions have no interactive user env vars.

## Where things stood otherwise (2026-07-30 session)

- PiecesOS asset flood (582 test-session telemetry rows) was cleaned up —
  580 deleted via PiecesOS's real `/assets/{id}/delete` API, 5 legitimate
  assets preserved and verified clean beforehand. Full DB backup at
  `Pieces OS/com.pieces.os/production/Backups/manual-precleanup-20260729-214702`.
- Screen-context capture (Accessibility Service) was decoupled from Shizuku —
  now an independent opt-in via Setup, no Shizuku/ADB required. Shizuku
  toolkit is now just an optional add-on (shell diagnostics + auto-re-enable
  convenience).
- Lock-screen capture blocked (`KeyguardManager.isKeyguardLocked()` check)
  and messaging/email/social apps added to the capture exclusion list, after
  passive mode + "Select all" leaked SMS previews into PiecesOS during
  testing.
- All of the above is committed to `master` on the local `pieces-android`
  repo (not yet pushed anywhere public).
