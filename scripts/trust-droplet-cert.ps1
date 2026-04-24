# =============================================================================
# trust-droplet-cert.ps1 — Install the Droplet's TLS cert into the Windows
# LocalMachine Root store so https://droplet-ai.local / https://droplet-ai.lan
# stop showing the "Not secure" browser warning.
#
# Must run as Administrator (writing to LocalMachine\Root requires elevation).
#
# Usage (elevated PowerShell):
#   .\scripts\trust-droplet-cert.ps1
#   .\scripts\trust-droplet-cert.ps1 -Host droplet-ai.lan
#   .\scripts\trust-droplet-cert.ps1 -Uninstall
#
# Why this exists:
#   The Droplet ships a self-signed cert. Chromium / Edge / Firefox warn on
#   self-signed certs even when the hostname matches — the only way to clear
#   the warning without a public CA is to tell Windows to trust this specific
#   cert as a root. That's what this script does, per-client, one-time.
# =============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$HostName = "droplet-ai.local",

    [Parameter(Mandatory=$false)]
    [switch]$Uninstall
)

# Stable Subject used by scripts/lib/secrets.sh: -subj "/CN=Droplet Edge Device"
$CertSubject = "CN=Droplet Edge Device"
$StoreLocation = "LocalMachine"
$StoreName = "Root"

# --- Elevation check (LocalMachine\Root requires admin) ---
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must run as Administrator. Right-click PowerShell and 'Run as administrator', then re-run."
    exit 1
}

if ($Uninstall) {
    Write-Host "Removing certs with Subject '$CertSubject' from $StoreLocation\$StoreName ..."
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $matches = $store.Certificates | Where-Object { $_.Subject -eq $CertSubject }
    if ($matches.Count -eq 0) {
        Write-Host "note: no cert with Subject '$CertSubject' found — nothing to uninstall."
    } else {
        foreach ($cert in $matches) {
            $store.Remove($cert)
            Write-Host "  removed: Thumbprint=$($cert.Thumbprint)"
        }
        Write-Host "ok: uninstall complete."
    }
    $store.Close()
    return
}

# --- Fetch cert over TLS ---
# TcpClient + SslStream so we don't need external tools (openssl, curl). We
# pass a permissive validator because the whole point is to grab a cert we
# don't yet trust — validation would reject it.
Write-Host "Fetching cert from https://${HostName}:443 ..."
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect($HostName, 443)
    $ssl = New-Object System.Net.Security.SslStream(
        $tcp.GetStream(),
        $false,
        { param($sender, $cert, $chain, $errors) $true }
    )
    # SNI — some servers route by hostname
    $ssl.AuthenticateAsClient($HostName)
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
    $ssl.Close()
    $tcp.Close()
} catch {
    Write-Error "Could not fetch cert from ${HostName}:443 — is the Droplet online and reachable by DNS? ($_)"
    exit 2
}

if (-not $cert -or -not $cert.Subject) {
    Write-Error "No certificate came back from ${HostName}:443."
    exit 3
}

Write-Host "Got cert:"
Write-Host "  Subject:    $($cert.Subject)"
Write-Host "  Issuer:     $($cert.Issuer)"
Write-Host "  Thumbprint: $($cert.Thumbprint)"
Write-Host "  Valid:      $($cert.NotBefore) -> $($cert.NotAfter)"
$sanExt = $cert.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" }
if ($sanExt) {
    Write-Host "  SAN:        $($sanExt.Format($false))"
}

# --- Install into LocalMachine\Root ---
Write-Host "Installing into $StoreLocation\$StoreName ..."
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

# Idempotent: if a cert with the same thumbprint is already there, skip.
$existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($existing) {
    Write-Host "ok: this exact cert (Thumbprint=$($cert.Thumbprint)) is already trusted — nothing to do."
} else {
    $store.Add($cert)
    Write-Host "ok: cert installed as trusted root."
    Write-Host ""
    Write-Host "Next: close and reopen your browser so it re-reads the trust store."
    Write-Host "      https://${HostName}/ should now load without a security warning."
}
$store.Close()
