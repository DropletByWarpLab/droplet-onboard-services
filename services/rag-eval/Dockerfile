FROM python:3.11-slim

# Build context is the monorepo root (see docker-compose.yml service block)
# so we can COPY the canonical queries.yaml + goldens.yaml + ragas_runner.py
# directly from their tree locations. All COPY paths below are therefore
# relative to the repo root.

WORKDIR /opt/rag-eval

# System deps — minimal. RAGAS itself is pure Python; we just need:
#  - ca-certificates for HTTPS to the cloud judge (optional)
#  - tzdata so the scheduler's local-time cron expressions resolve correctly
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      tzdata && \
    rm -rf /var/lib/apt/lists/*

# Python deps first (cache-friendly).
COPY services/rag-eval/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Goldens + queries + the canonical runner. Baked at build time per the
# project's "image-first, no repo on appliance" deploy convention. Operators
# rebuild + redeploy the image when goldens change — there's no runtime
# mount for these files.
COPY tests/retrieval-eval/queries.yaml /opt/rag-eval/queries.yaml
COPY tests/retrieval-eval/ragas/goldens.yaml /opt/rag-eval/goldens.yaml
COPY tests/retrieval-eval/ragas/ragas_runner.py /opt/rag-eval/ragas_runner.py

# Service-local Python: scheduler wiring + main + subprocess runner.
COPY services/rag-eval/*.py /opt/rag-eval/

# /data/rag-eval is mounted from a named volume in the compose file; the
# scheduler writes per-run JSON + a rolling baselines.candidate.json here.
RUN mkdir -p /data/rag-eval/runs

# Default cmd: run the scheduler forever. The container is restart=always
# in compose, so a crash + restart picks up the next cron tick instead of
# trying to backfill missed slots (coalesce=True on the apscheduler job
# absorbs short outages).
CMD ["python", "main.py"]
