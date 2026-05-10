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
# and the operator note about provisioning the validated `fips.so`.
FROM node:20-bookworm-slim AS builder

# openssl + ca-certificates at build time so prisma can generate its
# client engine binaries. `--no-install-recommends` keeps the layer
# trim; the apt list teardown drops the package index.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy every workspace package.json + the root workspace + lockfile so
# npm ci can resolve workspace symlinks. Sources for workspaces we don't
# build (web-dashboard, ai-gateway) are NOT copied.
COPY package.json package-lock.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY services/ai-gateway/package.json ./services/ai-gateway/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json

# Targeted install: mcp-server + its in-repo deps (tools-core + fips-selftest),
# plus the orchestrator workspace so its `prisma` devDep CLI is available
# for client generation. Web-dashboard + ai-gateway are still excluded.
RUN npm ci \
    -w @droplet/orchestrator \
    -w @droplet/mcp-server \
    -w @droplet/tools-core \
    -w @droplet/fips-selftest \
    --include-workspace-root

# Sources required to build the mcp-server image.
COPY packages/tools-core ./packages/tools-core
COPY packages/fips-selftest ./packages/fips-selftest
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

# Build in dependency order.
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/fips-selftest build
RUN npm run -w @droplet/mcp-server build

# --- Run stage ---
FROM node:20-bookworm-slim

# Runtime: openssl (FIPS provider) + ca-certificates + wget (healthcheck
# client used by the Compose `healthcheck` block).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

# WARP-229: activate OpenSSL 3 FIPS provider. Same rationale as
# apps/orchestrator/Dockerfile. The boot self-test runs at the top of
# `dist/index.js` and exits non-zero with a structured JSON line if
# FIPS isn't loaded or isn't enforcing.
ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

WORKDIR /app

# Preserve the workspace layout under /app so the symlinks in
# node_modules/@droplet/* resolve correctly at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/tools-core/package.json ./packages/tools-core/package.json
COPY --from=builder /app/packages/tools-core/dist ./packages/tools-core/dist
COPY --from=builder /app/packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY --from=builder /app/packages/fips-selftest/dist ./packages/fips-selftest/dist
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
