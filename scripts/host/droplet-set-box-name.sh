#!/usr/bin/env bash
# =============================================================================
# WARP-988 — Droplet box-name write-back host executor
# =============================================================================
#
# The host-side entry point the orchestrator's box-name route reaches (via the
# device-bridge's auth-gated POST /host/box-name) once the owner has CHOSEN a
# name in the wizard's "name your box" step (WARP-979). It does one thing:
#
#   1. Idempotently writes DROPLET_BOX_NAME=<slug> into the repo .env
#      (sed-replace-or-append), so the next orchestrator boot reads the chosen
#      name directly and tls-issuance sends it to HQ as `requested_name`.
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

# --- Idempotent .env write-back (sed-replace-or-append) ---------------------
# Create the file if missing so a brand-new box can still record the name.
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

_desired="DROPLET_BOX_NAME=${NAME}"
if grep -qxF "$_desired" "$ENV_FILE"; then
  : # already current — no rewrite (keeps re-runs byte-identical)
elif grep -qE '^[[:space:]]*#?[[:space:]]*DROPLET_BOX_NAME=' "$ENV_FILE"; then
  # Replace an existing (possibly commented / empty) line in place. Use a tmp
  # file + mv so a crash mid-write can't truncate .env.
  _tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  sed -E "s|^[[:space:]]*#?[[:space:]]*DROPLET_BOX_NAME=.*|${_desired}|" \
    "$ENV_FILE" > "$_tmp"
  mv "$_tmp" "$ENV_FILE"
else
  printf '%s\n' "$_desired" >> "$ENV_FILE"
fi
printf 'DROPLET_BOX_NAME persisted to %s\n' "$ENV_FILE"

exit 0
