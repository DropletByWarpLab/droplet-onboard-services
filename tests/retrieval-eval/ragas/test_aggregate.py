"""Unit tests for aggregate_runs() in ragas_runner.py.

Tests the quantile / IQR / floor arithmetic so regressions are caught
before they silently corrupt baselines.json. Does NOT require ragas,
langchain, or torch — only pandas, pyyaml, and datasets must be installed
(the same lightweight set the module imports at top-level).

WARP-521 — follow-up from PR #299 code review.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

# Allow `import ragas_runner` without installing the package.
sys.path.insert(0, str(Path(__file__).parent))
from ragas_runner import aggregate_runs


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


# ─── tests ──────────────────────────────────────────────────────────────────

def test_n1_iqr_zero_floor_equals_p50(tmp_path: Path) -> None:
    """n=1: IQR must be 0.0, floor must equal p50."""
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
    assert env["floor"] == pytest.approx(env["p50"])
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
    expected_floor = expected_p50 - 1.5 * expected_iqr
    expected_p95 = float(s.quantile(0.95))

    out = tmp_path / "baselines.json"
    rc = aggregate_runs(tmp_path, out, "local")
    assert rc == 0
    env = _read_out(out)["envelopes"]["faithfulness"]

    assert env["p50"] == pytest.approx(expected_p50)
    assert env["iqr"] == pytest.approx(expected_iqr)
    assert env["floor"] == pytest.approx(expected_floor)
    assert env["p95"] == pytest.approx(expected_p95)


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

    # analytical must come from run C only (mean [0.6]) → iqr=0, floor=p50
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
