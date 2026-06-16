FROM python:3.12-slim

# Warp fleet HQ — per-device TLS issuance service (ADR-023, C1).
# Deployed to hq.warp-lab.com, NOT to a box. The build context is THIS
# directory (services/fleet-server), see docker-compose.yml — it is a
# standalone HQ deploy, not part of the box monorepo compose.

# openssl + ca-certificates for the ACME/cryptography TLS paths. The
# FIPS boot hook in main.py is env-gated and a no-op on HQ (HQ is not a
# FIPS deployment), and degrades cleanly if the _shared helper is absent.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Runtime data dir for the persisted ACME account key (HQ-only secret,
# mounted as a volume in compose; never baked into the image).
RUN mkdir -p /data/fleet-server

EXPOSE 8088
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8088"]
