# --- Build stage ---
# WARP-2627: the outbound MCP session component (ADR-043 §5). Build context is
# the repo root (docker/docker-compose.yml `context: ..`) so npm workspaces can
# resolve the lockfile.
#
# DELIBERATELY THE SMALLEST NODE IMAGE IN THE REPO. Unlike orchestrator /
# mcp-server this workspace has NO Prisma, NO @droplet/* dependency and no
# generated code — its only dependency is @modelcontextprotocol/sdk. So there is
# no prisma generate step, no workspace build chain, and no fips-builder stage:
# mcp-bridge is not one of the six FIPS provider-carrying images (orchestrator,
# web-dashboard, mcp-server, ai-gateway, file-indexer, gateway), and compose
# pins DROPLET_FIPS_REQUIRED=false / the stock OpenSSL config for it, the same
# way it does for web-fetch and erp-sql-bridge.
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Every workspace manifest plus the lockfile: `npm ci` validates the whole
# workspace graph, so a missing sibling manifest fails the install even when the
# targeted workspace does not depend on it.
COPY package.json package-lock.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY services/ai-gateway/package.json ./services/ai-gateway/package.json
COPY services/matter-controller/package.json ./services/matter-controller/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY services/mcp-bridge/package.json ./services/mcp-bridge/package.json
COPY services/erp-connector/package.json ./services/erp-connector/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/auth-policy/package.json ./packages/auth-policy/package.json

# WARP-1065: persistent npm download cache — package tarballs survive rebuilds.
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @droplet/mcp-bridge --include-workspace-root

COPY services/mcp-bridge ./services/mcp-bridge
RUN npm run -w @droplet/mcp-bridge build

# --- Run stage ---
FROM node:20-bookworm-slim

# wget is the healthcheck client the compose `healthcheck` block invokes.
# ca-certificates so the TLS dial to a remote MCP server can verify its chain —
# this is the one container in the stack whose whole job is an outbound TLS
# session, so a missing trust store would present as `unreachable` on every
# server.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates wget

WORKDIR /app

# Preserve the workspace layout so node resolves the SDK out of the root
# node_modules exactly as it does in the builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/services/mcp-bridge/package.json ./services/mcp-bridge/package.json
COPY --from=builder /app/services/mcp-bridge/dist ./services/mcp-bridge/dist

ENV NODE_ENV=production

# Never root: this process holds a customer's Atlassian credential in memory and
# is the only container in the stack that dials a vendor. `node` is the
# unprivileged user the base image already ships.
USER node

# Internal port — `expose:` only, never published to the host. The orchestrator
# is the only caller, over the compose bridge network, with a bearer.
EXPOSE 9096

CMD ["node", "/app/services/mcp-bridge/dist/server.js"]
