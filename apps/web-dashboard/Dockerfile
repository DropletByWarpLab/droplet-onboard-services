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

# --- Build stage ---
# Workspace-aware build. The web-dashboard depends on @droplet/shared-types
# (a workspace package) for `import type` only — the types are erased at
# compile time, but npm still has to resolve the workspace symlink at
# install time, so the image must build from the repo-root context as a
# workspace member (see docker/docker-compose.yml `context: ..`). Mirrors
# the orchestrator's repo-root workspace build (6af516e).
#
# WARP-967: build stage migrated from `node:20-alpine` to
# `node:20-bookworm-slim` — the last Alpine base among shipped services
# (WARP-229 kept it as a build-cache optimization; the "no Alpine base
# remains in shipped services" AC retires that trade-off, and a single
# base lineage keeps the layer cache shared with the runtime stage).
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Workspace manifests + lockfile so npm ci can resolve the workspace
# symlinks (the lockfile's link: true entries point at the in-repo
# packages; npm fails the link if the target package.json is missing).
COPY package.json package-lock.json ./
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/auth-policy/package.json ./packages/auth-policy/package.json

# Targeted install: only the web-dashboard workspace and its in-repo
# dependencies (shared-types is type-only; auth-policy ships runtime code
# that next.config transpiles — see transpilePackages).
# WARP-1065: persistent npm download cache — package tarballs survive
# rebuilds (node_modules itself is still built fresh each time; see the
# --no-cache note on the apt mount above).
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @droplet/web-dashboard -w @droplet/shared-types -w @droplet/auth-policy --include-workspace-root

# Sources for the workspaces this image builds. auth-policy's source is
# required (not just its package.json): next build transpiles it from .ts
# via transpilePackages, so the .ts sources must be present in the context.
COPY packages/shared-types ./packages/shared-types
COPY packages/auth-policy ./packages/auth-policy
COPY apps/web-dashboard ./apps/web-dashboard

# WARP-2490: the customer integration guides are `?raw`-imported by
# src/lib/integration-guides.ts as `../../../../docs/integrations/*.md` —
# four levels up from apps/web-dashboard/src/lib is /app, so the markdown
# must sit at /app/docs/integrations for `next build` to inline it into
# the bundle. Build-time only: the text ships inside the JS, so the run
# stage needs no copy of its own.
COPY docs/integrations ./docs/integrations

# shared-types is type-only for web-dashboard, but build it so the
# require() condition has a dist too (harmless, matches orchestrator).
RUN npm run -w @droplet/shared-types build
RUN npm run -w @droplet/web-dashboard build

# --- Run stage ---
# Runtime migrates to `node:20-bookworm-slim` so the OpenSSL FIPS
# provider can be loaded. Next.js SSR makes outbound HTTPS to the
# orchestrator + nextcloud at request time; those calls inherit the
# OpenSSL config from the runtime image. No boot self-test is wired
# in here — Next.js doesn't have an auditable crypto initiation point
# the way the orchestrator/mcp-server do, and the inbound /_/fips probe
# would be a Next.js route file, not an Express middleware. The
# orchestrator and mcp-server are the auditable surfaces; the dashboard
# rides on whatever cryptographic posture they enforce. WARP-229.
FROM node:20-bookworm-slim

# Runtime openssl + ca-certificates: the openssl CLI runs the WARP-967
# fipsinstall + build-time FIPS self-test below against the validated
# fips.so that now ships in this image, and provides the system
# MODULESDIR the module installs into.
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

# WARP-229/WARP-967: the shared FIPS-provider OpenSSL config, COPY'd
# from the canonical docker/openssl-fips.cnf. The dashboard builds from
# the repo-root context (docker-compose.yml `context: ..`, same as the
# orchestrator + mcp-server), so the WARP-229-era heredoc duplicate of
# this file — written when the comment here claimed a per-app build
# context — is gone along with its lockstep-drift risk.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf

# WARP-967: install the NIST-validated FIPS provider (fips.so — OpenSSL
# 3.0.9, CMVP cert #4282, source-built in the fips-builder stage above)
# and run the build-time FIPS self-test (fipsinstall KATs +
# provider-active assert + MD5 negative-probe). Any failure fails the
# image build.
#
# Runtime posture note: the ENV above stays baked (re-baking it is
# WARP-315's scope), and shipping the module does NOT flip this
# container into FIPS mode — `node` statically links its own bundled
# OpenSSL, which reads the config under its own `nodejs_conf` appname
# (absent from the shared config), so startup behaves exactly as before
# this change (verified: getFips()=0, MD5 available, clean boot).
# Activation (WARP-318) = NODE_OPTIONS=--openssl-shared-config +
# DROPLET_FIPS_REQUIRED=true alongside the config.
#
# WARP-1063: node resolves fips.so from its OWN baked MODULESDIR (a
# dedicated copy installed below) rather than a process-wide
# OPENSSL_MODULES — the FIPS module cannot be initialized by two
# libcrypto instances resolving the same .so file (openssl#25553; see
# apps/orchestrator/Dockerfile for the full story).
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

# Monorepo standalone layout: with outputFileTracingRoot at the repo root,
# Next emits the hoisted node_modules + root package.json at the standalone
# root and nests the workspace's server.js under apps/web-dashboard/.
COPY --from=builder /app/apps/web-dashboard/.next/standalone ./
COPY --from=builder /app/apps/web-dashboard/.next/static ./apps/web-dashboard/.next/static
COPY --from=builder /app/apps/web-dashboard/public ./apps/web-dashboard/public

ENV PORT=3001
# Next.js standalone server.js binds to `process.env.HOSTNAME || '0.0.0.0'`.
# Docker injects HOSTNAME=<container-id>, which resolves to the container's
# eth0 IP — so without this override nothing listens on loopback and the
# compose healthcheck's fetch('http://localhost:3001/healthz') fails every
# probe (container permanently `unhealthy`). Pin the bind address to
# 0.0.0.0 (canonical Vercel with-docker pattern). WARP-535.
ENV HOSTNAME=0.0.0.0
EXPOSE 3001

CMD ["node", "apps/web-dashboard/server.js"]
