# Reboot test — proxy auto-start verification

Context for whoever (Claude or Michael) picks this up after the PC reboots.

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
