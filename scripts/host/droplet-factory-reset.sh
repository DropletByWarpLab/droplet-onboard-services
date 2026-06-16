#!/usr/bin/env bash
# =============================================================================
# WARP-825 — Droplet factory-reset host executor
# =============================================================================
#
# The host-side entry point for the owner-confirmed factory reset surfaced in
# the dashboard's Settings → Danger Zone. Repo-tracked (architecture-guard rule
# 20) and installed to /usr/local/sbin/droplet-factory-reset.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# Invoked ONLY by the device-bridge's auth-gated POST /system/factory-reset,
# which the orchestrator reaches ONLY after:
#   - an OWNER session (requireRole("owner")), AND
#   - the server-side type-to-confirm check (the typed device name matched), AND
#   - an audit row already written, AND
#   - the double-fire guard cleared.
# The bridge spawns this DETACHED (the wipe tears down the orchestrator AND the
# bridge mid-flight, so nothing can wait for it). The AI can never reach this.
#
# This wrapper is deliberately THIN: it delegates to the ONE canonical reset
# script (scripts/factory-reset.sh --yes) rather than re-implementing the wipe.
# That keeps the wipe list, the WARP-570 pre-reset safety backup, and the
# WARP-456 audit-key era boundary in a single source of truth. Re-implementing
# `docker compose down -v` here would silently drift from that list.
#
# Usage:
#   droplet-factory-reset.sh '<json-params>'   # {"jobId":"...","targetName":"..."}
# The JSON arg is INFORMATIONAL (the wipe targets the whole box regardless); it
# is logged so the host audit trail can attribute the reset to the job.
#
# Test/dev hook (so the wrapper is unit-testable without wiping a box):
#   DROPLET_FACTORY_RESET_DRY_RUN=1   print the command it WOULD run, then exit 0
#                                     WITHOUT running it. Nothing is wiped.
# =============================================================================
set -euo pipefail

PARAMS_JSON="${1:-}"
DRY_RUN="${DROPLET_FACTORY_RESET_DRY_RUN:-}"

# --- Resolve the canonical reset script ---
# Installed copy lives in /usr/local/sbin; the canonical reset script lives in
# the repo. Allow an override for tests / non-standard checkouts, else fall back
# to the well-known repo location on the box (setup.sh installs the repo at
# /home/droplet/edge-platform).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SCRIPT="${DROPLET_FACTORY_RESET_TARGET:-}"
if [ -z "$RESET_SCRIPT" ]; then
  # When run from the repo (scripts/host/), the canonical script is one level up.
  if [ -f "$SCRIPT_DIR/../factory-reset.sh" ]; then
    RESET_SCRIPT="$(cd "$SCRIPT_DIR/.." && pwd)/factory-reset.sh"
  else
    RESET_SCRIPT="/home/droplet/edge-platform/scripts/factory-reset.sh"
  fi
fi

# --- Parse the (informational) job context for logging only ---
JOB_ID=""
if [ -n "$PARAMS_JSON" ]; then
  # Best-effort extraction; never fail the reset over a malformed context arg.
  JOB_ID="$(printf '%s' "$PARAMS_JSON" \
    | sed -n 's/.*"jobId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
fi

log() { printf '[droplet-factory-reset] %s\n' "$*"; }

log "factory reset requested (job=${JOB_ID:-unknown})"

# --- Dry run: print, don't wipe (test/dev hook) ---
if [ -n "$DRY_RUN" ]; then
  log "DRY RUN — would run: $RESET_SCRIPT --yes"
  exit 0
fi

if [ ! -f "$RESET_SCRIPT" ]; then
  log "canonical reset script not found at $RESET_SCRIPT" >&2
  exit 1
fi

# Delegate to the canonical reset, non-interactively. The safety backup runs
# inside factory-reset.sh (Phase 0) unless an operator has opted out at the
# host level; we do NOT pass --no-backup here, so the pre-wipe backup is on by
# default for a dashboard-triggered reset.
log "delegating to $RESET_SCRIPT --yes"
exec "$RESET_SCRIPT" --yes
