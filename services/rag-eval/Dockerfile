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
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      tzdata

# Python deps first (cache-friendly).
COPY services/rag-eval/requirements.txt .
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Goldens + queries + the canonical runner — baked at build time per the
# "image-first, no repo on appliance" deploy convention. Mirror the repo
# tree so ragas_runner.py's relative-path lookup works unchanged.
COPY tests/retrieval-eval/queries.yaml \
     /opt/rag-eval/tests/retrieval-eval/queries.yaml
COPY tests/retrieval-eval/ragas/goldens.yaml \
     /opt/rag-eval/tests/retrieval-eval/ragas/goldens.yaml
COPY tests/retrieval-eval/ragas/ragas_runner.py \
     /opt/rag-eval/tests/retrieval-eval/ragas/ragas_runner.py

# WARP-2732 (ADR-048) — the extraction canary: scorer, box-side runner, the
# 12-fixture corpus and its answer key.
#
# 🔴 WITHOUT THESE FOUR COPY LINES THE CANARY IS INVISIBLE TO THE BOX. The
# appliance runs images, not a repo checkout ("image-first, no repo on
# appliance"), so a `tests/extraction-eval/` directory that exists only in git
# is a canary nobody can run — and `auto` mode is gated on running it. A
# goldens edit that does not rebuild this image measures the OLD corpus while
# reporting today's date.
COPY tests/extraction-eval/score.py /opt/rag-eval/tests/extraction-eval/score.py
COPY tests/extraction-eval/extraction_runner.py /opt/rag-eval/tests/extraction-eval/extraction_runner.py
COPY tests/extraction-eval/goldens.yaml /opt/rag-eval/tests/extraction-eval/goldens.yaml
COPY tests/extraction-eval/fixtures /opt/rag-eval/tests/extraction-eval/fixtures

# Service-local Python: scheduler wiring + main + subprocess runner.
COPY services/rag-eval/*.py /opt/rag-eval/

# WARP-236 — shared internal-mTLS helper. main.build_uvicorn_config() imports
# `from _shared.internal_tls import ...`; the WORKDIR is /opt/rag-eval so the
# package must live there.
COPY services/_shared/__init__.py /opt/rag-eval/_shared/__init__.py
COPY services/_shared/internal_tls.py /opt/rag-eval/_shared/internal_tls.py
# WARP-1061: cert-presenting healthcheck client (see HEALTHCHECK below).
COPY services/_shared/healthcheck.py /opt/rag-eval/_shared/healthcheck.py

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
# GWV-015: probe the real HTTP surface (:8090/health) so a wedged uvicorn or a
# dead HTTP half is not reported healthy. python:3.11-slim has no curl.
# WARP-1061: the shared cert-presenting client replaces the inline plain-HTTP
# urlopen — a plaintext probe against the DROPLET_INTERNAL_TLS=1 listener
# would flap this container unhealthy forever; it stays plain HTTP when off.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -m _shared.healthcheck 8090 /health || exit 1

CMD ["python", "main.py"]
