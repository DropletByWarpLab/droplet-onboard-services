#!/usr/bin/env bash
# =============================================================================
# trust-droplet-cert.sh — Install the Droplet's TLS cert into the client's
# system trust store so https://droplet-ai.local and https://droplet-ai.lan
# stop showing the "Not secure" browser warning.
#
# BOOTSTRAP-WINDOW / AIR-GAPPED FALLBACK ONLY (ADR-023).
#   You normally do NOT need this. The Droplet now obtains a publicly-trusted
#   certificate automatically (HQ-mediated ACME), so every client gets a green
#   padlock at home AND over the VPN with no per-device install. Use this script
#   only in two cases:
#     1. The bootstrap window — the few minutes after setup before the first
#        trusted cert is issued, when the box still serves the self-signed cert.
#     2. An air-gapped / HQ-unreachable box that can never obtain a public cert.
#   On a normally-connected box, just wait for the padlock to turn green.
#
# Why this exists (the fallback case):
#   In those two cases the Droplet serves a self-signed cert for its own
#   hostnames (droplet-ai.local, droplet-ai.lan, droplet.local, droplet.lan,
#   localhost, the per-device FQDN, +IPs). Browsers warn on self-signed certs
#   even when the hostname matches — the only way to clear the warning without a
#   public CA is to tell the client OS to trust this specific cert as a root.
#   That's what this script does, per-client, one-time.
#
# Platforms:
#   - Linux (Debian/Ubuntu and Fedora/RHEL families)
#   - macOS (system keychain, admin required)
#   - Windows: use trust-droplet-cert.ps1 instead (PowerShell, admin required)
#
# Usage:
#   ./scripts/trust-droplet-cert.sh                    # fetches from droplet-ai.local
#   ./scripts/trust-droplet-cert.sh droplet-ai.lan     # explicit host
#   ./scripts/trust-droplet-cert.sh --uninstall        # remove from trust store
#
# The cert is fetched from the running device over the network (not from the
# repo) so the script works on any client without filesystem access to the
# appliance.
# =============================================================================
set -euo pipefail

HOST="${1:-droplet-ai.local}"
UNINSTALL=false
if [ "${1:-}" = "--uninstall" ]; then
  UNINSTALL=true
  HOST="${2:-droplet-ai.local}"
fi

# A stable CN we match on for uninstall. Must align with _generate_tls_cert's
# -subj "/CN=Droplet Edge Device" in scripts/lib/secrets.sh.
CERT_SUBJECT_CN="Droplet Edge Device"

# --- Fetch cert (unless uninstalling) ---
CERT_TMP=""
cleanup() { [ -n "$CERT_TMP" ] && rm -f "$CERT_TMP"; }
trap cleanup EXIT

if [ "$UNINSTALL" = false ]; then
  CERT_TMP="$(mktemp -t droplet-cert.XXXXXX.crt 2>/dev/null || mktemp)"
  echo "Fetching cert from https://${HOST}:443 ..."
  # `-showcerts` prints the leaf + any intermediate chain the server sends.
  # For self-signed we only need the leaf — awk picks the first BEGIN/END
  # block. `-servername` drives SNI so multi-name routing works.
  if ! openssl s_client -connect "${HOST}:443" -servername "$HOST" -showcerts \
         </dev/null 2>/dev/null \
       | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/ {print}' \
       | awk 'BEGIN{n=0} /-----BEGIN CERTIFICATE-----/{n++} n==1{print}' > "$CERT_TMP"; then
    echo "error: could not reach ${HOST}:443 — is the Droplet online and DNS working?" >&2
    exit 1
  fi
  if ! [ -s "$CERT_TMP" ] || ! openssl x509 -in "$CERT_TMP" -noout 2>/dev/null; then
    echo "error: did not get a valid certificate back from ${HOST}:443" >&2
    exit 1
  fi

  local_subject="$(openssl x509 -in "$CERT_TMP" -noout -subject 2>/dev/null | sed 's/^subject=//')"
  echo "Got cert: ${local_subject}"
fi

# --- Platform detection + install ---
os="$(uname -s)"

case "$os" in
  Linux*)
    if [ -f /etc/debian_version ]; then
      target_dir="/usr/local/share/ca-certificates"
      target_file="${target_dir}/droplet-edge.crt"
      refresh_cmd="update-ca-certificates"
    elif [ -f /etc/redhat-release ] || [ -d /etc/pki/ca-trust/source/anchors ]; then
      target_dir="/etc/pki/ca-trust/source/anchors"
      target_file="${target_dir}/droplet-edge.crt"
      refresh_cmd="update-ca-trust extract"
    else
      echo "error: unrecognized Linux distro (no /etc/debian_version, no /etc/pki/ca-trust)" >&2
      echo "       install the cert manually into your distro's CA trust store:" >&2
      [ -n "$CERT_TMP" ] && echo "       $CERT_TMP" >&2
      exit 2
    fi

    if [ "$UNINSTALL" = true ]; then
      if [ -f "$target_file" ]; then
        echo "Removing ${target_file} ..."
        sudo rm -f "$target_file"
        sudo $refresh_cmd >/dev/null
        echo "ok: cert removed from the system trust store"
      else
        echo "note: ${target_file} not present — nothing to uninstall"
      fi
    else
      echo "Installing into ${target_dir} (sudo may prompt) ..."
      sudo install -o root -g root -m 644 "$CERT_TMP" "$target_file"
      sudo $refresh_cmd >/dev/null
      echo "ok: cert installed, trust store refreshed"
      echo "Next: restart your browser so it re-reads the system trust store."
    fi
    ;;

  Darwin*)
    # macOS: System keychain. `security` requires sudo for the system store.
    if [ "$UNINSTALL" = true ]; then
      echo "Removing Droplet Edge cert from /Library/Keychains/System.keychain ..."
      sudo security delete-certificate -c "$CERT_SUBJECT_CN" \
        /Library/Keychains/System.keychain 2>/dev/null || {
          echo "note: no cert with CN=${CERT_SUBJECT_CN} found — nothing to uninstall"
          exit 0
        }
      echo "ok: cert removed"
    else
      echo "Adding to /Library/Keychains/System.keychain as trusted root (sudo will prompt) ..."
      sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT_TMP"
      echo "ok: cert installed and marked as trusted root"
      echo "Next: restart your browser so it re-reads the keychain."
    fi
    ;;

  CYGWIN*|MINGW*|MSYS*)
    echo "error: this script doesn't install on Windows from bash — use the PowerShell version:" >&2
    echo "         scripts/trust-droplet-cert.ps1" >&2
    echo "         (must run as Administrator)" >&2
    exit 3
    ;;

  *)
    echo "error: unsupported OS: $os" >&2
    exit 4
    ;;
esac
