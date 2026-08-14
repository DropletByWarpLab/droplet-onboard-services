# --- Build stage ---
# Workspace-aware build mirroring apps/orchestrator/Dockerfile (WARP-101).
# The mcp-server depends on @droplet/tools-core + @droplet/fips-selftest
# (workspace packages) and the @prisma/client generated from
# apps/orchestrator's canonical schema. Build context is the repo root
# (see docker/docker-compose.yml `context: ..`) so npm workspaces can
# resolve symlinks across packages.
#
# WARP-229: base image migrated from `node:20-alpine` to
# `node:20-bookworm-slim` so the OpenSSL FIPS provider can be loaded
# at runtime. See `apps/orchestrator/Dockerfile` for the full rationale
# and the WARP-967 note about the in-image validated `fips.so`.

# --- FIPS provider build stage (WARP-967) ---
# Source-builds the NIST-validated OpenSSL FIPS module (fips.so) —
# OpenSSL 3.0.9, CMVP certificate #4282. The version pin, sha256 pin,
# and full rationale live in docker/fips/build-openssl-fips.sh. This
# stage is byte-identical across every shipped service image
# (orchestrator, mcp-server, web-dashboard, file-indexer, ai-gateway)
# so BuildKit resolves it to ONE compile per builder/arch instead of
# five. Keep it in lockstep across those five Dockerfiles.
FROM debian:bookworm-slim AS fips-builder
COPY docker/fips/build-openssl-fips.sh /tmp/build-openssl-fips.sh
RUN sh /tmp/build-openssl-fips.sh /out

FROM node:20-bookworm-slim AS builder

# openssl + ca-certificates at build time so prisma can generate its
# client engine binaries. `--no-install-recommends` keeps the layer
# trim; the apt list teardown drops the package index.
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates

WORKDIR /app

# Copy every workspace package.json + the root workspace + lockfile so
# npm ci can resolve workspace symlinks. Sources for workspaces we don't
# build (web-dashboard, ai-gateway) are NOT copied.
COPY package.json package-lock.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY services/ai-gateway/package.json ./services/ai-gateway/package.json
COPY services/matter-controller/package.json ./services/matter-controller/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json
# WARP-1874: tools-core now imports @droplet/shared-types (the meeting-link
# parser). Mirrors apps/orchestrator/Dockerfile, which already carries all
# four shared-types lines.
COPY packages/shared-types/package.json ./packages/shared-types/package.json

# Targeted install: mcp-server + its in-repo deps (tools-core + fips-selftest
# + shared-types),
# plus the orchestrator workspace so its `prisma` devDep CLI is available
# for client generation. Web-dashboard + ai-gateway are still excluded.
# WARP-1065: persistent npm download cache — package tarballs survive
# rebuilds (node_modules itself is still built fresh each time; see the
# --no-cache note on the apt mount above).
RUN --mount=type=cache,target=/root/.npm \
    npm ci \
    -w @droplet/orchestrator \
    -w @droplet/mcp-server \
    -w @droplet/tools-core \
    -w @droplet/fips-selftest \
    -w @droplet/shared-types \
    --include-workspace-root

# Sources required to build the mcp-server image.
COPY packages/tools-core ./packages/tools-core
COPY packages/fips-selftest ./packages/fips-selftest
COPY packages/shared-types ./packages/shared-types
COPY services/mcp-server ./services/mcp-server
# Schema-only copy from the orchestrator workspace — the mcp-server's
# `new PrismaClient()` at boot needs the generated client. We don't
# need the rest of the orchestrator sources.
COPY apps/orchestrator/prisma ./apps/orchestrator/prisma
# The embedding client (WARP-202) uses @grpc/proto-loader to read
# inference.proto at runtime. Copy the proto definition so it ships
# with the image and is reachable from
# `services/mcp-server/dist/embedding.client.js` at run time.
COPY proto ./proto

# Generate the Prisma client into the shared root node_modules. The
# orchestrator and mcp-server both resolve @prisma/client from there.
# Run from the orchestrator workspace so `prisma generate` finds the
# schema at the default `./prisma/schema.prisma` location.
RUN npm run -w @droplet/orchestrator db:generate

# Build in dependency order. shared-types first: its package.json points
# `types` at ./src/index.ts (so tsc typechecks from source) but
# `exports["."].require` at ./dist/index.js — so tools-core's EMITTED JS
# needs shared-types' dist at runtime. Copying the sources alone would fix
# the TS2307 and leave a runtime landmine.
RUN npm run -w @droplet/shared-types build
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/fips-selftest build
RUN npm run -w @droplet/mcp-server build

# --- Run stage ---
FROM node:20-bookworm-slim

# Runtime: openssl (FIPS provider) + ca-certificates + wget (healthcheck
# client used by the Compose `healthcheck` block).
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates wget

# WARP-229: activate OpenSSL 3 FIPS provider. Same rationale as
# apps/orchestrator/Dockerfile. The boot self-test runs at the top of
# `dist/index.js` and exits non-zero with a structured JSON line if
# FIPS isn't loaded or isn't enforcing.
ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

# WARP-967: install the NIST-validated FIPS provider (fips.so — OpenSSL
# 3.0.9, CMVP cert #4282, source-built in the fips-builder stage above)
# and run the build-time FIPS self-test (fipsinstall KATs +
# provider-active assert + MD5 negative-probe). Any failure fails the
# image build. Shipping the module does NOT activate FIPS at runtime —
# activation stays opt-in via the container env (WARP-318); the compose
# default keeps DROPLET_FIPS_REQUIRED=false.
# WARP-1063: like the orchestrator, this process can host TWO libcrypto
# instances (Node's bundled OpenSSL + Prisma's system libssl — the
# mcp-server's Postgres use is lazy but real). Each instance gets its OWN
# fips.so copy at its OWN baked MODULESDIR; no process-wide
# OPENSSL_MODULES (see apps/orchestrator/Dockerfile + openssl#25553).
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN node_moddir="$(grep -a -o -m1 'MODULESDIR: "[^"]*"' "$(command -v node)" | sed 's/^MODULESDIR: "//; s/"$//')" && \
    { [ -n "$node_moddir" ] || { echo "FIPS: could not extract node's baked MODULESDIR" >&2; exit 1; }; } && \
    sh /tmp/install-fips-provider.sh /tmp/fips.so "$node_moddir" && \
    rm -f /tmp/fips.so /tmp/install-fips-provider.sh

# WARP-967: probe the exact combination WARP-318 activates at runtime —
# Node's BUNDLED OpenSSL loading the validated module from its own baked
# MODULESDIR copy (WARP-1063 — deliberately NO OPENSSL_MODULES; see
# apps/orchestrator/Dockerfile). `--openssl-shared-config` because node
# reads the config under its own `nodejs_conf` appname. Flag + env var
# are scoped to this RUN; runtime posture is unchanged.
RUN OPENSSL_CONF=/etc/ssl/openssl-fips.cnf \
    node --openssl-shared-config -e 'const c = require("node:crypto"); \
      if (c.getFips() !== 1) { console.error("FIPS node self-test FAILED: bundled OpenSSL did not enter FIPS mode"); process.exit(1); } \
      try { c.createHash("sha256").update("probe").digest("hex"); } catch (e) { console.error("FIPS node self-test FAILED: approved digest unavailable — node did not activate its fips.so copy: " + e.message); process.exit(1); } \
      let md5ok = false; \
      try { c.createHash("md5").update("probe").digest("hex"); md5ok = true; } catch {} \
      if (md5ok) { console.error("FIPS node self-test FAILED: MD5 succeeded under the FIPS config"); process.exit(1); } \
      console.log("FIPS build-time self-test OK (node bundled OpenSSL): provider active from node MODULESDIR copy, SHA-256 works, MD5 rejected");'

WORKDIR /app

# Preserve the workspace layout under /app so the symlinks in
# node_modules/@droplet/* resolve correctly at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/tools-core/package.json ./packages/tools-core/package.json
COPY --from=builder /app/packages/tools-core/dist ./packages/tools-core/dist
COPY --from=builder /app/packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY --from=builder /app/packages/fips-selftest/dist ./packages/fips-selftest/dist
# WARP-1874: node_modules above carries the @droplet/shared-types workspace
# symlink, so the target directory has to exist in the run stage too or
# tools-core's require() resolves to nothing. Same pair the orchestrator
# run stage already copies.
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/services/mcp-server/package.json ./services/mcp-server/package.json
COPY --from=builder /app/services/mcp-server/dist ./services/mcp-server/dist
# Proto file consumed by the runtime gRPC client. embedding.client.ts
# probes a few candidate paths; `/app/proto/inference.proto` is the
# absolute fallback this layout resolves to.
COPY --from=builder /app/proto ./proto

ENV NODE_ENV=production

# Internal port — published only when explicitly opted in via Compose.
EXPOSE 9090

CMD ["node", "/app/services/mcp-server/dist/index.js", "--transport=http"]
