# =============================================================================
# trust-droplet-cert.ps1 -- Install the Droplet's TLS cert into the Windows
# root store so https://droplet-ai.local / https://droplet-ai.lan stop showing
# the "Not secure" browser warning.
#
# BOOTSTRAP-WINDOW / AIR-GAPPED FALLBACK ONLY (ADR-023).
#   You normally do NOT need this. The Droplet now obtains a publicly-trusted
#   certificate automatically (HQ-mediated ACME), so Windows gets a green padlock
#   at home AND over the VPN with no install. Use this only during the bootstrap
#   window (the few minutes before the first trusted cert is issued) or on an
#   air-gapped / HQ-unreachable box. On a normal box, just wait for the padlock.
#
# By default installs into CurrentUser\Root (no admin needed). Pass
# -SystemWide from an elevated shell to trust for all users on the machine.
# Either way, Windows will show a one-time security prompt asking you to
# confirm the cert's thumbprint -- that prompt is by design and cannot be
# suppressed; the script prints the thumbprint so you can verify.
#
# Usage (normal PowerShell):
#   .\scripts\trust-droplet-cert.ps1
#   .\scripts\trust-droplet-cert.ps1 -HostName droplet-ai.lan
#   .\scripts\trust-droplet-cert.ps1 -Uninstall
#   .\scripts\trust-droplet-cert.ps1 -SystemWide       # elevated; all users
#
# Why this exists:
#   The Droplet ships a self-signed cert. Chromium / Edge / Firefox warn on
#   self-signed certs even when the hostname matches -- the only way to clear
#   the warning without a public CA is to tell Windows to trust this specific
#   cert as a root. That's what this script does, per-client, one-time.
# =============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$HostName = "droplet-ai.local",

    [Parameter(Mandatory=$false)]
    [switch]$Uninstall,

    # Install system-wide (LocalMachine\Root). Requires an elevated shell.
    # Default is per-user (CurrentUser\Root) so a single admin UAC prompt
    # isn't required for the common single-user-laptop case -- Chromium,
    # Edge, and the Windows API all honor the per-user store.
    [Parameter(Mandatory=$false)]
    [switch]$SystemWide
)

# Stable Subject used by scripts/lib/secrets.sh: -subj "/CN=Droplet Edge Device"
$CertSubject = "CN=Droplet Edge Device"
$StoreName = "Root"

# --- Pick a store location based on privileges ---
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if ($SystemWide) {
    if (-not $isAdmin) {
        Write-Error "-SystemWide requires an elevated shell. Right-click PowerShell and 'Run as administrator', then re-run."
        exit 1
    }
    $StoreLocation = "LocalMachine"
    Write-Host "Using system-wide trust store (LocalMachine\$StoreName)."
} else {
    $StoreLocation = "CurrentUser"
    if ($isAdmin) {
        Write-Host "Note: running elevated but installing into CurrentUser\$StoreName. Pass -SystemWide to install for all users."
    } else {
        Write-Host "Installing into CurrentUser\$StoreName (no admin needed). Pass -SystemWide from an elevated shell to trust for all users."
    }
}

if ($Uninstall) {
    Write-Host "Removing certs with Subject '$CertSubject' from $StoreLocation\$StoreName ..."
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $toRemove = $store.Certificates | Where-Object { $_.Subject -eq $CertSubject }
    if ($toRemove.Count -eq 0) {
        Write-Host "note: no cert with Subject '$CertSubject' found -- nothing to uninstall."
    } else {
        foreach ($cert in $toRemove) {
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
# don't yet trust -- validation would reject it.
Write-Host "Fetching cert from https://${HostName}:443 ..."
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect($HostName, 443)
    $ssl = New-Object System.Net.Security.SslStream(
        $tcp.GetStream(),
        $false,
        { param($sender, $cert, $chain, $errors) $true }
    )
    # SNI -- some servers route by hostname
    $ssl.AuthenticateAsClient($HostName)
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
    $ssl.Close()
    $tcp.Close()
} catch {
    Write-Error "Could not fetch cert from ${HostName}:443 -- is the Droplet online and reachable by DNS? ($_)"
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

# --- Install into the chosen root store ---
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

# Idempotent: if a cert with the same thumbprint is already there, skip.
$existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($existing) {
    Write-Host ""
    Write-Host "ok: this exact cert (Thumbprint=$($cert.Thumbprint)) is already trusted in $StoreLocation\$StoreName -- nothing to do."
    $store.Close()
    return
}

# Writing to CurrentUser\Root always shows a Windows security prompt:
#   "You are about to install a certificate from a certification authority
#    (CA) claiming to represent: Droplet Edge Device."
# That's by design -- Windows won't let a script silently add a root CA for
# the current user, and UAC elevation doesn't bypass it either. The user
# should verify the Thumbprint shown in the dialog matches the one we just
# printed above, then click Yes. This is a one-time, per-client step.
Write-Host ""
Write-Host "Installing into $StoreLocation\$StoreName ..."
Write-Host "Windows will now show a security prompt asking you to confirm."
Write-Host "Verify the Thumbprint in the dialog matches: $($cert.Thumbprint)"
Write-Host "Then click 'Yes' to complete the install."
Write-Host ""

try {
    $store.Add($cert)
} catch {
    Write-Error "Cert install was rejected or failed: $_"
    $store.Close()
    exit 5
}
$store.Close()

# Confirm the add actually landed (user could have clicked "No" on the
# Windows dialog, which silently rolls the operation back).
$verify = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
$verify.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
$landed = $verify.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
$verify.Close()

if ($landed) {
    Write-Host "ok: cert installed as trusted root in $StoreLocation\$StoreName."
    Write-Host ""
    Write-Host "Next: close and reopen your browser so it re-reads the trust store."
    Write-Host "      https://${HostName}/ should now load without a security warning."
} else {
    Write-Error "Install did not persist -- did you click 'No' on the Windows security dialog? Re-run to try again."
    exit 6
}
