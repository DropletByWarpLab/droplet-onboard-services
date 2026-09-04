#!/usr/bin/env bash
# =============================================================================
# WARP-988 — Droplet box-name write-back host executor
# =============================================================================
#
# The host-side entry point the orchestrator's box-name route reaches (via the
# device-bridge's auth-gated POST /host/box-name) once the owner has CHOSEN a
# name in the wizard's "name your box" step (WARP-979). It does one thing:
#
#   1. Idempotently writes DROPLET_BOX_NAME=<slug> into the repo .env via the
#      canonical _upsert_env_kv (scripts/lib/secrets.sh) — symlink-preserving
#      and literal-safe (WARP-2537) — so the next orchestrator boot reads the
#      chosen name directly and tls-issuance sends it to HQ as `requested_name`.
#
# Deliberately NO DNS legs — unlike droplet-set-public-fqdn.sh, the name's DNS
# (`<slug>.droplet-us.com`) is owned by HQ, not the box; the box only records
# the owner's choice.
#
# Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-box-name.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# Usage:
#   droplet-set-box-name.sh '<slug>'
#
# HARD VALIDATION (reject BEFORE writing): the orchestrator already validates
# (packages/shared-types/src/box-name.ts), and the device-bridge re-validates
# before exec, but we validate a THIRD time here (defence in depth) — the value
# is interpolated into .env, so it must be a strict lowercase slug: [a-z0-9-],
# 3-40 chars, no leading/trailing/double hyphen, and never the `d-<16 hex>`
# opaque per-device lookalike (ADR-023). Anything with shell metacharacters /
# whitespace / uppercase / dots is refused and nothing is written.
#
# Test/dev hooks (so validation + upsert are unit-testable without root):
#   DROPLET_BOX_NAME_ENV_FILE=...  override the .env path (default <repo>/.env)
# =============================================================================
set -euo pipefail

NAME="${1:-}"

err() { printf 'droplet-set-box-name: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -n "$NAME" ] || die "no name given"

# --- Strict validation (lowercase slug, shared box-name ruleset) -------------
# Reject anything that isn't 3..40 chars of [a-z0-9-] shaped as hyphen-joined
# lowercase runs (no leading/trailing/double hyphen), and never the opaque
# per-device `d-<16 hex>` shape HQ auto-mints. Matched with bash's [[ =~ ]]
# (whole-string, newline-safe) rather than a `printf | grep -q` pipe — grep is
# LINE-based, so a newline-bearing arg like 'name<LF>KEY=evil' would pass a
# grep check on its first line and inject a second .env assignment.
_name_len=${#NAME}
if [ "$_name_len" -lt 3 ] || [ "$_name_len" -gt 40 ]; then
  die "name length out of range"
fi
if ! [[ "$NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  die "name '${NAME}' is not a valid lowercase slug"
fi
if [[ "$NAME" =~ ^d-[0-9a-f]{16}$ ]]; then
  die "name '${NAME}' looks like an opaque per-device identifier"
fi

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

ENV_FILE="${DROPLET_BOX_NAME_ENV_FILE:-$REPO_ROOT/.env}"

# --- Idempotent .env write-back (canonical upsert — WARP-2537) --------------
# This used to stage a temp file and `mv` it over $ENV_FILE. On a box where
# relocate_secrets_to_data has run, $ENV_FILE is a SYMLINK into the encrypted
# /data — mv REPLACED the link with a plain file on the unencrypted boot disk,
# moving the secrets back outside the LUKS boundary and breaking the compose
# `../.env` env_file (the WARP-232 regression class, closed for
# droplet-set-nvr-media.sh by WARP-2522).
#
# _upsert_env_kv (scripts/lib/secrets.sh) is the repo's one .env writer with the
# right discipline: it resolves a symlinked $ENV_FILE and renames onto the REAL
# target so the link survives, strips-and-appends with printf (no sed, so every
# byte of the value lands literally), normalizes a missing trailing newline
# first, and stages under umask 077 + chmod 600. Hard-fail when the lib cannot
# be found rather than fall back to a clobbering writer — same "refuse loudly"
# posture as the validation above. The LIB_DIR fallback chain mirrors
# droplet-set-public-fqdn.sh: the repo-checkout location first, then
# $REPO_ROOT/scripts/lib for the /usr/local/sbin installed copy.
LIB_DIR="$SCRIPT_DIR/../lib"
if [ ! -f "$LIB_DIR/secrets.sh" ]; then
  LIB_DIR="$REPO_ROOT/scripts/lib"
fi
[ -f "$LIB_DIR/secrets.sh" ] || die "secrets.sh not found under $LIB_DIR — refusing to rewrite ${ENV_FILE} without the canonical symlink-preserving writer"
# shellcheck source=../lib/secrets.sh
. "$LIB_DIR/secrets.sh"

# Create the file if missing so a brand-new box can still record the name.
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

_desired="DROPLET_BOX_NAME=${NAME}"
if grep -qxF "$_desired" "$ENV_FILE"; then
  : # already current — no rewrite (keeps re-runs byte-identical)
else
  # _upsert_env_kv targets $ENV_FILE when set — which this script always sets
  # (the DROPLET_BOX_NAME_ENV_FILE test hook included).
  _upsert_env_kv DROPLET_BOX_NAME "$NAME"
fi
printf 'DROPLET_BOX_NAME persisted to %s\n' "$ENV_FILE"

exit 0
