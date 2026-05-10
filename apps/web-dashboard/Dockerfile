# --- Build stage ---
# Build stage stays on `node:20-alpine` because the Next.js compile is
# pure JS — no cryptographic operations happen at build time, so there's
# no FIPS-provider requirement for this layer. Trims ~30 MB off the
# build cache vs. switching the build image too. WARP-229.
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

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

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
