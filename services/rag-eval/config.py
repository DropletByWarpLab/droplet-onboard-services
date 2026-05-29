"""WARP-RAG-EVAL — env-var config for the rag-eval service.

All knobs are env-vars so operators can tune cadence / judge / endpoints
without rebuilding the image. Defaults are tuned for the appliance test
box (Ollama on host, orchestrator on Docker network).
"""

from __future__ import annotations

import os
from pathlib import Path

# Where the scheduler writes per-run results and the rolling
# baselines.candidate.json. Bind-mounted in compose so results survive
# container restarts.
RESULTS_DIR = Path(os.environ.get("RAG_EVAL_RESULTS_DIR", "/data/rag-eval"))
RUNS_DIR = RESULTS_DIR / "runs"

# Cron expression for the scheduled hourly off-hours run, in the timezone
# resolved by tzlocal(). Default: hourly 22:00–05:00 local time
# (apscheduler's `hour` field is inclusive both ends, so 22-5 means
# 22, 23, 0, 1, 2, 3, 4, 5 = 8 slots/night).
CRON_HOUR = os.environ.get("RAG_EVAL_CRON_HOUR", "22-23,0-5")
CRON_MINUTE = os.environ.get("RAG_EVAL_CRON_MINUTE", "0")

# Orchestrator base URL on the internal Docker network. Default targets
# the orchestrator container by service name.
ORCHESTRATOR_URL = os.environ.get(
    "ORCHESTRATOR_URL", "http://orchestrator:3000"
)

# Judge LLM mode. "local" → Ollama on the appliance; "cloud" → OpenAI
# (requires OPENAI_API_KEY). Mirrors ragas_runner.py's CLI flag default.
RAGAS_JUDGE = os.environ.get("RAGAS_JUDGE", "local")

# Retrieval variant the eval drives. Today's options are "vector", "rrf",
# "hybrid", "hybrid-enhanced" (the WARP-437 adaptive-routing variant).
# Defaults to the WARP-286 baseline so we measure the pre-enhancement path
# until the per-class enforcement lands; operators flip to
# "hybrid-enhanced" once they want enhancement to count.
RAGAS_VARIANT = os.environ.get("RAGAS_VARIANT", "hybrid")

# Top-K results per query. Matches the NDCG@10 harness's k.
RAGAS_LIMIT = int(os.environ.get("RAGAS_LIMIT", "10"))

# Per-call timeout for the orchestrator retrieval endpoint. The cloud
# judge can take a few seconds; the local judge can take longer if the
# GPU is contested. ragas_runner.py honors this via its env var.
SEARCH_TIMEOUT_SEC = float(
    os.environ.get("RAGAS_SEARCH_TIMEOUT_SEC", "30")
)

# Skip the scheduler entirely and run nothing — useful for the test
# Compose lane where we just want the image present but inert.
# WARP-519: when DISABLED, the scheduler does NOT register its cron job,
# but the HTTP trigger server STILL starts so operators can fire ad-hoc
# runs from the dashboard. "Disabled" means "no automatic schedule", not
# "no service" — the HTTP surface is the whole point of WARP-519.
DISABLED = os.environ.get("RAG_EVAL_DISABLED", "0") == "1"

# WARP-519: HTTP trigger server. Binds on the internal Docker network so
# the orchestrator can proxy ad-hoc /run, /bootstrap, and run-listing
# calls. No host publish — the orchestrator is the auth wall; this server
# has no auth of its own.
HTTP_HOST = os.environ.get("RAG_EVAL_HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("RAG_EVAL_HTTP_PORT", "8090"))

# Path to the rolling baselines candidate written by `bootstrap`. Read by
# the HTTP GET /baselines endpoint. Mirrors main.py cmd_bootstrap's
# out_path so the two stay in lockstep.
BASELINES_CANDIDATE = RESULTS_DIR / "baselines.candidate.json"
