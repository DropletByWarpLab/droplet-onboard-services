#!/usr/bin/env bash
# Boot the orchestrator dev container. Runs on every `docker compose up`.
# Idempotent — npm install / migrate deploy / seed all skip work that's
# already done.
#
# Sequence:
#   1. Install workspace deps if node_modules is empty (named volume
#      persists across restarts so this is a one-time cost).
#   2. Generate Prisma client (cheap if up-to-date).
#   3. Wait for Postgres to accept connections (compose's depends_on
#      with `condition: service_healthy` should make this immediate, but
#      we add a belt-and-suspenders loop in case of clock skew).
#   4. Apply migrations.
#   5. Seed dev data (only if DROPLET_DEV_SEED=1).
#   6. Hand off to `npm run dev` (tsx watch src/index.ts).

set -euo pipefail

log() { echo "[orchestrator-dev] $*"; }

# 1. Install workspace deps
log "Installing workspace dependencies (first boot may take 2-3 minutes)…"
cd /workspace
if [ ! -d node_modules/@droplet ]; then
  npm install --prefer-offline --no-audit --no-fund
else
  log "node_modules present — skipping install (delete the named volume to force)"
fi

# 2. Build the workspace packages the orchestrator resolves from dist/
#    (package.json "main": "dist/index.js"). tsx resolves the orchestrator's
#    OWN sources natively but follows package entry points for workspace
#    deps, so a fresh named volume without these builds crashes at require
#    time (fips-selftest → shared-types → auth-policy, in dependency order).
#    Idempotent: tsc is incremental and a warm volume rebuilds in seconds.
log "Building workspace packages (fips-selftest, shared-types, auth-policy, tools-core)…"
for w in packages/fips-selftest packages/shared-types packages/auth-policy packages/tools-core; do
  if grep -q '"build"' "/workspace/$w/package.json"; then
    (cd /workspace && npm run build -w "./$w")
  fi
done

# 3. Generate Prisma client
cd /workspace/apps/orchestrator
log "Generating Prisma client…"
npx prisma generate

# 4. Wait for Postgres
log "Waiting for Postgres on db:5432…"
for i in {1..30}; do
  if (echo > /dev/tcp/db/5432) 2>/dev/null; then
    log "Postgres ready."
    break
  fi
  sleep 1
done

# 5. Apply migrations
log "Applying Prisma migrations…"
npx prisma migrate deploy

# 6. Seed dev data
if [ "${DROPLET_DEV_SEED:-0}" = "1" ]; then
  log "Seeding dev data (DROPLET_DEV_SEED=1)…"
  # The seed script itself is idempotent (uses upsert) so re-running on
  # every boot is safe + cheap.
  npx tsx prisma/seed.dev.ts || log "Seed script failed — continuing"
else
  log "DROPLET_DEV_SEED!=1 — skipping seed."
fi

# 7. Hand off to tsx watch
log "Starting orchestrator (npm run dev)…"
exec npm run dev
