# Restarts the PiecesAndroidProxy task by killing its node process and
# re-starting it. Runs elevated itself (S4U + RunLevel Highest), so it can
# stop a process owned by another elevated S4U task even when invoked from
# a non-elevated caller - Task Scheduler does the privileged kill, not us.
$task = Get-ScheduledTask -TaskName "PiecesAndroidProxy" -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName "PiecesAndroidProxy" -ErrorAction SilentlyContinue
}

# The proxy binds 0.0.0.0:8787 - find and kill whatever currently holds that
# port rather than guessing which node PID is the right one (multiple node
# processes may be running for unrelated reasons).
$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    foreach ($procId in ($conn.OwningProcess | Select-Object -Unique)) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName "PiecesAndroidProxy"
