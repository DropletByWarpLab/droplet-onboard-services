"""WARP-RAG-EVAL — subprocess wrapper around the canonical ragas_runner.py.

We deliberately invoke ragas_runner.py as a subprocess instead of importing
its `run()` function:

  - Process isolation: a RAGAS internal crash (timeout, malformed judge
    response, etc.) can't kill the scheduler. The next scheduled tick
    still fires.
  - Memory hygiene: ragas + langchain leak references in long-running
    processes; subprocess teardown reclaims everything cleanly.
  - CLI surface unchanged: the exact same script the offline docs
    document (`python ragas_runner.py --variant hybrid ...`) runs
    inside the container with no per-environment shim — outputs match
    by construction.

The image bakes the canonical files under /opt/rag-eval/ in a tree
that mirrors the repo layout, so ragas_runner.py's own
`Path(__file__).resolve().parents[3]` repo-root lookup works without
patching. See services/rag-eval/Dockerfile for the layout.

Outputs land at /data/rag-eval/runs/results-<timestamp>.{json,md}. The
scheduler ticks once per hour during off-hours; each tick is a fresh
subprocess. The aggregator (`ragas_runner.py aggregate ...`) is also
invoked here on the bootstrap path.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from config import (
    ORCHESTRATOR_URL,
    RAGAS_JUDGE,
    RAGAS_LIMIT,
    RAGAS_VARIANT,
    RUNS_DIR,
)

logger = logging.getLogger("rag-eval.runner")

# Baked into the image — see Dockerfile. The runner script lives at the
# canonical repo-relative path; ragas_runner.py's `parents[3]` resolves
# to /opt/rag-eval/, and queries.yaml + goldens.yaml are siblings under
# /opt/rag-eval/tests/retrieval-eval/.
RUNNER_SCRIPT = Path(
    "/opt/rag-eval/tests/retrieval-eval/ragas/ragas_runner.py"
)


def _utc_stamp() -> str:
    """YYYYMMDDTHHMMSSZ — lexicographically sortable, unambiguous timezone."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _ensure_dirs(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)


def run_once(target_dir: Path | None = None) -> Path:
    """Execute one RAGAS pass. Returns the results.json path.

    target_dir:
      Directory to write results-<stamp>.{json,md} into. Defaults to
      RUNS_DIR (the scheduler's canonical directory). The bootstrap
      flow passes its own per-bootstrap subdir so the aggregator only
      sees the runs that bootstrap just produced — never the rolling
      history written by the hourly scheduler.

    Raises:
      subprocess.CalledProcessError: ragas_runner.py exited non-zero.
        The scheduler logs + swallows; the failure surfaces in the
        target directory as a missing slot.
    """
    target = target_dir if target_dir is not None else RUNS_DIR
    _ensure_dirs(target)
    stamp = _utc_stamp()
    out_json = target / f"results-{stamp}.json"
    out_md = target / f"results-{stamp}.md"

    cmd = [
        sys.executable,
        str(RUNNER_SCRIPT),
        "--variant", RAGAS_VARIANT,
        "--limit", str(RAGAS_LIMIT),
        "--judge", RAGAS_JUDGE,
        "--api-url", ORCHESTRATOR_URL,
        "--out", str(out_json),
        "--out-md", str(out_md),
    ]
    logger.info("starting RAGAS run → %s", out_json.name)
    completed = subprocess.run(
        cmd,
        check=True,
        capture_output=True,
        text=True,
    )
    # ragas_runner.py prints progress to stdout. Surface its tail in
    # case operators tail the container logs.
    for line in completed.stdout.splitlines()[-10:]:
        logger.info("[ragas] %s", line)
    return out_json


def aggregate_to_baselines(
    out_path: Path, results_dir: Path | None = None
) -> Path:
    """Roll all results-*.json in `results_dir` into a baselines.json
    at `out_path`. Defaults `results_dir` to RUNS_DIR for ad-hoc use,
    but the bootstrap flow passes its own subdir so the aggregation is
    scoped strictly to the runs it just produced — see WARP-RAG-EVAL
    review #1.
    """
    src = results_dir if results_dir is not None else RUNS_DIR
    cmd = [
        sys.executable,
        str(RUNNER_SCRIPT),
        "aggregate",
        "--results-dir", str(src),
        "--out-baselines", str(out_path),
        "--judge", RAGAS_JUDGE,
    ]
    logger.info("aggregating runs in %s → %s", src, out_path)
    subprocess.run(cmd, check=True)
    return out_path
