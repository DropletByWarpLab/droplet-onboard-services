# WARP-2895 — services/sandbox: the box's one code-execution substrate.
#
# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root.
#
# What is in the image and why:
#   Python 3.12   — the `transform` step's interpreter (runner.py)
#   Node 20       — the dev-tooling ceiling; extension processes (slice H) and
#                   workshop runs (slice G) run TypeScript here
#   tsc (global)  — the workspace `run` allow-list's `tsc` (WARP-2896); the
#                   same 5.x line the monorepo builds with
#   pytest, ruff  — the allow-list's Python half (requirements.txt)
#   git           — the workspace git store (gitstore.py): bare repos on the
#                   workspace-git volume, checkouts on workspace-checkouts,
#                   `git http-backend` for the orchestrator's /git proxy
#   /app/templates — extensions/templates/, seeded into templates.git on
#                   first start (never re-seeded over an operator's commits)
# Nothing installs at runtime: `npm install` / `pip install` from inside the
# container reach nothing, by the network the compose file puts it on.
#
# Non-root, and the compose entry makes the rootfs read-only with a tmpfs
# /tmp — the Dockerfile must therefore leave nothing the service needs to
# write at runtime outside /tmp and the two workspace volumes.

# Node from the official image, copied in rather than apt-installed: Debian
# bookworm ships Node 18, and the toolchain ceiling is 20 (WARP-2069).
FROM node:20-bookworm-slim AS node

FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm install -g --no-fund --no-audit typescript@5.9.3 && \
    node --version && npm --version && tsc --version && python --version && git --version

RUN groupadd --gid 1000 sandbox && \
    useradd --uid 1000 --gid sandbox --shell /usr/sbin/nologin --create-home sandbox

WORKDIR /app
COPY services/sandbox/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/sandbox/ .
COPY extensions/templates/ /app/templates/

# The git store's two mount points (compose: workspace-git, workspace-checkouts)
# and the installed-extensions dir (compose: extensions-installed, WARP-2900),
# owned by the service user so a fresh volume is writable without an init hook.
# The MCP host shims (ext_host/) arrive with `COPY services/sandbox/ .` above.
RUN mkdir -p /var/lib/workspace-git /var/lib/workspace /var/lib/workspace-ext && \
    chown -R sandbox:sandbox /var/lib/workspace-git /var/lib/workspace /var/lib/workspace-ext

# Sibling shape (doc-render / web-fetch): ship the FIPS-provider OpenSSL config
# + shared helpers. NOT one of the provider-carrying images — compose pins
# DROPLET_FIPS_REQUIRED=false / stock OPENSSL_CONF, so the boot self-test is a
# no-op.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py
COPY services/_shared/serve.py /app/_shared/serve.py
COPY services/_shared/healthcheck.py /app/_shared/healthcheck.py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER sandbox

EXPOSE 8030
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "8030"]
