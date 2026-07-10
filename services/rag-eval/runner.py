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

run_once() uses subprocess.Popen with stdout=PIPE so each output line is
forwarded to the logger as it arrives — operators can tail `docker logs -f`
during the 10-30 min run and see live progress instead of a 30-min silence
followed by a wall of text (WARP-520).
"""

from __future__ import annotations

import logging
import os
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


_KEEP_RUNS = int(os.environ.get("RAG_EVAL_KEEP_RUNS", "500"))


def _prune_old_runs(target: Path, keep: int = _KEEP_RUNS) -> None:
    """Keep only the newest `keep` result pairs (results-<stamp>.json/.md).

    GWV-016: the off-hours runs wrote a pair per run forever (~5,800 files/yr)
    with no retention — unbounded growth on an appliance meant to run for years,
    and /runs globs the whole directory on every call.
    """
    try:
        jsons = sorted(target.glob("results-*.json"))
        for old in jsons[:-keep] if keep > 0 else []:
            old.unlink(missing_ok=True)
            old.with_suffix(".md").unlink(missing_ok=True)
    except Exception:  # pragma: no cover - best-effort janitor
        logger.warning("run-results prune failed", exc_info=True)


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
    # Stream child output line-by-line so `docker logs -f` shows judge-call
    # progress during the 10-30 min run instead of a 30-min silence, and so
    # we don't buffer the entire run's stdout in memory (WARP-520).
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,  # fold stderr into the same stream, in order
        text=True,
        bufsize=1,  # line-buffered
    )
    # proc.stdout is guaranteed non-None because stdout=PIPE; guard
    # explicitly rather than `assert` (which `python -O` would strip).
    if proc.stdout is None:  # pragma: no cover
        raise RuntimeError("subprocess stdout pipe unexpectedly None")
    # `with` closes the pipe deterministically once drained, instead of
    # leaving it open until the proc object is GC'd.
    with proc.stdout:
        for line in proc.stdout:
            logger.info("[ragas] %s", line.rstrip())
    proc.wait()
    _prune_old_runs(target)  # GWV-016: bound unbounded results-*.json growth
    if proc.returncode != 0:
        # Preserve the existing contract: non-zero exit raises
        # CalledProcessError so the scheduler's _safe_run catches + skips
        # the slot, and bootstrap counts it as a failure.
        raise subprocess.CalledProcessError(proc.returncode, cmd)
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
