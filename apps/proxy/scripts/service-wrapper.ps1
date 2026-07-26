# Invoked by the PiecesAndroidProxy scheduled task. Reads the bearer token
# from disk (a scheduled task running logged-out has no interactive env var
# to read) and starts the proxy server.

$ProxyDir = "C:\Users\micha\OneDrive\Desktop\projects\pieces-android\apps\proxy"
$TokenFile = Join-Path $ProxyDir ".bearer-token"

if (-not (Test-Path $TokenFile)) {
    Write-Error "Token file missing at $TokenFile - run register-service.ps1 first."
    exit 1
}

$token = (Get-Content $TokenFile -Raw).Trim()
$env:PROXY_BEARER_TOKEN = $token

Set-Location $ProxyDir
npx tsx src/server.ts
