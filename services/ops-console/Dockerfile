# ops-console — operator-side monitoring. Sees the rest of the stack;
# is NOT customer-facing. Mounts /var/run/docker.sock so it can read
# container logs + restart containers — that's the whole point.
FROM python:3.12-slim AS base

# Tiny base — just the python deps + the source. No build deps needed
# (FastAPI / docker / psutil are pure-python or ship binary wheels).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps before copying source so re-edits don't bust the layer.
COPY services/ops-console/requirements.txt \
     services/ops-console/requirements-dev.txt \
     /app/
RUN pip install --no-cache-dir -r /app/requirements-dev.txt

COPY services/ops-console/ /app/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8087

# Cheap healthcheck — just confirm the FastAPI process answers /healthz
# (which is unauthenticated; /ops/* require the bearer token).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8087/healthz || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8087", "--no-server-header"]
