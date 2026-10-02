#!/usr/bin/env bash
# droplet-tls-bootstrap-refresh.sh — make the self-signed bootstrap certificate
# name the box's CURRENT addresses, around the SAME key (WARP-2944, ADR-058).
#
# The bootstrap cert freezes its IP SANs at generation. A box that moves
# networks (or takes a new lease) then serves a certificate that no longer
# names its own address, and every app that pinned the box's key (the pairing
# QR's `spki=`, WARP-2953/2954) is refused BY NAME while the pin is right.
# scripts/lib/secrets.sh::_generate_tls_cert now regenerates around the
# existing key when the SAN is stale; this wrapper is how that runs OUTSIDE
# setup.sh: the device-bridge calls it when it sees the uplink address change
# (and once at boot), so a moved box heals in about a minute instead of at the
# next `setup.sh --sync-secrets`.
#
# Idempotent: a certificate that already names every current address is left
# untouched (no rewrite, no nginx reload). A public-CA leaf is never touched.
#
# REFRESH ONLY. This runs unattended, so it may do exactly one thing: re-issue
# a matching, self-signed pair around its own key. It refuses a pair it cannot
# read (a root-owned key after `sudo ./scripts/setup.sh` would otherwise read
# as torn, and a torn pair gets a NEW key — a silent identity rotation on a
# timer), and it refuses a torn pair outright (the LE issuance writes the key
# first and the cert second; "healing" that window would pair the public cert
# with the bootstrap key). Both are setup.sh --sync-secrets's job, by hand.
# _generate_tls_cert is told so with DROPLET_TLS_NO_NEWKEY=1 as a second lock.
# Installed to /usr/local/sbin by scripts/install-device-bridge.sh, removed by
# scripts/factory-reset.sh; repo source is scripts/host/ (architecture-guard
# rule 20). Mirrors droplet-tls-reload.sh in shape.
#
# Output: one JSON line, {"ok":true,"changed":<bool>,"pin":"<spki pin>"} on
# success (the pin so the caller can log continuity), or a message on failure.
# Exit 0 on success (changed or not), non-zero when the certificate could not
# be checked or regenerated.

set -euo pipefail

DRY_RUN="${DROPLET_TLS_REFRESH_DRY_RUN:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${REPO_ROOT:-}" ]; then
  if [ -f "$SCRIPT_DIR/../../docker/docker-compose.yml" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    REPO_ROOT="/home/droplet/edge-platform"
  fi
fi
export REPO_ROOT

LIB_DIR="${DROPLET_TLS_REFRESH_LIB_DIR:-}"
if [ -z "$LIB_DIR" ]; then
  if [ -f "$SCRIPT_DIR/../lib/secrets.sh" ]; then
    LIB_DIR="$(cd "$SCRIPT_DIR/../lib" && pwd)"
  else
    LIB_DIR="$REPO_ROOT/scripts/lib"
  fi
fi

log() { printf '[droplet-tls-bootstrap-refresh] %s\n' "$*" >&2; }

CERT="$REPO_ROOT/docker/certs/droplet.crt"
KEY="$REPO_ROOT/docker/certs/droplet.key"

if [ -n "$DRY_RUN" ]; then
  log "DRY RUN — would source $LIB_DIR/{logging,tls-reload,secrets}.sh and run _generate_tls_cert against $CERT"
  printf '{"ok":true,"changed":false,"dryRun":true}\n'
  exit 0
fi

for f in logging.sh tls-reload.sh secrets.sh; do
  if [ ! -f "$LIB_DIR/$f" ]; then
    log "canonical helper not found: $LIB_DIR/$f"
    printf '{"ok":false,"error":"helper missing: %s"}\n' "$f"
    exit 1
  fi
done

# A box with no certificate yet is setup.sh's job (the first install also
# seeds the .bootstrap side-copy and the .env); this wrapper only ever
# REFRESHES an installed self-signed pair.
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  log "no installed certificate pair at $CERT — nothing to refresh (setup.sh generates the first one)"
  printf '{"ok":true,"changed":false,"reason":"no certificate installed"}\n'
  exit 0
fi

pin_of() {
  openssl x509 -in "$1" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary 2>/dev/null | base64
}

# The pair must be OURS to read and rewrite, or this is not a refresh.
if [ ! -r "$KEY" ] || [ ! -r "$CERT" ] || [ ! -w "$(dirname "$KEY")" ]; then
  log "refusing: $KEY and $CERT must be readable, and $(dirname "$KEY") writable, by $(id -un) — a rewrite from here could mint a new key over one it cannot read"
  printf '{"ok":false,"error":"certificate pair not readable/writable by %s"}\n' "$(id -un)"
  exit 1
fi

before="$(sha256sum "$CERT" | cut -d' ' -f1)"
pin_before="$(pin_of "$CERT")"

# shellcheck source=../lib/logging.sh
. "$LIB_DIR/logging.sh"
# shellcheck source=../lib/tls-reload.sh
. "$LIB_DIR/tls-reload.sh"
# shellcheck source=../lib/secrets.sh
. "$LIB_DIR/secrets.sh"

if ! _tls_pair_matches "$CERT" "$KEY"; then
  log "refusing: certificate and key do not match — a torn pair is healed by setup.sh --sync-secrets, never unattended (this may be an issuance mid-write)"
  printf '{"ok":false,"error":"certificate/key pair does not match"}\n'
  exit 1
fi
if _cert_is_public_ca_leaf "$CERT"; then
  printf '{"ok":true,"changed":false,"reason":"public-CA leaf","pin":"%s"}\n' "$pin_before"
  exit 0
fi

# setup.sh learns the per-device FQDN (ADR-023 C2) by sourcing .env; the
# bridge's environment does not carry it, and a regeneration without it would
# drop the DNS SAN the issuance flow relies on. Read that one key, shaped
# like a hostname, and nothing else from the file.
if [ -z "${DROPLET_PUBLIC_FQDN:-}" ] && [ -r "$REPO_ROOT/.env" ]; then
  fq="$(sed -n "s/^DROPLET_PUBLIC_FQDN=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}\$/\1/p" "$REPO_ROOT/.env" | tail -n1)"
  case "$fq" in
    ""|*[!A-Za-z0-9.-]*|-*|.*) ;;
    *) export DROPLET_PUBLIC_FQDN="$fq" ;;
  esac
fi

# Second lock: even if the checks above are wrong about the pair, the
# generator itself will not mint a key for this caller.
export DROPLET_TLS_NO_NEWKEY=1

# _generate_tls_cert reloads the gateway itself when it regenerates.
if ! _generate_tls_cert >&2; then
  log "_generate_tls_cert failed"
  printf '{"ok":false,"error":"certificate refresh failed"}\n'
  exit 1
fi

after="$(sha256sum "$CERT" | cut -d' ' -f1)"
pin_after="$(pin_of "$CERT")"
changed=false
[ "$before" != "$after" ] && changed=true
if [ "$changed" = "true" ] && [ "$pin_before" != "$pin_after" ]; then
  # Should be impossible now (refused above, and the generator will not mint
  # for this caller) — if it ever prints, every pinned pairing will report
  # "identity changed", so it is a failure, not a note on a success line.
  log "ERROR: the served key changed ($pin_before -> $pin_after) — paired apps must re-pair by the QR"
  printf '{"ok":false,"error":"the served key changed","pin":"%s"}\n' "$pin_after"
  exit 1
fi
printf '{"ok":true,"changed":%s,"pin":"%s"}\n' "$changed" "$pin_after"
