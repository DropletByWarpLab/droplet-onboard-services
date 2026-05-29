FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root. Mirrors services/routing.

# System deps for the FIPS provider (WARP-229) — same posture as routing.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/email-indexer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/email-indexer/ .

# WARP-229: FIPS-provider OpenSSL config + shared self-test helper.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py

EXPOSE 8086
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8086"]
