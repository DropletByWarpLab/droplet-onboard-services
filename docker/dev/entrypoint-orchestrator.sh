#!/usr/bin/env bash
# Boot the orchestrator dev container. Runs on every `docker compose up`.
# Idempotent — npm install / migrate deploy / seed all skip work that's
# already done.
#
# Sequence:
#   1. Install workspace deps if node_modules is empty (named volume
#      persists across restarts so this is a one-time cost).
#   2. Generate Prisma client (cheap if up-to-date). MUST precede step 3 —
#      tools-core compiles against it. See the note there.
#   3. Build the workspace packages the orchestrator loads from dist/.
#   4. Wait for Postgres to accept connections (compose's depends_on
#      with `condition: service_healthy` should make this immediate, but
#      we add a belt-and-suspenders loop in case of clock skew).
#   5. Apply migrations.
#   6. Seed dev data (only if DROPLET_DEV_SEED=1).
#   7. Hand off to `npm run dev` (tsx watch src/index.ts).

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

# 2. Generate the Prisma client — BEFORE the workspace builds, never after.
#    WARP-2845: `@droplet/tools-core` COMPILES against the generated client.
#    src/handlers/memory/recall.ts narrows on MemoryFactCategory, so with an
#    absent or stale client tsc fails with a category-enum mismatch
#    ("'Business' is not assignable to ..."). Under `set -e` that exits the
#    entrypoint, docker restarts the container, and it fails identically
#    forever — a crash loop whose message names a handler nobody edited.
#    Generating first is also strictly cheaper: the build below is the only
#    consumer, and `prisma generate` is a no-op when already current.
cd /workspace/apps/orchestrator
log "Generating Prisma client…"
npx prisma generate

# 3. Build the workspace packages the orchestrator resolves from dist/
#    (package.json "main": "dist/index.js"). tsx resolves the orchestrator's
#    OWN sources natively but follows package entry points for workspace
#    deps, so a fresh named volume without these builds crashes at require
#    time (fips-selftest → shared-types → auth-policy, in dependency order).
#    tools-core needs step 2's output; erp-connector needs shared-types, so
#    both sit after it.
#
#    WARP-2845: `services/erp-connector` is in this list because the
#    orchestrator IMPORTS IT AT RUNTIME (erp.service.ts, erp-provider.ts,
#    erp-sync/*). It was missing, so the stack got all the way past migrations
#    and the seed and then died on the handoff to `npm run dev`:
#
#      Error: Cannot find module
#      '/workspace/node_modules/@droplet/erp-connector/dist/index.js'
#
#    It lives under services/, not packages/ — which is exactly why a list
#    written as "the packages/*" set missed it. Building it also drops the
#    orchestrator's `tsc --noEmit` from 38 errors to 1.
#
#    Deliberately NOT here: `services/mcp-server`. The orchestrator references
#    it only from a test file, never at runtime, so building it on every boot
#    would cost time the dev loop does not get back.
#    Idempotent: tsc is incremental and a warm volume rebuilds in seconds.
log "Building workspace packages (fips-selftest, shared-types, auth-policy, tools-core, erp-connector)…"
for w in packages/fips-selftest packages/shared-types packages/auth-policy packages/tools-core services/erp-connector; do
  if grep -q '"build"' "/workspace/$w/package.json"; then
    (cd /workspace && npm run build -w "./$w")
  fi
done

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
