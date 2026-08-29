# Starts the pieces proxy as a detached background process, independent of
# any terminal/IDE that launched it. Safe to run even if the proxy is
# already up (checks the port first).

# $PSScriptRoot is this file's own directory (apps/proxy/scripts) - see
# service-wrapper.ps1 for why ProxyDir is derived rather than hardcoded.
$ProxyDir = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $ProxyDir ".bearer-token"
$LogFile = Join-Path $env:USERPROFILE ".claude\pieces-proxy-service.log"
$Port = 8787

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "Proxy already listening on port $Port (PID $($listening[0].OwningProcess)) — not starting a second copy."
    exit 0
}

if (-not (Test-Path $TokenFile)) {
    Write-Host "No token file at $TokenFile — generating one."
    node "$ProxyDir\scripts\generate-token.mjs" | Out-File -FilePath $TokenFile -Encoding ascii -NoNewline
}

$token = (Get-Content $TokenFile -Raw).Trim()

"=== $(Get-Date -Format o) start-proxy-detached launching ===" | Out-File -FilePath $LogFile -Append

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "powershell.exe"
$psi.Arguments = "-NoProfile -WindowStyle Hidden -Command `"`$env:PROXY_BEARER_TOKEN='$token'; Set-Location '$ProxyDir'; npx tsx src/server.ts *>> '$LogFile'`""
$psi.WorkingDirectory = $ProxyDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

[System.Diagnostics.Process]::Start($psi) | Out-Null

Start-Sleep -Seconds 2
$nowListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($nowListening) {
    Write-Host "Proxy started, listening on port $Port."
} else {
    Write-Host "Proxy did not come up yet — check $LogFile"
}
