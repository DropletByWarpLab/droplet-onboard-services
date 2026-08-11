"""WARP-1868 — the eval runs only when the corpus moved.

A healthy RAGAS pass pins the discrete GPU at 98-100% for ~10 minutes and the
cron fires it eight times a night regardless of whether anything was indexed.
On a quiet week that is ~56 GPU-hours re-measuring an identical corpus.

The decision function is deliberately pure and separated from the HTTP and
filesystem I/O around it, so the interesting cases are testable without a
network, a container, or a GPU. The failure that matters most is the SILENT
one — skipping when we could not actually tell — so most of these pin the
fail-open direction.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import corpus_fingerprint as cf


# ─── the decision ───────────────────────────────────────────────────────────

def test_unchanged_corpus_skips() -> None:
    """The whole point: identical fingerprint, no GPU work."""
    run, reason = cf.should_run("v1:100:2026-08-11T00:00:00.000Z",
                                "v1:100:2026-08-11T00:00:00.000Z")
    assert run is False
    assert "unchanged" in reason


def test_changed_corpus_runs() -> None:
    run, reason = cf.should_run("v1:101:2026-08-11T01:00:00.000Z",
                                "v1:100:2026-08-11T00:00:00.000Z")
    assert run is True
    assert "changed" in reason


def test_edit_with_identical_count_still_runs() -> None:
    """Re-indexing a file leaves the chunk count identical and moves only the
    timestamp. Counting alone would skip a corpus that genuinely changed."""
    run, _ = cf.should_run("v1:100:2026-08-11T09:00:00.000Z",
                           "v1:100:2026-08-11T00:00:00.000Z")
    assert run is True


def test_first_ever_run_has_no_baseline_and_runs() -> None:
    run, reason = cf.should_run("v1:100:2026-08-11T00:00:00.000Z", None)
    assert run is True
    assert "first" in reason


def test_unavailable_fingerprint_runs() -> None:
    """FAIL OPEN. Skipping on an unreadable fingerprint would silently stop
    measuring retrieval quality — the exact failure class WARP-1860 produced,
    where 15 nightly runs scored nothing and reported success."""
    run, reason = cf.should_run(None, "v1:100:2026-08-11T00:00:00.000Z")
    assert run is True
    assert "unavailable" in reason


def test_unavailable_beats_a_matching_stale_value() -> None:
    """None must never compare equal to a stored value, even by accident."""
    run, _ = cf.should_run(None, None)
    assert run is True


def test_gate_can_be_disabled(monkeypatch) -> None:
    """Bisecting a judge/model change needs the corpus held constant and the
    run to happen anyway."""
    monkeypatch.setattr(cf, "GATE_DISABLED", True)
    run, reason = cf.should_run("v1:100:same", "v1:100:same")
    assert run is True
    assert "disabled" in reason


def test_unrecognised_fingerprint_shape_is_simply_unequal() -> None:
    """The stored value is opaque on purpose: a future server-side change to
    what counts as 'changed' must not need a matching client change. An
    unfamiliar string compares unequal and the run happens."""
    run, _ = cf.should_run("v2:100:abc:extra", "v1:100:abc")
    assert run is True


# ─── persistence ────────────────────────────────────────────────────────────

def test_save_then_load_round_trips(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(cf, "FINGERPRINT_PATH", tmp_path / "corpus-fingerprint.json")
    cf.save("v1:42:2026-08-11T00:00:00.000Z", "20260811T000000Z")
    assert cf.load_last() == "v1:42:2026-08-11T00:00:00.000Z"


def test_load_with_no_file_is_none_not_an_error(tmp_path, monkeypatch) -> None:
    """A fresh box has never run — that is 'no baseline', not a fault."""
    monkeypatch.setattr(cf, "FINGERPRINT_PATH", tmp_path / "absent.json")
    assert cf.load_last() is None


def test_corrupt_stored_fingerprint_reads_as_absent(tmp_path, monkeypatch) -> None:
    """Absent beats wrong: it forces a run rather than skipping forever on a
    value nothing can parse."""
    p = tmp_path / "corpus-fingerprint.json"
    p.write_text("{not json")
    monkeypatch.setattr(cf, "FINGERPRINT_PATH", p)
    assert cf.load_last() is None
    assert cf.should_run("v1:1:x", cf.load_last())[0] is True


def test_save_is_atomic_and_leaves_no_temp_behind(tmp_path, monkeypatch) -> None:
    """A half-written file would read as corrupt and force a run every night
    thereafter."""
    target = tmp_path / "corpus-fingerprint.json"
    monkeypatch.setattr(cf, "FINGERPRINT_PATH", target)
    cf.save("v1:7:x", "run-1")
    assert json.loads(target.read_text())["fingerprint"] == "v1:7:x"
    assert list(tmp_path.glob("*.tmp")) == []


def test_save_ignores_an_empty_fingerprint(tmp_path, monkeypatch) -> None:
    """Persisting "" would make the next comparison match nothing and skip."""
    target = tmp_path / "corpus-fingerprint.json"
    monkeypatch.setattr(cf, "FINGERPRINT_PATH", target)
    cf.save("", "run-1")
    assert not target.exists()


# ─── fetch ──────────────────────────────────────────────────────────────────

def test_fetch_returns_none_when_the_endpoint_is_absent(monkeypatch) -> None:
    """A rolling deploy can leave an orchestrator that predates this endpoint.
    404 is expected, not alarming — and must fail open."""
    import urllib.error

    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 404, "nf", {}, None)

    monkeypatch.setattr(cf.urllib.request, "urlopen", boom)
    assert cf.fetch_fingerprint() is None


def test_fetch_returns_none_on_a_malformed_body(monkeypatch) -> None:
    class R:
        def read(self): return b'{"chunks": 5}'          # no fingerprint field
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(cf.urllib.request, "urlopen", lambda *a, **k: R())
    assert cf.fetch_fingerprint() is None


def test_fetch_returns_the_fingerprint(monkeypatch) -> None:
    class R:
        def read(self):
            return json.dumps({"fingerprint": "v1:9:t", "chunks": 9,
                               "latestIndexedAt": "t"}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(cf.urllib.request, "urlopen", lambda *a, **k: R())
    assert cf.fetch_fingerprint() == "v1:9:t"


def test_fetch_sends_the_bearer_and_the_eval_user(monkeypatch) -> None:
    """The service principal owns no corpus, so ?user= is mandatory — and the
    bearer must survive the WARP-1860 env-name split."""
    seen = {}

    class R:
        def read(self): return json.dumps({"fingerprint": "v1:1:x"}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, *a, **k):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        return R()

    monkeypatch.delenv("ORCHESTRATOR_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("SERVICE_TOKEN_RAG_EVAL", "fallback-tok")
    monkeypatch.setenv("RAGAS_EVAL_USER", "eval-fixtures")
    monkeypatch.setattr(cf.urllib.request, "urlopen", fake_urlopen)

    assert cf.fetch_fingerprint() == "v1:1:x"
    assert "user=eval-fixtures" in seen["url"]
    assert seen["auth"] == "Bearer fallback-tok"
