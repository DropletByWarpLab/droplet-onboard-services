"""Unit tests for ragas_runner.py's offline-testable surface.

Covers aggregate_runs()'s quantile / IQR / floor arithmetic (WARP-521 —
follow-up from PR #299 code review) plus the RAGAS run-results-visibility
fixes: _build_search_request (service bearer token + explicit eval user so
the runner works on auth-enabled appliances), the NaN → null write
sanitizer, and the None-tolerant Markdown renderer. Does NOT require
ragas, langchain, or torch — only pandas, pyyaml, and datasets must be
installed (the same lightweight set the module imports at top-level).
"""

from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

import pandas as pd
import pytest

# Allow `import ragas_runner` without installing the package.
sys.path.insert(0, str(Path(__file__).parent))
from ragas_runner import (
    FLOOR_MARGIN,
    JudgeUnavailable,
    SearchUnavailable,
    _build_search_request,
    _check_judge_failure_streak,
    _check_search_failure_streak,
    _render_markdown,
    _sanitize_nonfinite,
    aggregate_runs,
)


# ─── helpers ────────────────────────────────────────────────────────────────

def _write_run(
    tmp_path: Path,
    name: str,
    metrics: dict,
    metrics_by_class: dict | None = None,
    n_queries: int = 20,
) -> Path:
    """Write a synthetic results-*.json file and return its path."""
    data: dict = {
        "n_queries": n_queries,
        "metrics": metrics,
        "metrics_by_class": metrics_by_class or {},
    }
    p = tmp_path / name
    p.write_text(json.dumps(data) + "\n")
    return p


def _read_out(out_path: Path) -> dict:
    return json.loads(out_path.read_text())


def _strict_loads(text: str) -> dict:
    """json.loads that REJECTS bare NaN/Infinity tokens.

    Python's json.loads accepts them by default, so a plain round-trip
    would not prove the file is strict JSON (the property the rag-eval
    service's allow_nan=False serializer depends on).
    """
    def _reject(token: str) -> None:
        raise AssertionError(f"non-JSON constant in output: {token}")

    return json.loads(text, parse_constant=_reject)


# ─── tests ──────────────────────────────────────────────────────────────────

def test_n1_iqr_zero_floor_is_p50_minus_margin(tmp_path: Path) -> None:
    """n=1: IQR must be 0.0 and the floor sits _FLOOR_MARGIN below p50.

    WARP-1407: floor used to degenerate to exactly p50 here, so the very
    next run "failed" the gate on any downward judge noise at all. The
    containment clamp caps the floor at min(samples) − margin.
    """
    _write_run(
        tmp_path,
        "results-001.json",
        metrics={"faithfulness": {"p50": 0.8, "p95": 0.9, "mean": 0.8}},
    )
    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0, "aggregate_runs should return 0 on success"
    data = _read_out(out)
    env = data["envelopes"]["faithfulness"]
    assert env["iqr"] == pytest.approx(0.0)
    assert env["floor"] == pytest.approx(0.8 - FLOOR_MARGIN)
    assert env["p50"] == pytest.approx(0.8)


def test_n5_known_means_quantile_iqr_floor(tmp_path: Path) -> None:
    """n=5 with known means: verify p50, iqr, floor via pandas-consistent math.

    Means: [0.7, 0.8, 0.85, 0.9, 0.95]
    pandas linear interpolation:
      q25 = 0.80, q50 = 0.85, q75 = 0.90, q95 = 0.94
      iqr  = 0.90 - 0.80 = 0.10
      floor = 0.85 - 1.5 * 0.10 = 0.70
    """
    means = [0.7, 0.8, 0.85, 0.9, 0.95]
    for i, m in enumerate(means, 1):
        _write_run(
            tmp_path,
            f"results-{i:03d}.json",
            metrics={"faithfulness": {"p50": m, "p95": m, "mean": m}},
        )

    # Derive expected values using the same pd.Series.quantile() so the
    # test tracks the function's actual computation, not a hand-rolled
    # approximation.
    s = pd.Series(means)
    expected_p50 = float(s.quantile(0.5))
    expected_iqr = float(s.quantile(0.75) - s.quantile(0.25))
    # WARP-1407 containment clamp: the floor is the classic p50 − 1.5·IQR
    # but never above the lowest observed sample minus the margin.
    expected_floor = min(
        expected_p50 - 1.5 * expected_iqr, min(means) - FLOOR_MARGIN
    )
    expected_p95 = float(s.quantile(0.95))

    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    env = _read_out(out)["envelopes"]["faithfulness"]

    assert env["p50"] == pytest.approx(expected_p50)
    assert env["iqr"] == pytest.approx(expected_iqr)
    assert env["floor"] == pytest.approx(expected_floor)
    assert env["p95"] == pytest.approx(expected_p95)


def test_floor_clamped_below_min_sample_on_correlated_runs(
    tmp_path: Path,
) -> None:
    """WARP-1407: correlated (back-to-back bootstrap) samples collapse the
    IQR, degenerating the classic floor to ≈p50 — observed live when the
    first independent-session run scored below a floor built from five
    same-session runs with iqr 0.006. The containment clamp guarantees the
    floor never exceeds min(samples) − FLOOR_MARGIN."""
    means = [0.40, 0.406, 0.406, 0.41, 0.43]
    for i, m in enumerate(means, 1):
        _write_run(
            tmp_path,
            f"results-{i:03d}.json",
            metrics={"faithfulness": {"p50": m, "p95": m, "mean": m}},
        )
    out = tmp_path / "baselines.json"
    assert aggregate_runs(tmp_path, out, "local") == 0
    env = _read_out(out)["envelopes"]["faithfulness"]

    s = pd.Series(means)
    classic = float(s.quantile(0.5)) - 1.5 * float(
        s.quantile(0.75) - s.quantile(0.25)
    )
    # Tight spread → the classic formula would sit ABOVE min − margin;
    # the clamp must win.
    assert classic > min(means) - FLOOR_MARGIN
    assert env["floor"] == pytest.approx(min(means) - FLOOR_MARGIN)
    # Every sample that produced the envelope clears its own floor.
    assert all(m >= env["floor"] for m in means)


def test_floor_never_negative(tmp_path: Path) -> None:
    """All-zero samples (e.g. factual_correctness on the partial fixture
    corpus) must yield floor 0.0, not −FLOOR_MARGIN — metric means live in
    [0, 1] and a negative floor would just be noise in the file."""
    for i in range(1, 4):
        _write_run(
            tmp_path,
            f"results-{i:03d}.json",
            metrics={"factual_correctness": {"p50": 0.0, "p95": 0.0, "mean": 0.0}},
        )
    out = tmp_path / "baselines.json"
    assert aggregate_runs(tmp_path, out, "local") == 0
    env = _read_out(out)["envelopes"]["factual_correctness"]
    assert env["floor"] == pytest.approx(0.0)


def test_per_class_envelopes_present_and_isolated(tmp_path: Path) -> None:
    """Per-class slices appear and don't bleed between classes."""
    shared_metrics = {
        "faithfulness": {"p50": 0.8, "p95": 0.9, "mean": 0.8},
        "llm_context_recall": {"p50": 0.7, "p95": 0.8, "mean": 0.7},
    }
    for i, (factual_mean, analytical_mean) in enumerate(
        [(0.8, 0.6), (0.9, 0.5)], 1
    ):
        _write_run(
            tmp_path,
            f"results-{i:03d}.json",
            metrics=shared_metrics,
            metrics_by_class={
                "factual": {
                    "faithfulness": {
                        "p50": factual_mean,
                        "p95": factual_mean,
                        "mean": factual_mean,
                        "n": 10,
                    }
                },
                "analytical": {
                    "faithfulness": {
                        "p50": analytical_mean,
                        "p95": analytical_mean,
                        "mean": analytical_mean,
                        "n": 5,
                    }
                },
            },
        )

    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    data = _read_out(out)

    # Both class envelopes must be present.
    by_class = data["envelopes_by_class"]
    assert "factual" in by_class, "factual class missing from envelopes_by_class"
    assert "analytical" in by_class, "analytical class missing from envelopes_by_class"

    factual_env = by_class["factual"]["faithfulness"]
    analytical_env = by_class["analytical"]["faithfulness"]

    # Factual means were [0.8, 0.9]; analytical means were [0.6, 0.5].
    # p50 for factual must be within the factual range, not the analytical range.
    assert factual_env["p50"] == pytest.approx(
        float(pd.Series([0.8, 0.9]).quantile(0.5))
    )
    assert analytical_env["p50"] == pytest.approx(
        float(pd.Series([0.6, 0.5]).quantile(0.5))
    )

    # Cross-contamination check: factual p50 must not equal analytical p50.
    assert factual_env["p50"] != pytest.approx(analytical_env["p50"])


def test_missing_class_in_some_runs(tmp_path: Path) -> None:
    """Class absent from a run contributes no sample for that run.

    Runs A and B have metrics_by_class.factual; run C has only analytical.
    factual envelope must be computed from A+B only; analytical from C only.
    """
    factual_means = [0.7, 0.9]   # runs A and B
    analytical_mean = 0.6         # run C only

    _write_run(
        tmp_path,
        "results-001.json",
        metrics={"faithfulness": {"p50": 0.7, "p95": 0.8, "mean": 0.7}},
        metrics_by_class={
            "factual": {
                "faithfulness": {"p50": 0.7, "p95": 0.8, "mean": 0.7, "n": 5}
            }
        },
    )
    _write_run(
        tmp_path,
        "results-002.json",
        metrics={"faithfulness": {"p50": 0.9, "p95": 0.95, "mean": 0.9}},
        metrics_by_class={
            "factual": {
                "faithfulness": {"p50": 0.9, "p95": 0.95, "mean": 0.9, "n": 5}
            }
        },
    )
    _write_run(
        tmp_path,
        "results-003.json",
        metrics={"faithfulness": {"p50": 0.6, "p95": 0.7, "mean": 0.6}},
        metrics_by_class={
            "analytical": {
                "faithfulness": {"p50": 0.6, "p95": 0.7, "mean": 0.6, "n": 3}
            }
        },
    )

    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    data = _read_out(out)
    by_class = data["envelopes_by_class"]

    # factual must come from runs A+B only (means [0.7, 0.9])
    expected_factual_p50 = float(pd.Series(factual_means).quantile(0.5))
    assert by_class["factual"]["faithfulness"]["p50"] == pytest.approx(
        expected_factual_p50
    ), "factual p50 should be computed from A+B only"

    # analytical must come from run C only (mean [0.6]) → iqr=0,
    # floor=p50−margin (WARP-1407 containment clamp)
    expected_analytical_p50 = analytical_mean
    assert by_class["analytical"]["faithfulness"]["p50"] == pytest.approx(
        expected_analytical_p50
    ), "analytical p50 should be computed from C only"
    assert by_class["analytical"]["faithfulness"]["iqr"] == pytest.approx(0.0), (
        "single-run analytical class must have iqr=0"
    )


def test_empty_dir_returns_1(tmp_path: Path) -> None:
    """Empty results_dir: aggregate_runs must return 1, not raise."""
    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 1, "aggregate_runs must return 1 when no results-*.json exist"


# ─── _build_search_request (auth-enabled appliance support) ─────────────────

def test_build_search_request_offline_lane_unchanged(monkeypatch) -> None:
    """Neither env var set: request is byte-for-byte the pre-fix shape.

    The AUTH_ENABLED=false offline test lane must keep working unchanged —
    same URL, same param order, no extra params, no headers.
    """
    monkeypatch.delenv("ORCHESTRATOR_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("RAGAS_EVAL_USER", raising=False)
    req = _build_search_request(
        "http://localhost:3000", "hybrid", "what is x?", 10
    )
    assert req.full_url == (
        "http://localhost:3000/api/admin/retrieval-eval/search"
        "?variant=hybrid&q=what+is+x%3F&limit=10"
    )
    assert req.headers == {}, "offline lane must send no extra headers"


def test_build_search_request_service_token_header(monkeypatch) -> None:
    """ORCHESTRATOR_SERVICE_TOKEN set: Authorization: Bearer <token>."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "svc-token-123")
    monkeypatch.delenv("RAGAS_EVAL_USER", raising=False)
    req = _build_search_request("http://orchestrator:3000", "hybrid", "q", 5)
    assert req.get_header("Authorization") == "Bearer svc-token-123"
    qs = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
    assert "user" not in qs, "user param must stay absent without RAGAS_EVAL_USER"


def test_build_search_request_eval_user_param(monkeypatch) -> None:
    """RAGAS_EVAL_USER set: user=<value> joins the query string."""
    monkeypatch.delenv("ORCHESTRATOR_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("RAGAS_EVAL_USER", "romain")
    req = _build_search_request("http://orchestrator:3000", "vector", "q", 5)
    qs = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
    assert qs["user"] == ["romain"]
    assert qs["variant"] == ["vector"]
    assert qs["limit"] == ["5"]
    assert req.headers == {}, "no Authorization header without the token env"


def test_build_search_request_both_env_vars(monkeypatch) -> None:
    """Both set (the deployed-appliance shape): header AND user param."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "svc-token-123")
    monkeypatch.setenv("RAGAS_EVAL_USER", "romain")
    req = _build_search_request("http://orchestrator:3000", "hybrid", "q", 5)
    assert req.get_header("Authorization") == "Bearer svc-token-123"
    qs = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
    assert qs["user"] == ["romain"]


def test_build_search_request_empty_env_treated_as_unset(monkeypatch) -> None:
    """Empty-string env vars behave exactly like unset (compose sets '')."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "")
    monkeypatch.setenv("RAGAS_EVAL_USER", "")
    req = _build_search_request("http://localhost:3000", "hybrid", "q", 10)
    assert req.headers == {}
    qs = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
    assert "user" not in qs


# ─── bearer resolution across the two env-file sources (WARP-1860) ─────────
#
# Compose delivers the same secret to the rag-eval container under two names:
# SERVICE_TOKEN_RAG_EVAL straight from `env_file: ../.env`, and
# ORCHESTRATOR_SERVICE_TOKEN via an `environment:` substitution that resolves
# against docker/.env instead. When the latter file lacks the key the
# substitution yields "" and — because `environment:` outranks `env_file:` —
# shadows the good value. Falling back to the unshadowed name keeps the run
# alive through that split.

def test_bearer_falls_back_to_service_token_rag_eval(monkeypatch) -> None:
    """ORCHESTRATOR_SERVICE_TOKEN blanked by substitution: use the env_file name."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "")
    monkeypatch.setenv("SERVICE_TOKEN_RAG_EVAL", "from-env-file")
    req = _build_search_request("http://orchestrator:3000", "hybrid", "q", 5)
    assert req.get_header("Authorization") == "Bearer from-env-file"


def test_bearer_prefers_orchestrator_service_token(monkeypatch) -> None:
    """Both present: the explicit per-consumer name still wins."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "explicit")
    monkeypatch.setenv("SERVICE_TOKEN_RAG_EVAL", "fallback")
    req = _build_search_request("http://orchestrator:3000", "hybrid", "q", 5)
    assert req.get_header("Authorization") == "Bearer explicit"


def test_bearer_absent_when_both_empty(monkeypatch) -> None:
    """Neither set: no header — the offline AUTH_ENABLED=false lane."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "")
    monkeypatch.setenv("SERVICE_TOKEN_RAG_EVAL", "")
    req = _build_search_request("http://localhost:3000", "hybrid", "q", 10)
    assert req.headers == {}


def test_bearer_ignores_whitespace_only_token(monkeypatch) -> None:
    """A whitespace-only value is not a credential — treat it as absent."""
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "   ")
    monkeypatch.setenv("SERVICE_TOKEN_RAG_EVAL", "real-token")
    req = _build_search_request("http://orchestrator:3000", "hybrid", "q", 5)
    assert req.get_header("Authorization") == "Bearer real-token"


# ─── retrieval circuit breaker (WARP-1860) ─────────────────────────────────
#
# A blanked service token made every search 401. The runner counted the
# failures, synthesized answers over empty context anyway, scored them all
# 0.0, and exited 0 — so 15 consecutive nightly runs each pinned the GPU for
# ~10 minutes and wrote an all-zero baseline indistinguishable from a genuine
# zero score. The breaker aborts the run instead.

def test_search_streak_below_threshold_does_not_abort() -> None:
    """A few isolated retrieval failures are normal — don't abort on them."""
    for consecutive in range(1, 3):
        _check_search_failure_streak(consecutive, "boom", threshold=3)


def test_search_streak_at_threshold_aborts() -> None:
    """Hitting the threshold raises, so main() can exit non-zero."""
    with pytest.raises(SearchUnavailable):
        _check_search_failure_streak(3, "HTTP Error 401: Unauthorized", threshold=3)


def test_search_streak_past_threshold_aborts() -> None:
    """Overshooting the threshold must abort too (>=, not ==)."""
    with pytest.raises(SearchUnavailable):
        _check_search_failure_streak(9, "HTTP Error 401: Unauthorized", threshold=3)


def test_search_streak_threshold_zero_disables_breaker() -> None:
    """threshold=0 opts out — for lanes that expect systematic failures."""
    _check_search_failure_streak(999, "boom", threshold=0)


def test_search_abort_message_names_the_cause() -> None:
    """The message must carry the underlying error and the streak length.

    run_once() surfaces this text through CalledProcessError.output into the
    durable failed record, so it has to answer "why" without docker-logs
    archaeology.
    """
    with pytest.raises(SearchUnavailable) as excinfo:
        _check_search_failure_streak(
            3, "retrieval-eval call failed for 'q': HTTP Error 401: Unauthorized",
            threshold=3,
        )
    msg = str(excinfo.value)
    assert "3" in msg, "message must state how many consecutive failures"
    assert "401" in msg, "message must carry the underlying error"


def test_search_streak_threshold_defaults_to_module_constant(monkeypatch) -> None:
    """Omitting `threshold` reads the module constant at call time.

    Resolved inside the function rather than as a default argument, which
    Python would freeze at import and make untunable.
    """
    import ragas_runner

    monkeypatch.setattr(ragas_runner, "SEARCH_ABORT_AFTER", 2)
    with pytest.raises(SearchUnavailable):
        _check_search_failure_streak(2, "boom")
    monkeypatch.setattr(ragas_runner, "SEARCH_ABORT_AFTER", 0)
    _check_search_failure_streak(50, "boom")


# ─── judge circuit breaker (WARP-1870) ─────────────────────────────────────
#
# The WARP-1860 breaker counts RETRIEVAL failures only. A broken judge is the
# mirror failure and was still silent: synthesize_answer() swallows every
# exception into a "[synthesis_error: ...]" string, the run scores that text,
# and the metrics land as 0.0/NaN in a file marked successful. That matters
# more under DMR, where the judge URL (RAGAS_OLLAMA_URL) is repointed at a
# different container — one typo and every score is meaningless.

def test_judge_streak_below_threshold_does_not_abort() -> None:
    """The odd judge blip is normal — a single failure must not abort."""
    for consecutive in range(1, 3):
        _check_judge_failure_streak(consecutive, "boom", threshold=3)


def test_judge_streak_at_threshold_aborts() -> None:
    with pytest.raises(JudgeUnavailable):
        _check_judge_failure_streak(3, "ConnectionError: [Errno 111]", threshold=3)


def test_judge_streak_threshold_zero_disables_breaker() -> None:
    _check_judge_failure_streak(999, "boom", threshold=0)


def test_judge_abort_message_names_the_cause() -> None:
    """The message must reach the durable failed record, like the search one."""
    with pytest.raises(JudgeUnavailable) as excinfo:
        _check_judge_failure_streak(
            4, "[synthesis_error: ConnectionError: refused]", threshold=3)
    msg = str(excinfo.value)
    assert "4" in msg
    assert "ConnectionError" in msg


def test_judge_breaker_is_not_a_search_breaker() -> None:
    """Distinct types: a dead judge and dead retrieval are different faults
    with different fixes, and the durable record must say which."""
    assert not issubclass(JudgeUnavailable, SearchUnavailable)
    assert not issubclass(SearchUnavailable, JudgeUnavailable)


def test_judge_streak_defaults_to_module_constant(monkeypatch) -> None:
    import ragas_runner

    monkeypatch.setattr(ragas_runner, "JUDGE_ABORT_AFTER", 2)
    with pytest.raises(JudgeUnavailable):
        _check_judge_failure_streak(2, "boom")
    monkeypatch.setattr(ragas_runner, "JUDGE_ABORT_AFTER", 0)
    _check_judge_failure_streak(50, "boom")


# ─── NaN → null write sanitizer ─────────────────────────────────────────────

def test_sanitize_nonfinite_nested() -> None:
    """NaN/±Inf floats become None recursively; everything else is untouched,
    and the result serializes under json.dumps(allow_nan=False)."""
    dirty = {
        "a": float("nan"),
        "b": {
            "c": float("inf"),
            "d": [1.0, float("-inf"), "s", None, True, 3],
        },
        "e": 0.5,
    }
    clean = _sanitize_nonfinite(dirty)
    assert clean == {
        "a": None,
        "b": {"c": None, "d": [1.0, None, "s", None, True, 3]},
        "e": 0.5,
    }
    # Regression belt: the exact serializer settings the runner writes with.
    json.dumps(clean, allow_nan=False)


# ─── aggregate_runs NaN / missing-metric tolerance ──────────────────────────

def test_aggregate_tolerates_nan_null_and_missing_metrics(tmp_path: Path) -> None:
    """One poisoned run + one metric-less run must not poison baselines.

    run 1 is a pre-sanitizer results file with bare NaN tokens (json.dumps
    allow_nan=True wrote them after judge failures; json.loads happily
    parses them back to float("nan")). run 2 carries post-sanitizer nulls.
    run 3 lacks answer_relevancy entirely (the skipped_metrics lane).
    Envelopes must come from the finite samples only, per-metric `n` must
    be honest, and the output must parse as STRICT JSON.
    """
    (tmp_path / "results-001.json").write_text(
        '{"n_queries": 20, "metrics": {'
        '"faithfulness": {"p50": NaN, "p95": NaN, "mean": NaN}, '
        '"answer_relevancy": {"p50": 0.8, "p95": 0.8, "mean": 0.8}}, '
        '"metrics_by_class": {'
        '"factual": {"faithfulness": {"p50": NaN, "p95": NaN, "mean": NaN, "n": 5}}}}'
    )
    _write_run(
        tmp_path,
        "results-002.json",
        metrics={
            "faithfulness": {"p50": 0.7, "p95": 0.7, "mean": 0.7},
            "answer_relevancy": {"p50": None, "p95": None, "mean": None},
        },
        metrics_by_class={
            "factual": {
                "faithfulness": {"p50": 0.7, "p95": 0.7, "mean": 0.7, "n": 5}
            }
        },
    )
    _write_run(
        tmp_path,
        "results-003.json",
        metrics={"faithfulness": {"p50": 0.9, "p95": 0.9, "mean": 0.9}},
    )

    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    data = _strict_loads(out.read_text())  # raises on any bare NaN token

    # faithfulness: run-1 NaN skipped → samples [0.7, 0.9], honest n=2.
    faith = data["envelopes"]["faithfulness"]
    assert faith["p50"] == pytest.approx(
        float(pd.Series([0.7, 0.9]).quantile(0.5))
    )
    assert faith["n"] == 2

    # answer_relevancy: run-2 null and run-3 absence both skipped →
    # single sample 0.8 from run 1 → iqr=0, floor=p50−margin (WARP-1407
    # containment clamp), honest n=1.
    ar = data["envelopes"]["answer_relevancy"]
    assert ar["p50"] == pytest.approx(0.8)
    assert ar["iqr"] == pytest.approx(0.0)
    assert ar["floor"] == pytest.approx(0.8 - FLOOR_MARGIN)
    assert ar["n"] == 1

    # Per-class path filters the same way: run-1's NaN factual sample is
    # skipped, leaving run-2's 0.7 as the sole sample.
    factual = data["envelopes_by_class"]["factual"]["faithfulness"]
    assert factual["p50"] == pytest.approx(0.7)
    assert factual["n"] == 1


def test_aggregate_all_invalid_metric_omitted(tmp_path: Path) -> None:
    """A metric whose every sample is NaN/null yields NO envelope at all —
    explicit absence, not an envelope full of nulls."""
    (tmp_path / "results-001.json").write_text(
        '{"n_queries": 20, "metrics": {'
        '"faithfulness": {"p50": 0.8, "p95": 0.8, "mean": 0.8}, '
        '"answer_relevancy": {"p50": NaN, "p95": NaN, "mean": NaN}}, '
        '"metrics_by_class": {}}'
    )
    _write_run(
        tmp_path,
        "results-002.json",
        metrics={
            "faithfulness": {"p50": 0.9, "p95": 0.9, "mean": 0.9},
            "answer_relevancy": {"p50": None, "p95": None, "mean": None},
        },
    )
    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    data = _strict_loads(out.read_text())
    assert "faithfulness" in data["envelopes"]
    assert "answer_relevancy" not in data["envelopes"]


# ─── Markdown renderer None tolerance ───────────────────────────────────────

def test_render_markdown_tolerates_none_stats() -> None:
    """Sanitized summaries can carry None stats (judge failures → NaN →
    null); the table must render n/a, not crash on the `:.3f` specifier."""
    summary = {
        "variant": "hybrid",
        "limit": 10,
        "judge": "local",
        "n_queries": 20,
        "metrics": {
            "faithfulness": {"p50": 0.8, "p95": 0.9, "mean": 0.85},
            "answer_relevancy": {"p50": None, "p95": None, "mean": None},
        },
    }
    md = _render_markdown(summary)
    assert "variant=hybrid limit=10 judge=local" in md
    assert "Queries: 20" in md
    assert "| faithfulness | 0.800 | 0.900 | 0.850 |" in md
    assert "| answer_relevancy | n/a | n/a | n/a |" in md
