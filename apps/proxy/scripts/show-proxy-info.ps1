# Shows a "Scan to Connect" QR code (and a manual fallback) for the
# pieces-android-shizuku-monitor app's Setup screen. Starts the proxy first
# (detached, independent of this script/terminal) if it isn't already up.
#
# Uses the Remote (gateway/JWT) address - fixed hostname, works away from
# home too, and doesn't change even when the LAN IP drifts on DHCP renewal.
# The QR payload is {"baseUrl": "...", "token": "..."} JSON, matching
# apps/mobile/src/lib/connectionQr.ts's parser exactly.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

trap {
    [System.Windows.Forms.MessageBox]::Show(
        "Script error:`n$($_ | Out-String)",
        "Pieces Android Proxy - Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

# $PSScriptRoot is this file's own directory (apps/proxy/scripts) - see
# service-wrapper.ps1 for why ProxyDir is derived rather than hardcoded.
$ProxyDir = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $ProxyDir ".bearer-token"
$GatewayTokenFile = Join-Path $PSScriptRoot ".gateway-token"
# Your gateway's public hostname (see apps/pieces-gateway's README/deploy
# docs) - no generic default is possible since this is genuinely per-user
# infra. Resolution order: PIECES_GATEWAY_URL env var, then a gitignored
# local-config.ps1 next to this script (see local-config.ps1.example),
# then a placeholder that fails loudly rather than silently pointing at
# someone else's server.
$LocalConfigPath = Join-Path $PSScriptRoot "local-config.ps1"
if (Test-Path $LocalConfigPath) { . $LocalConfigPath }
$GatewayUrl = if ($env:PIECES_GATEWAY_URL) {
    $env:PIECES_GATEWAY_URL
} elseif ($PiecesGatewayUrl) {
    $PiecesGatewayUrl
} else {
    "https://your-gateway-hostname.example.com"
}
$StartScript = Join-Path $PSScriptRoot "start-proxy-detached.ps1"
$QrScript = Join-Path $PSScriptRoot "generate-connect-qr.mjs"
$QrOutPath = Join-Path $env:TEMP "pieces-connect-qr.png"
$Port = 8787

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    powershell.exe -ExecutionPolicy Bypass -File $StartScript | Out-Null
    Start-Sleep -Seconds 2
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "<Wi-Fi not connected - check network>" }

$token = if (Test-Path $TokenFile) { (Get-Content $TokenFile -Raw).Trim() } else { "<token file missing>" }
$gatewayToken = if (Test-Path $GatewayTokenFile) { (Get-Content $GatewayTokenFile -Raw).Trim() } else { $null }

$stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$status = if ($stillListening) { "RUNNING" } else { "NOT RUNNING - check pieces-proxy-service.log" }

if ($gatewayToken) {
    node $QrScript $GatewayUrl $gatewayToken $QrOutPath 2>&1 | Out-Null
}

if ($gatewayToken -and (Test-Path $QrOutPath)) {
    # A borderless image window is friendlier for "hold your phone up to
    # this" than a MessageBox's fixed icon/button chrome around a picture.
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Pieces Android Proxy - Scan to Connect"
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.AutoSize = $true
    $form.AutoSizeMode = "GrowAndShrink"

    $img = [System.Drawing.Image]::FromFile($QrOutPath)
    $picture = New-Object System.Windows.Forms.PictureBox
    $picture.Image = $img
    $picture.SizeMode = "AutoSize"
    $picture.Top = 10
    $picture.Left = 10

    $label = New-Object System.Windows.Forms.Label
    $label.Text = "Status: $status`nOpen the app -> Setup -> Scan to Connect, then point at this code.`nNo Scan button yet? Use the LAN fallback below."
    $label.AutoSize = $true
    $label.Top = $img.Height + 20
    $label.Left = 10

    $fallback = New-Object System.Windows.Forms.Label
    $fallback.Text = "LAN fallback (same Wi-Fi only): http://${ip}:${Port}"
    $fallback.AutoSize = $true
    $fallback.Top = $img.Height + 70
    $fallback.Left = 10

    $form.Controls.Add($picture)
    $form.Controls.Add($label)
    $form.Controls.Add($fallback)
    $form.ShowDialog() | Out-Null
    $img.Dispose()
} else {
    # No gateway token enrolled yet, or QR generation failed - fall back to
    # the plain-text overview so this is never a dead end.
    $overview = @"
Status: $status

--- Remote (use this one - works anywhere, address never changes) ---
Address: $GatewayUrl
Token:   $(if ($gatewayToken) { $gatewayToken } else { "<not enrolled yet>" })

--- LAN only (same Wi-Fi, IP can drift on DHCP renewal) ---
Address: http://${ip}:${Port}
Token:   $token
"@
    [System.Windows.Forms.MessageBox]::Show(
        $overview,
        "Pieces Android Proxy",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}
