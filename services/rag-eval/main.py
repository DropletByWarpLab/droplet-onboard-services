"""WARP-RAG-EVAL / WARP-519 — rag-eval service entry point.

CLI:
  python main.py                     → service mode: starts the
                                       AsyncIOScheduler (hourly off-hours
                                       run) AND the FastAPI HTTP trigger
                                       server (server.py) in one shared
                                       asyncio event loop. Blocks until
                                       SIGINT/SIGTERM. This is the default
                                       container CMD.
  python main.py run-once            → single RAGAS run, then exit.
                                       Useful for ad-hoc sanity checks.
  python main.py bootstrap [--runs N]
                                     → N sequential RAGAS runs, then
                                       aggregate them into
                                       /data/rag-eval/baselines.candidate.json
                                       via `ragas_runner.py aggregate`.
                                       N defaults to 5 — the minimum the
                                       schema convention recommends for
                                       IQR-derived floors.

WARP-519: service mode now runs uvicorn (FastAPI) and the AsyncIOScheduler
in the SAME event loop so an HTTP-triggered `/run` and a scheduled run
share one in-process busy flag (run_state.STORE) and never overlap. The
scheduled job hands the blocking RAGAS subprocess to a thread executor so
it never freezes the HTTP server. When RAG_EVAL_DISABLED=1 the scheduler's
cron job is NOT registered, but the HTTP server STILL serves — "disabled"
means "no automatic schedule", not "no service" (the HTTP trigger surface
is the whole point of WARP-519). The `run-once` / `bootstrap` CLI
subcommands are unchanged for shell-based ops.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("rag-eval")

import runner
import scheduler_service
from config import DISABLED, HTTP_HOST, HTTP_PORT, RESULTS_DIR


def build_uvicorn_config(app):
    """uvicorn.Config for the :8090 trigger server.

    WARP-1061: merges ``uvicorn_ssl_kwargs()`` so DROPLET_INTERNAL_TLS=1
    serves the /data/service-tls bundle and REQUIRES a CA-signed client cert
    (the orchestrator's admin-rag-eval proxy presents one); unset/0 keeps
    the plain-HTTP listener byte-identical to before. Split from ``_serve``
    so the flag contract is unit-testable without binding a socket.
    """
    import uvicorn  # local import — only needed in service mode

    from _shared.internal_tls import uvicorn_ssl_kwargs

    return uvicorn.Config(
        app,
        host=HTTP_HOST,
        port=HTTP_PORT,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        # uvicorn manages SIGINT/SIGTERM; it returns from serve() cleanly.
        access_log=False,
        **uvicorn_ssl_kwargs(),
    )


async def _serve() -> None:
    """Run the AsyncIOScheduler + uvicorn HTTP server in one event loop.

    The scheduler binds to the running loop on `.start()`; uvicorn's
    `Server.serve()` runs on the same loop and blocks (awaits) until it
    receives SIGINT/SIGTERM — uvicorn installs its own signal handlers,
    so we don't register any here. On shutdown we stop the scheduler so
    any in-flight executor job is allowed to finish naturally (the busy
    flag clears when run_once returns).
    """
    import uvicorn  # local import — only needed in service mode

    import server

    sched = None
    if DISABLED:
        logger.info(
            "RAG_EVAL_DISABLED=1 — scheduler cron NOT registered; "
            "HTTP trigger server still serving on %s:%d",
            HTTP_HOST,
            HTTP_PORT,
        )
    else:
        sched = scheduler_service.build_scheduler()

    app = server.create_app()
    uv_server = uvicorn.Server(build_uvicorn_config(app))
    logger.info("rag-eval HTTP trigger server listening on %s:%d", HTTP_HOST, HTTP_PORT)
    try:
        await uv_server.serve()
    finally:
        if sched is not None:
            # wait=False: uvicorn already returned, the loop is closing;
            # an in-flight executor job finishes on its own thread.
            sched.shutdown(wait=False)


def cmd_schedule() -> int:
    try:
        asyncio.run(_serve())
    except (KeyboardInterrupt, SystemExit):
        pass
    return 0


def cmd_run_once() -> int:
    logger.info("ad-hoc single RAGAS run")
    try:
        out = runner.run_once()
    except Exception:
        logger.exception("run-once failed")
        return 1
    logger.info("run complete → %s", out)
    return 0


def cmd_bootstrap(n_runs: int) -> int:
    if n_runs < 1:
        logger.error("bootstrap requires --runs >= 1, got %d", n_runs)
        return 2
    # Isolated per-bootstrap subdir so we never roll the rolling-history
    # results-*.json files written by the scheduler into the aggregator.
    # Without this, `bootstrap --runs 5` after a few days of cron runs
    # would silently include dozens of stale runs in baselines.json.
    bootstrap_stamp = runner._utc_stamp()
    bootstrap_dir = RESULTS_DIR / f"bootstrap-{bootstrap_stamp}"
    logger.info(
        "bootstrap: running RAGAS %d× into %s then aggregating",
        n_runs,
        bootstrap_dir,
    )
    failures = 0
    for i in range(1, n_runs + 1):
        logger.info("bootstrap run %d / %d", i, n_runs)
        try:
            runner.run_once(target_dir=bootstrap_dir)
        except Exception:
            failures += 1
            logger.exception("bootstrap run %d failed", i)
    if failures == n_runs:
        logger.error("all %d bootstrap runs failed; not aggregating", n_runs)
        return 1
    out_path = RESULTS_DIR / "baselines.candidate.json"
    try:
        runner.aggregate_to_baselines(out_path, results_dir=bootstrap_dir)
    except Exception:
        logger.exception("aggregate step failed")
        return 1
    logger.info(
        "bootstrap complete — %d/%d runs successful, baselines at %s "
        "(per-run artifacts at %s)",
        n_runs - failures,
        n_runs,
        out_path,
        bootstrap_dir,
    )
    return 0


def cmd_run_extraction() -> int:
    """ADR-048's extraction canary (WARP-2732).

    🔴 A SEPARATE ENTRY POINT rather than a flag threaded through
    `runner.run_once`, because it is a different kind of run: RAGAS scores
    RETRIEVAL against a judge, this scores what the filing worker WROTE by
    reading the box's own Postgres afterwards. Sharing the plumbing would mean
    one of them pretending to be the other.

    Called IN-PROCESS, not shelled out. RAGAS gets a subprocess because it is
    heavy and its imports are hostile; this is a few database reads and some
    arithmetic, and a child process here bought nothing but an argv round-trip
    (which semgrep's `dangerous-subprocess-use-tainted-env-args` rule correctly
    objected to on PR #2019).

    The model is read from the environment and never inferred: the pass is
    recorded AGAINST a model, and a canary that guessed which one it measured
    would unlock auto mode for the wrong name.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent / "tests" / "extraction-eval"))
    import extraction_runner  # noqa: PLC0415 — the corpus is baked in, not a dep

    db_url = os.environ.get("DATABASE_URL", "")
    model = os.environ.get("FILING_CANARY_MODEL") or os.environ.get("LLM_MODEL") or ""
    if not db_url or not model:
        logger.error(
            "extraction canary needs DATABASE_URL and FILING_CANARY_MODEL (or LLM_MODEL) — "
            "refusing to run blind"
        )
        return extraction_runner.EXIT_CANNOT_RUN

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = Path(RESULTS_DIR) / f"extraction-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    rc = extraction_runner.run(db_url, model, out)
    logger.info("extraction canary finished rc=%s → %s", rc, out)
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(description="rag-eval service entry point")
    sub = parser.add_subparsers(dest="command")
    once = sub.add_parser("run-once", help="Run an eval once and exit")
    once.add_argument(
        "--suite",
        choices=("ragas", "extraction"),
        default="ragas",
        help=(
            "ragas (default) = the WARP-436 retrieval suite. "
            "extraction = ADR-048's filing canary, which GATES auto mode: "
            "`AutoFilingSetting` carries a CHECK refusing mode='auto' until a "
            "pass has been recorded on this box's own model (WARP-2732)."
        ),
    )
    boot = sub.add_parser(
        "bootstrap",
        help="Run RAGAS N times then aggregate into baselines.candidate.json",
    )
    boot.add_argument(
        "--runs",
        type=int,
        default=5,
        help="Number of sequential runs to aggregate (default: 5).",
    )
    # No subcommand → schedule mode (the container's default CMD).
    args = parser.parse_args()
    if args.command is None:
        return cmd_schedule()
    if args.command == "run-once":
        return cmd_run_extraction() if args.suite == "extraction" else cmd_run_once()
    if args.command == "bootstrap":
        return cmd_bootstrap(args.runs)
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
