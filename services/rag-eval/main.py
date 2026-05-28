"""WARP-RAG-EVAL — rag-eval service entry point.

CLI:
  python main.py                     → schedule mode: blocks forever,
                                       firing the RAGAS run hourly during
                                       the off-hours window from config.
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

The scheduler is BlockingScheduler — once `.start()` is called the
process is "waiting on the next cron tick" until SIGINT/SIGTERM. We
register a clean shutdown handler so the running job (if any) finishes
before exit (apscheduler `wait=True`).
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from pathlib import Path

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("rag-eval")

import runner
import scheduler_service
from config import DISABLED, RESULTS_DIR


def cmd_schedule() -> int:
    if DISABLED:
        logger.info("RAG_EVAL_DISABLED=1 — exiting without starting scheduler")
        # Sleep instead of exit so the container stays alive (compose
        # restart-on-exit policies would loop us otherwise). The scheduler
        # is intentionally inert; ops can `docker exec` for ad-hoc runs.
        signal.pause()
        return 0

    sched = scheduler_service.build_scheduler()

    def _on_signal(signum: int, _frame: object) -> None:
        logger.info("received signal %d — shutting scheduler down", signum)
        sched.shutdown(wait=True)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    logger.info("starting BlockingScheduler — Ctrl-C or SIGTERM to exit")
    try:
        sched.start()  # blocks until shutdown
    except (KeyboardInterrupt, SystemExit):
        sched.shutdown(wait=True)
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
    logger.info("bootstrap: running RAGAS %d× then aggregating", n_runs)
    failures = 0
    for i in range(1, n_runs + 1):
        logger.info("bootstrap run %d / %d", i, n_runs)
        try:
            runner.run_once()
        except Exception:
            failures += 1
            logger.exception("bootstrap run %d failed", i)
    if failures == n_runs:
        logger.error("all %d bootstrap runs failed; not aggregating", n_runs)
        return 1
    out_path = RESULTS_DIR / "baselines.candidate.json"
    try:
        runner.aggregate_to_baselines(out_path)
    except Exception:
        logger.exception("aggregate step failed")
        return 1
    logger.info(
        "bootstrap complete — %d/%d runs successful, baselines at %s",
        n_runs - failures,
        n_runs,
        out_path,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="rag-eval service entry point")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run-once", help="Run RAGAS once and exit")
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
        return cmd_run_once()
    if args.command == "bootstrap":
        return cmd_bootstrap(args.runs)
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
