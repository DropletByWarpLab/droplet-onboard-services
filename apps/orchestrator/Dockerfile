# Workspace-aware build. The orchestrator depends on @droplet/tools-core,
# @droplet/mcp-server, @droplet/fips-selftest, and @droplet/erp-connector
# (workspace packages); at runtime it spawns the mcp-server's `dist/index.js`
# as a stdio child.
# Build context is the repo root (see docker/docker-compose.yml
# `context: ..`).
#
# WARP-229: base image migrated from `node:20-alpine` to
# `node:20-bookworm-slim` because Alpine/musl has no validated FIPS
# provider path (the CMVP-tested platforms are glibc-based). Image grows
# ~80 MB; trade-off is FIPS 140-3 compliance, which is non-negotiable
# for SOC 2 / HIPAA targets.

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
FROM node:20-bookworm-slim AS builder

# Install build-time openssl + ca-certificates. `--no-install-recommends`
# keeps the image trim.
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates

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
COPY services/matter-controller/package.json ./services/matter-controller/package.json
COPY services/mcp-server/package.json ./services/mcp-server/package.json
COPY services/erp-connector/package.json ./services/erp-connector/package.json
COPY packages/tools-core/package.json ./packages/tools-core/package.json
COPY packages/fips-selftest/package.json ./packages/fips-selftest/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/auth-policy/package.json ./packages/auth-policy/package.json

# Targeted install: only the orchestrator workspace and its in-repo
# dependencies (tools-core + mcp-server + fips-selftest + shared-types).
# Excludes web-dashboard's Next.js + React stack from the orchestrator image.
# WARP-1065: persistent npm download cache — package tarballs survive
# rebuilds (node_modules itself is still built fresh each time; see the
# --no-cache note on the apt mount above).
RUN --mount=type=cache,target=/root/.npm \
    npm ci \
    -w @droplet/orchestrator \
    -w @droplet/tools-core \
    -w @droplet/erp-connector \
    -w @droplet/mcp-server \
    -w @droplet/fips-selftest \
    -w @droplet/shared-types \
    -w @droplet/auth-policy \
    --include-workspace-root

# Copy sources for the workspaces this image builds.
COPY packages/tools-core ./packages/tools-core
COPY packages/fips-selftest ./packages/fips-selftest
COPY packages/shared-types ./packages/shared-types
COPY packages/auth-policy ./packages/auth-policy
COPY services/mcp-server ./services/mcp-server
COPY services/erp-connector ./services/erp-connector
COPY apps/orchestrator ./apps/orchestrator

# Generate the Prisma client (orchestrator's schema is canonical;
# mcp-server reuses the same generated client at runtime via shared
# node_modules).
RUN npm run -w @droplet/orchestrator db:generate

# Build in dependency order.
RUN npm run -w @droplet/shared-types build
RUN npm run -w @droplet/auth-policy build
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/erp-connector build
RUN npm run -w @droplet/fips-selftest build
RUN npm run -w @droplet/mcp-server build
RUN npm run -w @droplet/orchestrator build

# --- Run stage ---
FROM node:20-bookworm-slim

# Runtime needs the OpenSSL FIPS provider available. The bookworm-slim
# base image already ships `openssl` and `libssl3`, which together
# provide the FIPS module config (`/etc/ssl/fipsmodule.cnf`). We
# explicitly apt-install to pin it across image rebuilds.
#
# WARP-573: also install `postgresql-client-16` so the guarded boot
# entrypoint (scripts/migrate-and-start.sh) can run psql / pg_dump /
# pg_restore for the advisory lock + pre-migration snapshot + auto-recovery.
#
# postgresql-client-16 is NOT in Debian Bookworm's base repos (Bookworm ships
# postgresql-client-15), so we pull major 16 from the official PostgreSQL APT
# repository (PGDG). WARP-573's assumption that the base image carried it was
# wrong; once the cached apt index rolled over, the build began failing with
# `E: Unable to locate package postgresql-client-16` (exit 100).
#
# Why major 16 specifically: pg_dump refuses to dump a server NEWER than
# itself, so the client major must be >= every Postgres server it touches.
# The deployed server (`db`) is postgres:15; the integration-test
# server (tests/docker-compose.test.yml) is postgres:16. Client 16 covers both
# (16 >= 16 >= 15). If any server major is raised, bump this pin in lockstep.
#
# `curl` is pulled in only to fetch the (ASCII-armored) PGDG signing key for
# apt's `signed-by`, then purged so it doesn't linger in the runtime image.
#
# WARP-537: the same RUN (while curl is still present) vendors the cosign
# binary the update agent execs for `cosign verify-blob` over OTA release
# manifests (src/services/update-agent/verify.ts). Version-pinned and
# checksum-pinned per arch (sha256s from the official
# cosign_checksums.txt for v${COSIGN_VERSION}); the build FAILS on any
# mismatch. `dpkg --print-architecture` keys the arch so the same
# Dockerfile builds amd64 + arm64 regardless of builder (BuildKit or
# classic — no reliance on the TARGETARCH build arg).
ARG COSIGN_VERSION=2.6.3
ARG COSIGN_SHA256_AMD64=7c78a7f2efc00088bd788a758db6e0928e79f3e0eb83eb5d3c499ed98da4c4f4
ARG COSIGN_SHA256_ARM64=b7c23659a50a59fd8eec44b87188e9062157d0c87796cac7b38727e5390c4917
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates curl && \
    install -d /usr/share/postgresql-common/pgdg && \
    curl --fail -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc && \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client-16 && \
    arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64) cosign_sha="$COSIGN_SHA256_AMD64" ;; \
      arm64) cosign_sha="$COSIGN_SHA256_ARM64" ;; \
      *) echo "unsupported architecture for cosign: $arch" >&2; exit 1 ;; \
    esac && \
    curl --fail -L -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${arch}" && \
    echo "${cosign_sha}  /usr/local/bin/cosign" | sha256sum -c - && \
    chmod 0755 /usr/local/bin/cosign && \
    /usr/local/bin/cosign version && \
    apt-get purge -y --auto-remove curl

# WARP-229: activate the OpenSSL 3 FIPS provider. Both the Node process
# (via its bundled OpenSSL) and any child processes inherit OPENSSL_CONF
# and pick up the FIPS config at startup. The boot self-test
# (`assertFipsAtBoot('orchestrator')` in src/index.ts) confirms the
# provider is loaded AND enforcing, and exits non-zero if either check
# fails.
ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

# WARP-967: install the NIST-validated FIPS provider (fips.so — OpenSSL
# 3.0.9, CMVP cert #4282, source-built in the fips-builder stage above)
# and run the build-time FIPS self-test: `openssl fipsinstall` executes
# the module's KATs and emits /etc/ssl/fipsmodule.cnf, then the script
# asserts the provider loads under /etc/ssl/openssl-fips.cnf and that
# MD5 is rejected (negative probe). Any failure fails the image build.
# Shipping the module does NOT activate FIPS at runtime — see the
# activation-strategy comment above the CMD (WARP-318 owns activation).
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN sh /tmp/install-fips-provider.sh /tmp/fips.so && \
    rm -f /tmp/fips.so /tmp/install-fips-provider.sh

# WARP-967: probe the exact combination WARP-318 will activate at
# runtime — Node's BUNDLED OpenSSL loading the validated module. The
# node release binaries statically link their own libcrypto (Debian's
# libssl3 is not what `node` uses), and two things differ from the
# system CLI as a result:
#   - node's baked-in MODULESDIR is not Debian's, so OPENSSL_MODULES
#     must point at the system ossl-modules dir;
#   - node reads the OpenSSL config under its own `nodejs_conf` appname;
#     `--openssl-shared-config` (NODE_OPTIONS-compatible, verified) makes
#     it honor the shared `openssl_conf` key in docker/openssl-fips.cnf.
#     We probe with the flag rather than baking a `nodejs_conf` alias
#     into the shared config: with an alias present, any node started
#     with OPENSSL_CONF pointing at the FIPS config but without
#     OPENSSL_MODULES aborts at startup (no providers -> CSPRNG assert),
#     which would brick this image's default, non-activated posture.
# Flag + env vars are scoped to this RUN only; runtime posture is
# unchanged (without the flag node ignores the `openssl_conf` key).
RUN OPENSSL_CONF=/etc/ssl/openssl-fips.cnf \
    OPENSSL_MODULES="$(openssl version -m | sed -n 's/^MODULESDIR: "\(.*\)"$/\1/p')" \
    node --openssl-shared-config -e 'const c = require("node:crypto"); \
      if (c.getFips() !== 1) { console.error("FIPS node self-test FAILED: bundled OpenSSL did not enter FIPS mode"); process.exit(1); } \
      let md5ok = false; \
      try { c.createHash("md5").update("probe").digest("hex"); md5ok = true; } catch {} \
      if (md5ok) { console.error("FIPS node self-test FAILED: MD5 succeeded under the FIPS config"); process.exit(1); } \
      console.log("FIPS build-time self-test OK (node bundled OpenSSL): provider active, MD5 rejected");'

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
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/auth-policy/package.json ./packages/auth-policy/package.json
COPY --from=builder /app/packages/auth-policy/dist ./packages/auth-policy/dist
COPY --from=builder /app/services/mcp-server/package.json ./services/mcp-server/package.json
COPY --from=builder /app/services/mcp-server/dist ./services/mcp-server/dist
# @droplet/erp-connector is built in the builder stage (npm run -w
# @droplet/erp-connector build) and eagerly required by
# apps/orchestrator/src/services/integrations.service.ts at boot (the
# Eaglesoft provider). Without copying its built dist here the
# node_modules/@droplet/erp-connector symlink dangles at runtime and the
# orchestrator crashloops on `Cannot find module '@droplet/erp-connector'`
# — builds pass (builder has it) but the container never boots. Mirrors the
# mcp-server COPY above.
COPY --from=builder /app/services/erp-connector/package.json ./services/erp-connector/package.json
COPY --from=builder /app/services/erp-connector/dist ./services/erp-connector/dist
# WARP-858: the embedding + reranker gRPC clients in the mcp-server stdio
# child use @grpc/proto-loader to read inference.proto AT RUNTIME (their
# last-resort lookup is /app/proto/inference.proto). Without this copy,
# every `search_content` call in a containerized orchestrator throws at
# embed time and surfaces as SEARCH_FAILED — hybrid search worked in dev
# (repo-relative resolution) and silently never in Docker. Mirrors the
# same COPY in services/mcp-server/Dockerfile.
COPY proto ./proto
COPY --from=builder /app/apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY --from=builder /app/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=builder /app/apps/orchestrator/prisma ./apps/orchestrator/prisma
# WARP-573: guarded migration-on-boot entrypoint (advisory lock +
# pre-migration snapshot + auto-recovery). Replaces the old inline
# `migrate deploy && node` CMD.
COPY --from=builder /app/apps/orchestrator/scripts ./apps/orchestrator/scripts
RUN chmod +x ./apps/orchestrator/scripts/migrate-and-start.sh
# WARP-81: bundle the IEEE OUI vendor registry snapshot. oui-lookup.service
# reads this at startup to resolve MAC prefixes → vendor names.
COPY --from=builder /app/apps/orchestrator/data/oui.csv ./apps/orchestrator/data/oui.csv
# Droplet identity prompt — leads the base system prompt for every
# /api/llm/chat surface (identity-prompt.ts reads it at first chat).
COPY --from=builder /app/apps/orchestrator/data/droplet-identity.md ./apps/orchestrator/data/droplet-identity.md
# WARP-535: baked-in OTA trust anchor. The update agent verifies
# cosign-signed release manifests against this public key. dist/ contains
# only compiled TS, so the .pub must be shipped explicitly; the runtime
# path mirrors the source path so dev (src/) and container (dist/) resolve
# the same file (see update-agent/verify.ts). scripts/test-security.sh
# asserts this COPY stays present. Until the key ceremony replaces the
# placeholder (scripts/README.md), verify fails closed by design.
COPY --from=builder /app/apps/orchestrator/src/services/update-agent/cosign.pub ./apps/orchestrator/src/services/update-agent/cosign.pub

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
# IMPORTANT — the FIPS module (WARP-967):
#   The NIST-validated OpenSSL FIPS provider (fips.so, OpenSSL 3.0.9,
#   CMVP cert #4282) now ships IN this image: source-built in the
#   fips-builder stage, installed into the system OpenSSL MODULESDIR,
#   KAT-tested at build time via `openssl fipsinstall`, which also emits
#   /etc/ssl/fipsmodule.cnf. Shipping the module does not activate FIPS:
#     - docker-compose.yml overrides OPENSSL_CONF back to the stock
#       /etc/ssl/openssl.cnf by default (Prisma/libpq cipher clash — see
#       the compose comment on the orchestrator service).
#     - Node's bundled OpenSSL additionally needs OPENSSL_MODULES
#       pointing at the system ossl-modules dir to find fips.so (its
#       baked-in MODULESDIR is not Debian's) and
#       NODE_OPTIONS=--openssl-shared-config so it honors the shared
#       `openssl_conf` key — see the build-time node probe above.
#   Production activation (WARP-318) = setting OPENSSL_CONF=
#   /etc/ssl/openssl-fips.cnf + OPENSSL_MODULES +
#   NODE_OPTIONS=--openssl-shared-config + DROPLET_FIPS_REQUIRED=true
#   together in the container env. Until then, DROPLET_FIPS_REQUIRED=false
#   (the compose default) skips the boot self-test and runs in the
#   non-FIPS posture (development / CI / staging).
# WARP-573: boot through the guarded migration entrypoint instead of the old
# unguarded `npx prisma migrate deploy && node dist/index.js`. The script takes
# a Postgres advisory lock (so concurrent/looping starts can't race the
# _prisma_migrations table), snapshots the DB before applying pending
# migrations, auto-recovers a power-cut-induced failed migration, and on
# unrecoverable failure exits non-zero with a loud, greppable banner + recovery
# runbook instead of silently restart-looping. See scripts/migrate-and-start.sh
# and .superpowers/brainstorm/WARP-573.md.
EXPOSE 3000
CMD ["./scripts/migrate-and-start.sh"]
