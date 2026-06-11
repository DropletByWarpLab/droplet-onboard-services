# --- Build stage ---
# matter-controller sidecar (WARP-850). Workspace-aware build mirroring
# apps/orchestrator/Dockerfile: build context is the repo root (see
# docker/docker-compose.yml `context: ..`), every workspace manifest is
# copied so npm ci can resolve the lockfile's workspace links.
#
# node:20-bookworm-slim for FIPS-provider parity with the orchestrator
# (WARP-229) — Debian's OpenSSL ships the provider, Alpine's does not.
FROM node:20-bookworm-slim AS builder

# Build deps:
#  - openssl/ca-certificates: FIPS posture parity (WARP-229).
#  - make/g++/python3: node-gyp toolchain for @matter/nodejs-ble's
#    native HCI dependency (@stoprocent/noble → bluetooth-hci-socket).
#  - libbluetooth-dev/libudev-dev: noble's Linux build headers.
# noble/bleno are OPTIONAL dependencies of @matter/nodejs-ble — if the
# native build ever fails npm continues and the service degrades to
# IP-only commissioning at runtime (src/ble.ts), but with these
# packages present the build succeeds and BLE works.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates make g++ python3 \
      libbluetooth-dev libudev-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy every workspace package.json + the root workspace + lockfile so
# npm ci can resolve the workspace symlinks (same rationale as the
# orchestrator Dockerfile).
COPY package.json package-lock.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/web-dashboard/package.json ./apps/web-dashboard/package.json
COPY services/ai-gateway/package.json ./services/ai-gateway/package.json
COPY services/matter-controller/package.json ./services/matter-controller/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/auth-policy/package.json ./packages/auth-policy/package.json

# Targeted install: only this service and its single in-repo dep.
RUN npm ci \
    -w @droplet/matter-controller \
    -w @droplet/fips-selftest \
    --include-workspace-root

# Copy sources and build in dependency order.
COPY packages/fips-selftest ./packages/fips-selftest
COPY services/matter-controller ./services/matter-controller

RUN npm run -w @droplet/fips-selftest build
RUN npm run -w @droplet/matter-controller build

# npm is free to place a workspace dependency in the workspace's OWN
# node_modules instead of hoisting it to the root (it did exactly that
# with @matter/nodejs-ble@0.16.10) — guarantee the directory exists so
# the run stage's COPY below is valid under either placement.
RUN mkdir -p services/matter-controller/node_modules

# --- Run stage ---
FROM node:20-bookworm-slim

# Runtime: OpenSSL for the FIPS provider config; libbluetooth3 is the
# runtime shared library behind noble's HCI socket bindings.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates libbluetooth3 && \
    rm -rf /var/lib/apt/lists/*

# WARP-229 FIPS activation parity with the orchestrator image. The boot
# self-test in src/index.ts enforces (or skips via
# DROPLET_FIPS_REQUIRED=false) exactly like the orchestrator.
ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY --from=builder /app/packages/fips-selftest/dist ./packages/fips-selftest/dist
COPY --from=builder /app/services/matter-controller/package.json ./services/matter-controller/package.json
COPY --from=builder /app/services/matter-controller/dist ./services/matter-controller/dist
# Workspace-level node_modules — without this the first deployed image
# shipped WITHOUT @matter/nodejs-ble (npm placed it here, the run stage
# only copied the root tree) and the box silently degraded to IP-only.
COPY --from=builder /app/services/matter-controller/node_modules ./services/matter-controller/node_modules

WORKDIR /app/services/matter-controller

# Fail the BUILD if the BLE package can't resolve from the service's
# runtime location — this class of packaging gap must never again
# surface only as a runtime degrade log on a customer box.
# Also assert the exact pinned version: if the lockfile ever drifts
# (e.g. caret ranges regenerate @matter/nodejs-ble@0.16.11), this gate
# fails loudly here rather than silently splitting the Environment.default
# singleton again and disabling BLE on a shipped box (WARP-850).
RUN node -e "const v=require('@matter/nodejs-ble/package.json').version; if(v!=='0.16.10') throw new Error('version-skew: expected 0.16.10, got '+v)"

# Port follows the host-service ladder: routing 8080, switch 8081,
# display 8082, matter-controller 8083. The container runs with
# `network_mode: host` so EXPOSE is documentation, not a publish.
EXPOSE 8083
CMD ["node", "dist/index.js"]
