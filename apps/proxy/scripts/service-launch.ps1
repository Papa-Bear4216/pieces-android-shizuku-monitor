# Invoked by the PiecesAndroidProxy scheduled task. A deliberately minimal
# replacement for service-wrapper.ps1, which hung before its first log line
# when run in the task's non-interactive S4U/hidden-window context (cause never
# reproduced under inspection; four restart cycles burned on it).
#
# Differences from the old wrapper:
#   - No restart loop. The scheduled task's own RestartCount=3 / RestartInterval=1m
#     handles a crashed server. One less competing restart mechanism.
#   - No `npx`. Calls node + the tsx ESM loader directly by absolute path, so
#     nothing depends on npx being resolvable or on a package.json script.
#   - Stale-port cleanup uses `netstat` text parsing, not Get-NetTCPConnection
#     (whose underlying CIM call can block indefinitely in this context).
#   - Every step is wrapped so a failure logs and exits non-zero (task retries)
#     rather than hanging.

$ErrorActionPreference = 'Continue'

$ProxyDir  = Split-Path -Parent $PSScriptRoot
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $ProxyDir)  # apps/proxy -> apps -> repo root
$TokenFile = Join-Path $ProxyDir '.bearer-token'
$LogFile   = Join-Path $env:USERPROFILE '.claude\pieces-proxy-service.log'
$NodeExe   = Join-Path $env:ProgramFiles 'nodejs\node.exe'
# tsx deps are hoisted to the monorepo root, not apps/proxy/node_modules.
# cli.mjs is what `npx tsx` executes - hand it directly to node.
$TsxCli    = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
$Server    = Join-Path $ProxyDir 'src\server.ts'

function Log($msg) {
    try { "$(Get-Date -Format o)  $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}

Log "=== service-launch starting (pid $PID) ==="

foreach ($p in @($NodeExe, $TokenFile, $TsxCli, $Server)) {
    if (-not (Test-Path $p)) { Log "FATAL: missing $p"; exit 1 }
}

$token = (Get-Content $TokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { Log "FATAL: empty token file"; exit 1 }
$env:PROXY_BEARER_TOKEN = $token

# Kill any process already listening on 8787. netstat -ano is a plain child
# process that always returns promptly, unlike Get-NetTCPConnection here.
try {
    $lines = & netstat -ano -p TCP | Select-String ':8787\s+.*LISTENING'
    foreach ($ln in $lines) {
        $stalePid = ($ln.ToString() -split '\s+')[-1]
        if ($stalePid -match '^\d+$' -and [int]$stalePid -ne $PID) {
            Log "killing stale :8787 listener pid $stalePid"
            & taskkill /F /PID $stalePid 2>&1 | Out-Null
        }
    }
    Start-Sleep -Seconds 1
} catch {
    Log "stale-port cleanup skipped: $($_.Exception.Message)"
}

Set-Location $ProxyDir
Log "launching: node $TsxCli $Server"

# Exec node (running the tsx CLI) in the foreground. When it exits, this script
# exits with the same code and the scheduled task applies its restart policy.
& $NodeExe $TsxCli $Server *>> $LogFile
$code = $LASTEXITCODE
Log "=== node/tsx exited with code $code ==="
exit $code
