# --- Build stage ---
# Workspace-aware build. The orchestrator depends on @droplet/tools-core,
# @droplet/mcp-server, and @droplet/fips-selftest (workspace packages);
# at runtime it spawns the mcp-server's `dist/index.js` as a stdio child.
# Build context is the repo root (see docker/docker-compose.yml
# `context: ..`).
#
# WARP-229: base image migrated from `node:20-alpine` to
# `node:20-bookworm-slim` because the Debian Bookworm OpenSSL package
# ships the FIPS provider (NIST CMVP cert #4282). Alpine's OpenSSL has
# no FIPS provider available. Image grows ~80 MB; trade-off is FIPS
# 140-3 compliance, which is non-negotiable for SOC 2 / HIPAA targets.
FROM node:20-bookworm-slim AS builder

# Install build-time openssl + ca-certificates. `--no-install-recommends`
# keeps the image trim; `rm -rf /var/lib/apt/lists/*` drops the package
# index after install.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy every workspace package.json + the root workspace + lockfile, so
# npm ci can resolve the workspace symlinks (link: true entries in the
# lockfile point at apps/web-dashboard, services/ai-gateway, etc. — npm
# fails the link if the target package.json is missing). Sources for the
# workspaces we don't build (web-dashboard, ai-gateway) are NOT copied —
# only their manifests are needed for symlink resolution.
COPY package.json package-lock.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY services/ai-gateway/package.json ./services/ai-gateway/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json

# Targeted install: only the orchestrator workspace and its in-repo
# dependencies (tools-core + mcp-server + fips-selftest). Excludes
# web-dashboard's Next.js + React stack from the orchestrator image.
RUN npm ci \
    -w @droplet/orchestrator \
    -w @droplet/tools-core \
    -w @droplet/mcp-server \
    -w @droplet/fips-selftest \
    --include-workspace-root

# Copy sources for the workspaces this image builds.
COPY packages/tools-core ./packages/tools-core
COPY packages/fips-selftest ./packages/fips-selftest
COPY services/mcp-server ./services/mcp-server
COPY apps/orchestrator ./apps/orchestrator

# Generate the Prisma client (orchestrator's schema is canonical;
# mcp-server reuses the same generated client at runtime via shared
# node_modules).
RUN npm run -w @droplet/orchestrator db:generate

# Build in dependency order.
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/fips-selftest build
RUN npm run -w @droplet/mcp-server build
RUN npm run -w @droplet/orchestrator build

# --- Run stage ---
FROM node:20-bookworm-slim

# Runtime needs the OpenSSL FIPS provider available. The bookworm-slim
# base image already ships `openssl` and `libssl3`, which together
# provide the FIPS module config (`/etc/ssl/fipsmodule.cnf`). We
# explicitly apt-install to pin it across image rebuilds.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# WARP-229: activate the OpenSSL 3 FIPS provider. Both the Node process
# (via its bundled OpenSSL) and any child processes inherit OPENSSL_CONF
# and pick up the FIPS config at startup. The boot self-test
# (`assertFipsAtBoot('orchestrator')` in src/index.ts) confirms the
# provider is loaded AND enforcing, and exits non-zero if either check
# fails.
ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

WORKDIR /app

# Preserve the workspace layout under /app so:
#   - the workspace symlinks in node_modules/@droplet/* resolve correctly,
#   - the orchestrator's mcp-client singleton finds the child binary at
#     `<orchestrator-cwd>/../../services/mcp-server/dist/index.js` (which
#     is `/app/services/mcp-server/dist/index.js` here), AND
#   - MCP_SERVER_BIN env in docker-compose pins the path explicitly.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/tools-core/package.json ./packages/tools-core/package.json
COPY --from=builder /app/packages/tools-core/dist ./packages/tools-core/dist
COPY --from=builder /app/packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY --from=builder /app/packages/fips-selftest/dist ./packages/fips-selftest/dist
COPY --from=builder /app/services/mcp-server/package.json ./services/mcp-server/package.json
COPY --from=builder /app/services/mcp-server/dist ./services/mcp-server/dist
COPY --from=builder /app/apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY --from=builder /app/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=builder /app/apps/orchestrator/prisma ./apps/orchestrator/prisma
# WARP-81: bundle the IEEE OUI vendor registry snapshot. oui-lookup.service
# reads this at startup to resolve MAC prefixes → vendor names.
COPY --from=builder /app/apps/orchestrator/data/oui.csv ./apps/orchestrator/data/oui.csv

WORKDIR /app/apps/orchestrator

# Run migrations then start server.
#
# WARP-229 — FIPS activation strategy:
#   1. `OPENSSL_CONF=/etc/ssl/openssl-fips.cnf` is set as an ENV above.
#      Node's bundled OpenSSL honors it at startup and loads the FIPS
#      provider declared in the config.
#   2. The first line of `dist/index.js` is the boot self-test
#      (`assertFipsAtBootOrExit('orchestrator')`). It calls
#      `crypto.getFips()` AND attempts an MD5 digest as a
#      negative-probe; the container exits non-zero with a structured
#      JSON log line if FIPS isn't loaded or isn't enforcing.
#   3. Dev opt-out via `DROPLET_FIPS_REQUIRED=false`.
#
# We deliberately do NOT pass `--enable-fips` at the Node CLI level.
# That flag fails fast inside Node's startup (before our self-test runs)
# if the OpenSSL FIPS module shared object (`fips.so`) is not available,
# with a low-context error. Letting `OPENSSL_CONF` drive activation
# means the self-test can emit a structured `{event:"fips_self_test",
# fips:false,reason:"..."}` line operators can consume.
#
# IMPORTANT — provisioning the FIPS module:
#   The `node:20-bookworm-slim` base image does NOT ship the NIST-validated
#   OpenSSL FIPS provider (`fips.so`). To actually boot this image in
#   FIPS mode in production, you must layer a provider on top via ONE OF:
#     - Ubuntu Pro FIPS (apt-install `openssl-fips`)
#     - Red Hat UBI 9 base (re-base off `redhat/ubi9-minimal`)
#     - source-built OpenSSL 3 with `--enable-fips`, copied to
#       `/usr/lib/x86_64-linux-gnu/ossl-modules/fips.so` plus
#       `/etc/ssl/fipsmodule.cnf`
#   That provisioning is tracked separately (this PR establishes the
#   activation apparatus; module sourcing is the operator's choice).
#   Until a provider is installed, set `DROPLET_FIPS_REQUIRED=false`
#   in the container env to skip the boot self-test and run in a
#   non-FIPS posture (development / CI / staging).
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
