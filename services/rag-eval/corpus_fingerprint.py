"""WARP-1868 — run the eval only when the corpus actually changed.

A healthy RAGAS pass pins the discrete GPU at 98-100% for ~10 minutes, and the
scheduler fires it eight times a night on a cron whether or not a single file
was indexed. On a quiet week that is ~56 GPU-hours re-measuring an identical
corpus. The load is not reducible — inference saturates the card by design, and
capping ragas' concurrency only lengthens the run — so the only lever is
whether the run happens at all.

This module answers one question: has the corpus moved since the last run we
actually completed?

Three deliberate choices:

  - FAIL OPEN. If the fingerprint cannot be read — orchestrator down, 401,
    malformed body, endpoint absent on an older build — we RUN. Skipping on an
    unreadable fingerprint would silently stop measuring retrieval quality,
    which is the exact failure class this area keeps producing (WARP-1860 ran
    15 nightly evals that scored nothing while reporting success). A wasted
    GPU-hour is recoverable; months of unnoticed silence is not.

  - The stored value is OPAQUE. The orchestrator composes it, so the two
    surfaces cannot disagree on the arithmetic, and a future change to what
    counts as "changed" (adding a per-source breakdown, say) needs no matching
    client change — an unrecognised string simply compares unequal and the run
    happens.

  - Persisted BESIDE the run records, not in memory. The container restarts on
    every deploy and the whole point is to skip across restarts.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from config import ORCHESTRATOR_URL, RESULTS_DIR

logger = logging.getLogger("rag-eval.corpus")

# Where the last COMPLETED run's fingerprint lives. Beside the run records so
# it shares their bind-mounted volume and survives a container replace.
FINGERPRINT_PATH = RESULTS_DIR / "corpus-fingerprint.json"

# Bounded: this runs on a cron ahead of a ~10-minute job, so a slow answer must
# not wedge the scheduler. On timeout we fail open and run.
FETCH_TIMEOUT_SEC = float(os.environ.get("RAG_EVAL_FINGERPRINT_TIMEOUT_SEC", "10"))

# Escape hatch: force every scheduled run regardless of the corpus. For
# bisecting judge/model changes, where the corpus is deliberately constant and
# skipping would defeat the exercise.
GATE_DISABLED = os.environ.get("RAG_EVAL_CORPUS_GATE_DISABLED", "0") == "1"


def _bearer() -> str:
    """The service bearer, from whichever env name carries it.

    Same fallback chain as ragas_runner._resolve_bearer, and for the same
    reason (WARP-1860): compose delivers this secret under two names, and the
    `environment:` substitution can blank one of them while `env_file` leaves
    the other intact.
    """
    for name in ("ORCHESTRATOR_SERVICE_TOKEN", "SERVICE_TOKEN_RAG_EVAL"):
        tok = (os.environ.get(name) or "").strip()
        if tok:
            return tok
    return ""


def fetch_fingerprint() -> Optional[str]:
    """Current corpus fingerprint, or None if it could not be determined.

    None means "unknown", never "unchanged" — callers must treat it as a
    reason to run.
    """
    eval_user = (os.environ.get("RAGAS_EVAL_USER") or "").strip()
    params = f"?user={urllib.parse.quote(eval_user)}" if eval_user else ""
    url = f"{ORCHESTRATOR_URL}/api/admin/retrieval-eval/corpus-fingerprint{params}"

    req = urllib.request.Request(url)
    token = _bearer()
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SEC) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # 404 on an orchestrator that predates this endpoint is expected
        # during a rolling deploy, and is not worth an error-level log.
        level = logging.INFO if e.code == 404 else logging.WARNING
        logger.log(level, "corpus fingerprint unavailable (HTTP %s) — will run", e.code)
        return None
    except Exception as e:                                       # noqa: BLE001
        logger.warning("corpus fingerprint unreadable (%s) — will run", e)
        return None

    fp = body.get("fingerprint")
    if not isinstance(fp, str) or not fp:
        logger.warning("corpus fingerprint malformed (%r) — will run", body)
        return None
    logger.info(
        "corpus fingerprint: %s (chunks=%s latest=%s)",
        fp, body.get("chunks"), body.get("latestIndexedAt"),
    )
    return fp


def load_last() -> Optional[str]:
    """Fingerprint recorded by the last completed run, or None."""
    try:
        data = json.loads(Path(FINGERPRINT_PATH).read_text())
        fp = data.get("fingerprint")
        return fp if isinstance(fp, str) and fp else None
    except FileNotFoundError:
        return None
    except Exception:                                            # noqa: BLE001
        logger.warning("stored fingerprint unreadable — treating as absent", exc_info=True)
        return None


def save(fingerprint: str, run_id: str) -> None:
    """Record the fingerprint a run was measured against.

    Called only AFTER a run completes, never before: storing it up front would
    make a crashed or aborted run look measured, and the next tick would skip a
    corpus nothing has actually scored.
    """
    if not fingerprint:
        return
    try:
        FINGERPRINT_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = FINGERPRINT_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fingerprint": fingerprint, "runId": run_id}) + "\n")
        # Atomic-ish: a half-written file would otherwise read as a corrupt
        # fingerprint and force a run every night thereafter.
        tmp.replace(FINGERPRINT_PATH)
    except Exception:                                            # noqa: BLE001
        logger.warning("could not persist corpus fingerprint", exc_info=True)


def should_run(current: Optional[str], last: Optional[str]) -> tuple[bool, str]:
    """(run?, reason). Pure — the decision, separated from the I/O above so it
    can be exercised without a network or a filesystem."""
    if GATE_DISABLED:
        return True, "corpus gate disabled (RAG_EVAL_CORPUS_GATE_DISABLED=1)"
    if current is None:
        return True, "corpus fingerprint unavailable — running rather than assuming unchanged"
    if last is None:
        return True, "no previous fingerprint — first gated run"
    if current != last:
        return True, f"corpus changed ({last} -> {current})"
    return False, f"corpus unchanged since the last run ({current})"
