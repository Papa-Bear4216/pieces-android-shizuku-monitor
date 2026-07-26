# Run this manually in an ELEVATED PowerShell window (Run as Administrator).
# Restricts port 8787 to the Private network profile only, per Plan A constraint #5.
# Does NOT run automatically as part of any build/start script — review before applying.

New-NetFirewallRule -DisplayName "pieces-android proxy (8787, private only)" `
    -Direction Inbound `
    -LocalPort 8787 `
    -Protocol TCP `
    -Action Allow `
    -Profile Private

Write-Output "Firewall rule created: TCP 8787 allowed on Private profile only."
Write-Output "To remove it later: Remove-NetFirewallRule -DisplayName 'pieces-android proxy (8787, private only)'"
