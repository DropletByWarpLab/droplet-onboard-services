FROM python:3.12-slim

# Build context is the monorepo root (matches the file-indexer convention,
# see docker-compose.yml) so paths are relative to repo root.

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY services/pm/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/pm/main.py services/pm/config.py ./

# Plane upstream pin SHA — injected at image build time via --build-arg.
# Surfaced in /health responses. See ADR-010 + spec OQ3.
ARG PLANE_PIN_SHA=unknown
ENV DROPLET_PM_PLANE_VERSION=${PLANE_PIN_SHA}

EXPOSE 8090

# `--no-access-log` quiets the per-request access log (the orchestrator + ship-check
# poll /health frequently). The previous `--log-config /dev/null` crashed uvicorn on
# startup: logging.config.fileConfig() rejects an empty file
# ("RuntimeError: /dev/null is an empty file").
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090", "--no-access-log"]
