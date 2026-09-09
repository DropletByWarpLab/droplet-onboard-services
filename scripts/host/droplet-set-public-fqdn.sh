#!/usr/bin/env bash
# =============================================================================
# ADR-023 PR-1 — Droplet public-FQDN write-back host executor
# =============================================================================
#
# The host-side entry point the orchestrator's tls-issuance service reaches (via
# the device-bridge's auth-gated POST /host/public-fqdn) once it has LEARNED the
# box's opaque per-device FQDN (`d-<hmac>.devices.warp-lab.ai`) from the HQ
# challenge response. It does three things:
#
#   1. Idempotently writes DROPLET_PUBLIC_FQDN=<fqdn> into the repo .env via the
#      canonical _upsert_env_kv (scripts/lib/secrets.sh) — symlink-preserving
#      and literal-safe (WARP-2537) — so the next orchestrator boot reads the
#      learned name directly instead of re-learning it from HQ.
#   2. Sources scripts/lib/local-dns.sh and runs setup_public_fqdn_dns so the
#      split-horizon DNS (host dnsmasq host-record + the routing/container leg)
#      registers the FQDN → 192.168.20.1 — the one name resolves at home AND
#      over the WireGuard tunnel.
#   3. Best-effort (WARP-986): re-runs droplet-openwrt-attach.service (when
#      passwordless sudo is available) so the dnsmasq-ap instance inside the
#      droplet-openwrt container — the ONLY resolver AP Wi-Fi clients use —
#      serves the name immediately instead of from the next boot.
#
# Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-public-fqdn.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# Usage:
#   droplet-set-public-fqdn.sh '<fqdn>'
#
# HARD VALIDATION (reject BEFORE writing): the orchestrator already validates,
# and the device-bridge re-validates before exec, but we validate a THIRD time
# here (defence in depth) — the value is interpolated into .env + a DNS payload,
# so it must be a strict opaque-per-device name or a conservative lowercase
# hostname. Anything with shell metacharacters / whitespace / uppercase / path
# traversal is refused and nothing is written.
#
# Test/dev hooks (so validation + upsert are unit-testable without root / DNS):
#   DROPLET_PUBLIC_FQDN_ENV_FILE=...  override the .env path (default <repo>/.env)
#   DROPLET_PUBLIC_FQDN_SKIP_DNS=1    write .env only; skip setup_public_fqdn_dns
#                                     AND the AP-resolver propagation leg
# =============================================================================
set -euo pipefail

FQDN="${1:-}"

err() { printf 'droplet-set-public-fqdn: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -n "$FQDN" ] || die "no fqdn given"

# --- Strict validation (opaque per-device OR conservative lowercase hostname) -
# Reject anything that isn't 1..253 chars of [a-z0-9.-], no leading/trailing dot
# or hyphen, and must contain a dot. The opaque shape is a subset of this.
# Matched with bash's [[ =~ ]] (whole-string, newline-safe) rather than a
# `printf | grep -q` pipe — grep is LINE-based, so a newline-bearing arg like
# 'evil.example<LF>KEY=injected' would pass a grep check on its first line and
# inject a second .env assignment (mirrors droplet-set-box-name.sh, WARP-988).
_fqdn_len=${#FQDN}
if [ "$_fqdn_len" -lt 1 ] || [ "$_fqdn_len" -gt 253 ]; then
  die "fqdn length out of range"
fi
if ! [[ "$FQDN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  die "fqdn '${FQDN}' contains invalid characters"
fi
case "$FQDN" in
  *.*) : ;;                       # must be a dotted name
  *)   die "fqdn '${FQDN}' is not a dotted hostname" ;;
esac

# --- Resolve the repo root + .env target ------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${REPO_ROOT:-}" ]; then
  if [ -f "$SCRIPT_DIR/../../docker/docker-compose.yml" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    REPO_ROOT="/home/droplet/edge-platform"
  fi
fi
export REPO_ROOT

ENV_FILE="${DROPLET_PUBLIC_FQDN_ENV_FILE:-$REPO_ROOT/.env}"

# --- Idempotent .env write-back (canonical upsert — WARP-2537) --------------
# This used to stage a temp file and `mv` it over $ENV_FILE. On a box where
# relocate_secrets_to_data has run, $ENV_FILE is a SYMLINK into the encrypted
# /data — mv REPLACED the link with a plain file on the unencrypted boot disk,
# moving the secrets back outside the LUKS boundary and breaking the compose
# `../.env` env_file (the WARP-232 regression class, closed for
# droplet-set-nvr-media.sh by WARP-2522). The sed splice above it was
# unreachable-by-luck rather than safe: the FQDN regex just above rejects every
# byte sed would have interpreted, so the write went through _because_ of the
# validation, not because the writer was correct.
#
# _upsert_env_kv (scripts/lib/secrets.sh) is the repo's one .env writer with the
# right discipline: it resolves a symlinked $ENV_FILE and renames onto the REAL
# target so the link survives, strips-and-appends with printf (no sed, so every
# byte of the value lands literally), normalizes a missing trailing newline
# first, and stages under umask 077 + chmod 600. Hard-fail when the lib cannot
# be found rather than fall back to a clobbering writer — same "refuse loudly"
# posture as the validation above. (The DNS legs below re-derive LIB_DIR against
# local-dns.sh, which is deliberately best-effort; the .env write is not.)
LIB_DIR="$SCRIPT_DIR/../lib"
if [ ! -f "$LIB_DIR/secrets.sh" ]; then
  LIB_DIR="$REPO_ROOT/scripts/lib"
fi
[ -f "$LIB_DIR/secrets.sh" ] || die "secrets.sh not found under $LIB_DIR — refusing to rewrite ${ENV_FILE} without the canonical symlink-preserving writer"
# shellcheck source=../lib/secrets.sh
. "$LIB_DIR/secrets.sh"

# Create the file if missing so a brand-new box can still record the name.
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

_desired="DROPLET_PUBLIC_FQDN=${FQDN}"
if grep -qxF "$_desired" "$ENV_FILE"; then
  : # already current — no rewrite (keeps re-runs byte-identical)
else
  # _upsert_env_kv targets $ENV_FILE when set — which this script always sets
  # (the DROPLET_PUBLIC_FQDN_ENV_FILE test hook included).
  _upsert_env_kv DROPLET_PUBLIC_FQDN "$FQDN"
fi
printf 'DROPLET_PUBLIC_FQDN persisted to %s\n' "$ENV_FILE"

# --- Register split-horizon DNS ---------------------------------------------
# Best-effort: a DNS failure must NOT fail the write-back (the .env is the
# durable record; DNS re-registers on the next setup run too). The
# DROPLET_PUBLIC_FQDN_SKIP_DNS hook lets the unit tests exercise the .env upsert
# without a live routing service / host dnsmasq.
if [ -n "${DROPLET_PUBLIC_FQDN_SKIP_DNS:-}" ]; then
  exit 0
fi

LIB_DIR="$SCRIPT_DIR/../lib"
if [ ! -f "$LIB_DIR/local-dns.sh" ]; then
  LIB_DIR="$REPO_ROOT/scripts/lib"
fi

if [ -f "$LIB_DIR/logging.sh" ] && [ -f "$LIB_DIR/local-dns.sh" ]; then
  # local-dns.sh's setup_public_fqdn_dns uses the log_* helpers from logging.sh.
  # Export the learned name + its target IP so the function picks them up.
  export DROPLET_PUBLIC_FQDN="$FQDN"
  export DROPLET_PUBLIC_FQDN_IP="${DROPLET_PUBLIC_FQDN_IP:-192.168.20.1}"
  # shellcheck source=../lib/logging.sh
  . "$LIB_DIR/logging.sh"
  # shellcheck source=../lib/local-dns.sh
  . "$LIB_DIR/local-dns.sh"
  setup_public_fqdn_dns || err "split-horizon DNS registration reported a problem (non-fatal)"
else
  err "local-dns helpers not found under $LIB_DIR — skipped DNS registration"
fi

# --- Propagate to the AP resolver (WARP-986) ---------------------------------
# NEITHER leg of setup_public_fqdn_dns reaches the dnsmasq-ap instance inside
# the droplet-openwrt container — the ONLY resolver AP (Wi-Fi) clients use:
# the routing-service hostrecord lands in a dnsmasq that is NOT running in
# single-box AP mode, and the host-net dnsmasq has DNS disabled (port=0).
# droplet-openwrt-attach now emits the FQDN into /etc/dnsmasq-ap.conf itself
# (it reads DROPLET_PUBLIC_FQDN back out of the .env written above), so
# re-running the attach unit makes the name live for AP clients IMMEDIATELY.
# Best-effort like the DNS legs above (non-fatal): the device-bridge invokes
# this script as an unprivileged user with NO sudo (NoNewPrivileges — see
# install-device-bridge.sh), so gate on passwordless sudo; without it the
# attach regenerates the config on the next boot anyway.
_propagate_ap_resolver() {
  if ! command -v systemctl >/dev/null 2>&1; then
    err "systemctl not available — AP resolver (dnsmasq-ap) serves ${FQDN} from the next attach run (non-fatal)"
    return 0
  fi
  if ! sudo -n true 2>/dev/null; then
    err "no passwordless sudo — AP resolver (dnsmasq-ap) serves ${FQDN} from the next boot (non-fatal)"
    return 0
  fi
  if sudo -n systemctl restart droplet-openwrt-attach.service >/dev/null 2>&1; then
    printf 'AP resolver refreshed: dnsmasq-ap now serves %s\n' "$FQDN"
  else
    err "droplet-openwrt-attach restart failed — AP resolver serves ${FQDN} from the next boot (non-fatal)"
  fi
  return 0
}
_propagate_ap_resolver

exit 0
