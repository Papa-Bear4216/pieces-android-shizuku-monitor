# Runs every 2 minutes (PiecesAndroidProxyWatchdog scheduled task).
#
# The proxy's own server.ts installs a process-wide uncaughtException handler
# that swallows every error to "stay alive". Under real phone traffic (flaky
# wifi, app backgrounding, half-open sockets) this trades a clean crash for a
# wedged process: still LISTENING on 8787, Node event loop stalled, every
# request - even the no-op /mobile/health - hangs until the client times out.
# The scheduled task's RestartCount only fires when the process EXITS, which a
# wedged process never does. This watchdog is the missing piece: detect the
# wedge from outside and force a restart.
#
# Deliberately dumb and self-contained: two short health probes, and only if
# BOTH fail does it recycle the proxy. One transient failure (PiecesOS
# restarting, a GC pause) is ignored.

$ErrorActionPreference = 'Continue'

$HealthUrl = 'http://127.0.0.1:8787/mobile/health'
$TaskName  = 'PiecesAndroidProxy'
$LogFile   = Join-Path $env:USERPROFILE '.claude\pieces-proxy-watchdog.log'

function Log($msg) {
    try { "$(Get-Date -Format o)  $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}

function Test-ProxyHealthy {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true')
    } catch {
        return $false
    }
}

if (Test-ProxyHealthy) { exit 0 }

Start-Sleep -Seconds 5
if (Test-ProxyHealthy) { exit 0 }

Log "proxy unhealthy on both probes - recycling"

# Stop the task, then hard-kill anything still holding 8787 (the wedged process
# will not exit on Stop-ScheduledTask alone).
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2

try {
    $lines = & netstat -ano -p TCP | Select-String ':8787\s+.*LISTENING'
    foreach ($ln in $lines) {
        $stalePid = ($ln.ToString() -split '\s+')[-1]
        if ($stalePid -match '^\d+$') {
            Log "killing pid $stalePid holding :8787"
            & taskkill /F /T /PID $stalePid 2>&1 | Out-Null
        }
    }
} catch { Log "port cleanup error: $($_.Exception.Message)" }

Start-Sleep -Seconds 2
try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log "restart issued" }
catch { Log "FAILED to start task: $($_.Exception.Message)"; exit 1 }

# Give it time to come back and record the outcome.
Start-Sleep -Seconds 25
if (Test-ProxyHealthy) { Log "recovered" } else { Log "still unhealthy after restart - will retry next run" }
exit 0
