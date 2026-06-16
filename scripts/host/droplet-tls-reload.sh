#!/usr/bin/env bash
# =============================================================================
# ADR-023 (C2) — Droplet gateway-nginx reload host executor
# =============================================================================
#
# The host-side entry point the orchestrator's tls-issuance cron reaches (via
# the device-bridge's auth-gated POST /tls/reload) after it has atomically
# written a freshly-issued Let's Encrypt fullchain into docker/certs/droplet.crt
# + the matching key into droplet.key. It asks the running gateway container to
# `nginx -s reload` so the new publicly-trusted cert is served immediately.
#
# The orchestrator deliberately does NOT mount the docker socket (ADR-023), so
# the docker compose call has to run on the host — hence this thin wrapper.
# Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-tls-reload.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# This wrapper is deliberately THIN: it delegates to the ONE canonical reload
# implementation (scripts/lib/tls-reload.sh::reload_gateway_nginx), the same one
# the self-signed bootstrap path in secrets.sh uses — so there is exactly one
# reload code path on the box.
#
# Usage:
#   droplet-tls-reload.sh           # reload the gateway nginx (no args needed)
#
# Test/dev hook:
#   DROPLET_TLS_RELOAD_DRY_RUN=1     print what it WOULD do, exit 0, reload nothing.
# =============================================================================
set -euo pipefail

DRY_RUN="${DROPLET_TLS_RELOAD_DRY_RUN:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Resolve REPO_ROOT (reload_gateway_nginx needs it to find compose) ---
# When run from the repo (scripts/host/), the repo root is two levels up. The
# installed copy in /usr/local/sbin falls back to the well-known box location.
if [ -z "${REPO_ROOT:-}" ]; then
  if [ -f "$SCRIPT_DIR/../../docker/docker-compose.yml" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    REPO_ROOT="/home/droplet/edge-platform"
  fi
fi
export REPO_ROOT

# --- Resolve the canonical reload helper ---
TLS_RELOAD_LIB="${DROPLET_TLS_RELOAD_LIB:-}"
if [ -z "$TLS_RELOAD_LIB" ]; then
  if [ -f "$SCRIPT_DIR/../lib/tls-reload.sh" ]; then
    TLS_RELOAD_LIB="$(cd "$SCRIPT_DIR/../lib" && pwd)/tls-reload.sh"
  else
    TLS_RELOAD_LIB="$REPO_ROOT/scripts/lib/tls-reload.sh"
  fi
fi

log() { printf '[droplet-tls-reload] %s\n' "$*"; }

log "gateway nginx reload requested (REPO_ROOT=$REPO_ROOT)"

if [ -n "$DRY_RUN" ]; then
  log "DRY RUN — would source $TLS_RELOAD_LIB and run reload_gateway_nginx"
  exit 0
fi

if [ ! -f "$TLS_RELOAD_LIB" ]; then
  log "canonical reload helper not found at $TLS_RELOAD_LIB" >&2
  exit 1
fi

# shellcheck source=../lib/tls-reload.sh
source "$TLS_RELOAD_LIB"
reload_gateway_nginx
