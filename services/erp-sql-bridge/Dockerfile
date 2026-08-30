FROM python:3.12-slim

# Build context is the monorepo root (see docker/docker-compose.yml). All COPY
# paths are relative to the repo root.

# unixODBC is the driver manager every path here goes through. The PostgreSQL
# ODBC driver is installed alongside it deliberately: it is what the test lane
# (scripts/test-erp-sql-bridge.sh) drives the service against, and having it in
# the image means the same container that ships can be proven end-to-end
# without the license-gated SAP client.
#
# WARP-1065: BuildKit cache mounts — apt archives persist across rebuilds.
# docker-clean is dropped inside the mount scope so .debs are retained; the
# mounts shadow both paths in the layer, so the image stays slim.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      unixodbc unixodbc-dev odbc-postgresql \
      gcc libc-dev \
      openssl ca-certificates

WORKDIR /app
COPY services/erp-sql-bridge/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc-dev

# ---------------------------------------------------------------------------
# SAP SQL Anywhere client — OPERATOR-SUPPLIED, NEVER VENDORED HERE.
#
# The client (libdbodbc17_r.so) is license-governed and account-walled: it
# cannot be fetched in a build, and redistributing it in our image would be a
# licensing violation. So the image ships WITHOUT it and the direct-SQL track
# stays honestly blocked (ERP_NOT_CONNECTED) until an operator supplies it.
#
# To enable the track, drop the EXTRACTED Linux x86_64 client into
# `services/erp-sql-bridge/vendor/sqlanywhere/` (the tree containing `lib64/`)
# before building. That directory is gitignored except for its README; the
# unpacking is left to the operator on purpose, because SAP's installer is an
# interactive license acceptance and automating it away is not ours to do.
#
# Architecture note: SAP ships no aarch64 Linux client. On an ARM box this
# service can only ever run the REST track's sibling or a psqlODBC test lane —
# which is one of the reasons `services/erp-connector` also implements the
# Patterson REST API track (`eaglesoft-api`).
# ---------------------------------------------------------------------------
COPY services/erp-sql-bridge/vendor/ /opt/vendor/
RUN if [ -d /opt/vendor/sqlanywhere/lib64 ]; then \
      echo "/opt/vendor/sqlanywhere/lib64" > /etc/ld.so.conf.d/sqlanywhere.conf && \
      ldconfig && \
      printf '[SQL Anywhere 17]\nDescription=SAP SQL Anywhere 17\nDriver=/opt/vendor/sqlanywhere/lib64/libdbodbc17_r.so\nThreading=1\n' \
        >> /etc/odbcinst.ini && \
      echo "SAP SQL Anywhere client registered."; \
    else \
      echo "NOTE: no SAP SQL Anywhere client vendored — the direct-SQL ERP track will stay blocked."; \
    fi

# allowlist.py + statement_manifest.json are load-bearing (WARP-2540): the
# app refuses to import without the manifest, so a bridge missing it cannot
# start half-guarded.
COPY services/erp-sql-bridge/main.py services/erp-sql-bridge/db.py services/erp-sql-bridge/schemas.py services/erp-sql-bridge/allowlist.py services/erp-sql-bridge/statement_manifest.json ./

# WARP-229: FIPS-provider OpenSSL config + shared self-test helper.
# `OPENSSL_CONF` is intentionally NOT set at image-baseline (see
# services/file-indexer/Dockerfile rationale) — the operator flips
# OPENSSL_CONF + DROPLET_FIPS_REQUIRED together at runtime.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py
COPY services/_shared/serve.py /app/_shared/serve.py

EXPOSE 9095
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "9095"]
