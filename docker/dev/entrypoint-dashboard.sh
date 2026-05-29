#!/usr/bin/env bash
# Boot the dashboard dev container. Runs on every `docker compose up`.
# Same install-if-empty pattern as the orchestrator entrypoint.

set -euo pipefail

log() { echo "[dashboard-dev] $*"; }

# 1. Install workspace deps. The dashboard is part of the npm workspace
#    at the repo root, so deps land under /workspace/node_modules + a
#    private /workspace/apps/web-dashboard/node_modules.
log "Installing workspace dependencies (first boot may take 2-3 minutes)…"
cd /workspace
if [ ! -d node_modules/next ]; then
  npm install --prefer-offline --no-audit --no-fund
else
  log "node_modules present — skipping install (delete the named volume to force)"
fi

# 2. Hand off to next dev
cd /workspace/apps/web-dashboard
log "Starting Next.js dev server on :3001…"
exec npm run dev
