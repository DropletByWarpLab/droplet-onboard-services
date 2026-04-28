# --- Build stage ---
# Workspace-aware build mirroring apps/orchestrator/Dockerfile (WARP-101).
# The mcp-server depends on @droplet/tools-core (workspace package) and
# the @prisma/client generated from apps/orchestrator's canonical schema.
# Build context is the repo root (see docker/docker-compose.yml
# `context: ..`) so npm workspaces can resolve symlinks across packages.
FROM node:20-alpine AS builder

# openssl is needed at install/build time so prisma can generate its
# client engine binaries; the CLI emits a warning + downloads a
# dynamically-linked binary if openssl isn't present.
RUN apk add --no-cache openssl

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

# Targeted install: mcp-server + its in-repo dep (tools-core), plus the
# orchestrator workspace so its `prisma` devDep CLI is available for
# client generation. Web-dashboard + ai-gateway are still excluded.
RUN npm ci \
    -w @droplet/orchestrator \
    -w @droplet/mcp-server \
    -w @droplet/tools-core \
    --include-workspace-root

# Sources required to build the mcp-server image.
COPY packages/tools-core ./packages/tools-core
COPY services/mcp-server ./services/mcp-server
# Schema-only copy from the orchestrator workspace — the mcp-server's
# `new PrismaClient()` at boot needs the generated client. We don't
# need the rest of the orchestrator sources.
COPY apps/orchestrator/prisma ./apps/orchestrator/prisma

# Generate the Prisma client into the shared root node_modules. The
# orchestrator and mcp-server both resolve @prisma/client from there.
# Run from the orchestrator workspace so `prisma generate` finds the
# schema at the default `./prisma/schema.prisma` location.
RUN npm run -w @droplet/orchestrator db:generate

# Build in dependency order.
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/mcp-server build

# --- Run stage ---
FROM node:20-alpine

# wget is the healthcheck client used by the Compose `healthcheck` block.
RUN apk add --no-cache openssl wget

WORKDIR /app

# Preserve the workspace layout under /app so the symlinks in
# node_modules/@droplet/* resolve correctly at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/tools-core/package.json ./packages/tools-core/package.json
COPY --from=builder /app/packages/tools-core/dist ./packages/tools-core/dist
COPY --from=builder /app/services/mcp-server/package.json ./services/mcp-server/package.json
COPY --from=builder /app/services/mcp-server/dist ./services/mcp-server/dist

ENV NODE_ENV=production

# Internal port — published only when explicitly opted in via Compose.
EXPOSE 9090

CMD ["node", "/app/services/mcp-server/dist/index.js", "--transport=http"]
