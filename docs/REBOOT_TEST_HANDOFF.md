# Reboot test — proxy auto-start verification

Context for whoever (Claude or Michael) picks this up after the PC reboots.

## Round 2 findings (2026-07-30, ~05:25 AM, after the first real reboot)

The first reboot test happened (confirmed via `LastBootUpTime`, uptime ~14 min
at check time). Results:

- **The scheduled task DID fire** — `Get-ScheduledTaskInfo` showed
  `LastRunTime` ~14s after boot, `LastTaskResult: 0`. Earlier assumption in
  this doc ("never run") was wrong — it was based on absent evidence (event
  log was disabled), not confirmed absence.
- **But the proxy was NOT listening on 8787** after boot. A node process WAS
  running, but investigation (`Get-CimInstance Win32_Process -Filter
  "ProcessId = ..."` for the real command line, not the truncated
  `Get-Process` one) showed it was `openclaw gateway --port 18789` —
  completely unrelated. The actual proxy process was not present.
- `service-wrapper.ps1` had **zero output capture** — no way to see why it
  failed silently at boot. Manually re-running the exact same script
  interactively worked fine (proxy came up, `{"ok":true}`), so the script
  itself isn't broken — something about the **boot-time S4U session context**
  specifically breaks it (S4U runs logged-out, before the user profile is
  fully loaded — candidates: OneDrive Files-On-Demand hydration timing for
  the synced repo path, `npx`/node PATH resolution differences in that
  session type, or a race with network/PiecesOS not being up yet).
- **Fixed**: rewrote `service-wrapper.ps1` to log everything to
  `~/.claude/pieces-proxy-service.log` — start marker, full PATH, working
  dir before/after `Set-Location`, token file existence check, all
  `npx tsx` stdout/stderr, and an exit-code marker. Verified via a detached
  `Start-Process` launch (mimics how Task Scheduler invokes it) — worked
  correctly outside the S4U context, confirming the logging itself is sound
  and will actually capture the real failure next boot.
- Committed as `7168bd3`.

**Next step for round 3**: reboot again, then check
`~/.claude/pieces-proxy-service.log` — it should now show exactly what
`npx tsx` did or didn't do at boot time. If the log file doesn't even exist
after reboot, the wrapper script itself never launched (task-definition/
trigger issue, not a script bug) — check `Get-ScheduledTaskInfo` and the
Task Scheduler event log again in that case.

## What we're testing

Whether the `PiecesAndroidProxy` Windows Scheduled Task actually brings the
proxy up on its own after a reboot, with nobody signing back in and running
it manually. This has never been conclusively verified — `docs/ACCEPTANCE.md`
flagged it as an open gap, and Task Scheduler's history logging was OFF by
default the whole time, so there's no event-log record either way.

## What was done just before the reboot (2026-07-30)

1. Confirmed `Microsoft-Windows-TaskScheduler/Operational` log was disabled
   (`Get-WinEvent -ListLog ... | Select IsEnabled` → `False`).
2. Enabled it: `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`
   (if this hasn't actually been run yet, run it before rebooting again).
3. Rebooted the PC.

## What to check after reboot, without signing in manually if possible (or immediately after signing in)

1. **Is the proxy actually listening?**
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue
   ```
   or from another device on the LAN: `curl http://192.168.50.104:8787/mobile/health`
   (LAN IP may have changed — check `ipconfig` if that fails)

2. **Did the scheduled task actually fire?**
   ```powershell
   Get-ScheduledTaskInfo -TaskName "PiecesAndroidProxy" | Select LastRunTime, LastTaskResult
   Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'} -MaxEvents 50 |
     Where-Object { $_.Message -match "PiecesAndroidProxy" } | Select TimeCreated, Id, Message
   ```

3. **If it didn't fire or the proxy isn't up**, check:
   - `apps/proxy/scripts/service-wrapper.ps1` — does it actually run the proxy correctly headless?
   - Whether the proxy's working directory (OneDrive-synced path) was fully
     hydrated at boot time — `docs/ACCEPTANCE.md` flagged OneDrive
     Files-On-Demand placeholders as a specific risk for S4U tasks that run
     before anyone signs in.
   - `PROXY_BEARER_TOKEN` env var — how does the wrapper script supply this
     at boot? (worth checking it's not depending on a user-session env var
     that doesn't exist yet at S4U/boot time)

## Where things stood otherwise (2026-07-30 session)

- PiecesOS asset flood (582 test-session telemetry rows) was cleaned up —
  580 deleted via PiecesOS's real `/assets/{id}/delete` API, 5 legitimate
  assets preserved and verified clean. Full DB backup at
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
