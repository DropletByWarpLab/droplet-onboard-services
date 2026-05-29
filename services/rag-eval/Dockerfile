FROM python:3.11-slim

# Build context is the monorepo root (see docker-compose.yml service block).
# All COPY paths below are relative to the repo root.
#
# Layout inside the container is chosen to satisfy ragas_runner.py's own
# `repo_root = Path(__file__).resolve().parents[3]` lookup. The script
# uses that to find queries.yaml + goldens.yaml as siblings under
# `<repo_root>/tests/retrieval-eval/`. We mirror that tree shape under
# /opt/rag-eval/ so the script works WITHOUT any patching — the same
# `python ragas_runner.py --variant hybrid ...` invocation that the
# original docs document still works byte-for-byte from inside the
# container.
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

# Goldens + queries + the canonical runner — baked at build time per the
# "image-first, no repo on appliance" deploy convention. Mirror the repo
# tree so ragas_runner.py's relative-path lookup works unchanged.
COPY tests/retrieval-eval/queries.yaml \
     /opt/rag-eval/tests/retrieval-eval/queries.yaml
COPY tests/retrieval-eval/ragas/goldens.yaml \
     /opt/rag-eval/tests/retrieval-eval/ragas/goldens.yaml
COPY tests/retrieval-eval/ragas/ragas_runner.py \
     /opt/rag-eval/tests/retrieval-eval/ragas/ragas_runner.py

# Service-local Python: scheduler wiring + main + subprocess runner.
COPY services/rag-eval/*.py /opt/rag-eval/

# /data/rag-eval is mounted from a named volume in the compose file; the
# scheduler writes per-run JSON + a rolling baselines.candidate.json here.
RUN mkdir -p /data/rag-eval/runs

# WARP-519: the HTTP trigger server (FastAPI/uvicorn) binds 8090 on the
# internal Docker network. No host publish in compose — the orchestrator
# reaches it by service name and is the auth wall. Keep this in sync with
# RAG_EVAL_HTTP_PORT in config.py.
EXPOSE 8090

# Default cmd: service mode — starts the AsyncIOScheduler (hourly cron) AND
# the FastAPI HTTP trigger server in one event loop. The container is
# restart=always in compose, so a crash + restart picks up the next cron
# tick instead of backfilling missed slots (coalesce=True on the apscheduler
# job absorbs short outages); in-flight HTTP-triggered runs are forgotten on
# restart (the filesystem is the source of truth for completed runs).
CMD ["python", "main.py"]
