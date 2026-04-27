# --- Build stage ---
# Workspace-aware build. The orchestrator depends on @droplet/tools-core
# and @droplet/mcp-server (workspace packages); at runtime it spawns the
# mcp-server's `dist/index.js` as a stdio child. Build context is the
# repo root (see docker/docker-compose.yml `context: ..`).
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

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

# Targeted install: only the orchestrator workspace and its in-repo
# dependencies (tools-core + mcp-server). Excludes web-dashboard's
# Next.js + React stack from the orchestrator image.
RUN npm ci \
    -w @droplet/orchestrator \
    -w @droplet/tools-core \
    -w @droplet/mcp-server \
    --include-workspace-root

# Copy sources for the three workspaces this image builds.
COPY packages/tools-core ./packages/tools-core
COPY services/mcp-server ./services/mcp-server
COPY apps/orchestrator ./apps/orchestrator

# Generate the Prisma client (orchestrator's schema is canonical;
# mcp-server reuses the same generated client at runtime via shared
# node_modules).
RUN npm run -w @droplet/orchestrator db:generate

# Build in dependency order.
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/mcp-server build
RUN npm run -w @droplet/orchestrator build

# --- Run stage ---
FROM node:20-alpine

RUN apk add --no-cache openssl

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
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
