"""WARP-RAG-EVAL — subprocess wrapper around the canonical ragas_runner.py.

We deliberately invoke ragas_runner.py as a subprocess instead of importing
its `run()` function:

  - Process isolation: a RAGAS internal crash (timeout, malformed judge
    response, etc.) can't kill the scheduler. The next scheduled tick
    still fires.
  - Memory hygiene: ragas + langchain leak references in long-running
    processes; subprocess teardown reclaims everything cleanly.
  - CLI surface unchanged: the same script the CI / dev runner uses, so
    behavior matches "offline" and "in-container" runs by construction.

Outputs land at /data/rag-eval/runs/results-<timestamp>.{json,md}. The
scheduler ticks once per hour during off-hours; each tick is a fresh
subprocess. The aggregator (ragas_runner.py aggregate ...) is also
invoked here on the `bootstrap` path.
"""

from __future__ import annotations

import logging
import shutil
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

# Baked into the image at /opt/rag-eval/ — see Dockerfile.
RUNNER_SCRIPT = Path("/opt/rag-eval/ragas_runner.py")
QUERIES_YAML = Path("/opt/rag-eval/queries.yaml")
GOLDENS_YAML = Path("/opt/rag-eval/goldens.yaml")


def _utc_stamp() -> str:
    """YYYYMMDDTHHMMSSZ — lexicographically sortable, unambiguous timezone."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _ensure_dirs() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _link_canonical_paths_into_runner_cwd(tmpdir: Path) -> None:
    """ragas_runner.py looks up queries.yaml + goldens.yaml under
    `<repo_root>/tests/retrieval-eval/...` relative to its own location.
    The image bakes them at /opt/rag-eval/{queries,goldens}.yaml; we
    fake the directory layout via symlinks rather than patching the
    script. Keeps ragas_runner.py byte-for-byte identical to the source
    file in the repo so we never drift.
    """
    fake_root = tmpdir / "tests" / "retrieval-eval"
    (fake_root / "ragas").mkdir(parents=True, exist_ok=True)
    (fake_root / "queries.yaml").symlink_to(QUERIES_YAML)
    (fake_root / "ragas" / "goldens.yaml").symlink_to(GOLDENS_YAML)
    (fake_root / "ragas" / "ragas_runner.py").symlink_to(RUNNER_SCRIPT)


def run_once() -> Path:
    """Execute one RAGAS pass. Returns the results.json path.

    Raises:
      subprocess.CalledProcessError: ragas_runner.py exited non-zero.
        The scheduler logs + swallows; the failure surfaces in
        /data/rag-eval/runs/ as a missing slot.
    """
    _ensure_dirs()
    stamp = _utc_stamp()
    out_json = RUNS_DIR / f"results-{stamp}.json"
    out_md = RUNS_DIR / f"results-{stamp}.md"

    # ragas_runner.py computes repo_root = three parents up from itself.
    # We fake a parent tree under a temp dir so its yaml lookups resolve.
    tmpdir = RUNS_DIR / f".workdir-{stamp}"
    tmpdir.mkdir(parents=True, exist_ok=True)
    try:
        _link_canonical_paths_into_runner_cwd(tmpdir)
        runner_in_tmp = (
            tmpdir / "tests" / "retrieval-eval" / "ragas" / "ragas_runner.py"
        )

        cmd = [
            sys.executable,
            str(runner_in_tmp),
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
        # ragas_runner.py prints progress to stdout. Surface its tail
        # in case operators tail the container logs.
        for line in completed.stdout.splitlines()[-10:]:
            logger.info("[ragas] %s", line)
        return out_json
    finally:
        # Best-effort cleanup; failures during teardown shouldn't mask
        # a successful or already-failed run.
        try:
            shutil.rmtree(tmpdir)
        except OSError as e:
            logger.warning("failed to clean %s: %s", tmpdir, e)


def aggregate_to_baselines(out_path: Path) -> Path:
    """Roll all results-*.json in RUNS_DIR into a baselines.json at out_path."""
    cmd = [
        sys.executable,
        str(RUNNER_SCRIPT),
        "aggregate",
        "--results-dir", str(RUNS_DIR),
        "--out", str(out_path),
        "--judge", RAGAS_JUDGE,
    ]
    logger.info("aggregating runs → %s", out_path)
    subprocess.run(cmd, check=True)
    return out_path
