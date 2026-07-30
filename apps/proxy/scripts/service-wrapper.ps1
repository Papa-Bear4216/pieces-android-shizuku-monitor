# Invoked by the PiecesAndroidProxy scheduled task. Reads the bearer token
# from disk (a scheduled task running logged-out has no interactive env var
# to read) and starts the proxy server.
#
# Everything is logged to disk (stdout+stderr, plus a start/end marker with
# PATH and working-dir state) because a boot-time S4U task has no console to
# watch and LastTaskResult=0 only reflects powershell.exe's own exit code,
# not whether npx/tsx actually started the server successfully.

$ProxyDir = "C:\Users\micha\OneDrive\Desktop\projects\pieces-android\apps\proxy"
$TokenFile = Join-Path $ProxyDir ".bearer-token"
$LogFile = "C:\Users\micha\.claude\pieces-proxy-service.log"

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

try {
    Set-Location $ProxyDir
    "PWD after Set-Location: $(Get-Location)" | Out-File -FilePath $LogFile -Append
    npx tsx src/server.ts *>> $LogFile
    "=== $(Get-Date -Format o) npx tsx exited with code $LASTEXITCODE ===" | Out-File -FilePath $LogFile -Append
} catch {
    "EXCEPTION: $($_ | Out-String)" | Out-File -FilePath $LogFile -Append
    exit 1
}
