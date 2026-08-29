# Invoked by the PiecesAndroidProxy scheduled task. Reads the bearer token
# from disk (a scheduled task running logged-out has no interactive env var
# to read) and starts the proxy server.
#
# Everything is logged to disk (stdout+stderr, plus a start/end marker with
# PATH and working-dir state) because a boot-time S4U task has no console to
# watch and LastTaskResult=0 only reflects powershell.exe's own exit code,
# not whether npx/tsx actually started the server successfully.

# $PSScriptRoot is this file's own directory (apps/proxy/scripts) - deriving
# ProxyDir from it instead of a hardcoded absolute path means this script
# works from any checkout location/username, not just the one it was
# originally written on.
$ProxyDir = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $ProxyDir ".bearer-token"
$LogFile = Join-Path $env:USERPROFILE ".claude\pieces-proxy-service.log"

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

"=== $(Get-Date -Format o) service-wrapper starting ===" | Out-File -FilePath $LogFile -Append
"PATH: $env:PATH" | Out-File -FilePath $LogFile -Append
"PWD before Set-Location: $(Get-Location)" | Out-File -FilePath $LogFile -Append
"ProxyDir exists: $(Test-Path $ProxyDir)" | Out-File -FilePath $LogFile -Append
"TokenFile exists: $(Test-Path $TokenFile)" | Out-File -FilePath $LogFile -Append

if (-not (Test-Path $TokenFile)) {
    "ERROR: Token file missing at $TokenFile - run register-service.ps1 first." | Out-File -FilePath $LogFile -Append
    exit 1
}

$token = (Get-Content $TokenFile -Raw).Trim()
$env:PROXY_BEARER_TOKEN = $token

Set-Location $ProxyDir
"PWD after Set-Location: $(Get-Location)" | Out-File -FilePath $LogFile -Append

# Restart-on-crash loop: a Scheduled Task only restarts if THIS wrapper
# process exits, but "this wrapper exits" is not the same event as "npx tsx
# crashed underneath it" - npx spawns node as a child and the wrapper can
# keep running past a child crash. Looping here catches every crash
# immediately instead of waiting for the task's own retry policy.
# Backoff avoids hammering restart attempts if something is fatally broken
# (e.g. a bad code change) - caps at 60s so a real recovery still comes back
# reasonably fast.
$backoffSeconds = 2
while ($true) {
    "=== $(Get-Date -Format o) launching npx tsx ===" | Out-File -FilePath $LogFile -Append
    $start = Get-Date
    try {
        npx tsx src/server.ts *>> $LogFile
        $exitCode = $LASTEXITCODE
    } catch {
        "EXCEPTION: $($_ | Out-String)" | Out-File -FilePath $LogFile -Append
        $exitCode = 1
    }
    $ranFor = (Get-Date) - $start
    "=== $(Get-Date -Format o) npx tsx exited with code $exitCode after $($ranFor.TotalSeconds)s ===" | Out-File -FilePath $LogFile -Append

    # A clean, long-lived run resets backoff; a fast crash-loop escalates it.
    if ($ranFor.TotalSeconds -gt 60) {
        $backoffSeconds = 2
    } else {
        $backoffSeconds = [Math]::Min($backoffSeconds * 2, 60)
    }

    "Restarting in ${backoffSeconds}s..." | Out-File -FilePath $LogFile -Append
    Start-Sleep -Seconds $backoffSeconds
}
