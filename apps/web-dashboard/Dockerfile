# --- Build stage ---
# Workspace-aware build. The web-dashboard depends on @droplet/shared-types
# (a workspace package) for `import type` only — the types are erased at
# compile time, but npm still has to resolve the workspace symlink at
# install time, so the image must build from the repo-root context as a
# workspace member (see docker/docker-compose.yml `context: ..`). Mirrors
# the orchestrator's repo-root workspace build (6af516e).
#
# Build stage stays on `node:20-alpine` because the Next.js compile is
# pure JS — no cryptographic operations happen at build time, so there's
# no FIPS-provider requirement for this layer. Trims ~30 MB off the
# build cache vs. switching the build image too. WARP-229.
FROM node:20-alpine AS builder

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
RUN npm ci -w @droplet/web-dashboard -w @droplet/shared-types -w @droplet/auth-policy --include-workspace-root

# Sources for the workspaces this image builds. auth-policy's source is
# required (not just its package.json): next build transpiles it from .ts
# via transpilePackages, so the .ts sources must be present in the context.
COPY packages/shared-types ./packages/shared-types
COPY packages/auth-policy ./packages/auth-policy
COPY apps/web-dashboard ./apps/web-dashboard

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

# Install openssl + ca-certificates so an upstream FIPS provider, when
# layered onto this image (Ubuntu Pro / source-built fips.so), is loadable.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# WARP-229: drop the shared FIPS-provider OpenSSL config in place via a
# heredoc. The web-dashboard's docker-compose build context is the
# apps/web-dashboard directory only — `docker/openssl-fips.cnf` is out
# of reach via COPY. Keep this block in lockstep with the canonical
# `docker/openssl-fips.cnf` (orchestrator and mcp-server COPY that file
# directly because their build contexts already include the repo root).
RUN cat > /etc/ssl/openssl-fips.cnf <<'CNF'
config_diagnostics = 1
openssl_conf = openssl_init

.include /etc/ssl/fipsmodule.cnf

[openssl_init]
providers = provider_sect
alg_section = algorithm_sect

[provider_sect]
fips = fips_sect
base = base_sect

[fips_sect]
activate = 1

[base_sect]
activate = 1

[algorithm_sect]
default_properties = fips=yes
CNF

ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf

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
