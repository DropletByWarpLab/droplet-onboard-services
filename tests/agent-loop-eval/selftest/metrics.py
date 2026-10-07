#!/usr/bin/env python3
"""WARP-3899 selftest: per-run metrics, labels, Wilson intervals, --compare, --history, --flake-report, --baseline-out.

Reads what selftest.sh already produced (runs/selftest-{good,bad}.jsonl and .eval.json, runs/selftest-metrics.jsonl and
.eval.json) and drives evaluate.py's main() in-process. No model. Run from tests/agent-loop-eval by selftest.sh.
"""
import contextlib
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # run as a script, sys.path[0] is selftest/, not the harness dir
import evaluate as ev

RUNS = ROOT / "runs"
# selftest.sh's CASES: the files the good and bad runs were scored against.
CASES = [str(ROOT / p) for p in ("cases/regression/droplet_core.jsonl", "cases/regression/droplet_adversarial.jsonl",
                                 "cases/droplet_delegation.jsonl", "cases/droplet_claims.jsonl",
                                 "selftest/gate_cases.jsonl", "selftest/v2_cases.jsonl")]
GOOD, BAD = str(RUNS / "selftest-good.jsonl"), str(RUNS / "selftest-bad.jsonl")


def cli(*argv):
    """evaluate.py's main() with this argv; its stdout. Exit 1 is the hard-gate verdict, anything else is an error."""
    out, old = io.StringIO(), sys.argv
    sys.argv = ["evaluate.py", *map(str, argv)]
    try:
        with contextlib.redirect_stdout(out):
            try:
                ev.main()
            except SystemExit as e:
                if e.code not in (None, 0, 1):
                    raise
    finally:
        sys.argv = old
    return out.getvalue()


# --- Wilson: hand-worked values (z = 1.96).
assert ev.wilson(0, 10) == [0.0, 0.278], ev.wilson(0, 10)
assert ev.wilson(10, 10) == [0.722, 1.0], ev.wilson(10, 10)
assert ev.wilson(7, 10) == [0.397, 0.892], ev.wilson(7, 10)
assert ev.wilson(0, 0) == [0.0, 1.0]
# --- exact two-sided sign test on discordant pairs
assert ev.sign_test_p(0, 0) == 1.0 and ev.sign_test_p(3, 3) == 1.0
assert ev.sign_test_p(5, 0) == 0.0625 and ev.sign_test_p(0, 6) == 0.03125   # 2/32, 2/64
assert ev.sign_test_p(1, 4) == 0.375 and ev.sign_test_p(8, 2) == 0.109375   # 12/32, 112/1024
print("ok  statistics: wilson(0,10), wilson(10,10), wilson(7,10) and the sign test match the hand-worked values")

# --- labels and metrics, off the records of the three metrics cases
recs = {r["case_id"]: r for r in map(json.loads, open(RUNS / "selftest-metrics.jsonl"))}
data = json.load(open(RUNS / "selftest-metrics.eval.json"))
res, summary = {r["case_id"]: r for r in data["results"]}, data["summary"]

rec = recs["met-unscripted"]
assert [d["outcome"] for d in rec["dispatches"]] == ["unscripted"], rec["dispatches"]
assert not res["met-unscripted"]["pass"] and res["met-unscripted"]["labels"] == ["harness_unscripted:get_drive_health"], res["met-unscripted"]
assert summary["unscripted_by_tool"] == {"get_drive_health": 1}, summary["unscripted_by_tool"]

rec = recs["met-selection"]
assert rec["gwCalls"] and all("tool_names" in g for g in rec["gwCalls"]), rec["gwCalls"]
assert not any("list_reminders" in g["tool_names"] for g in rec["gwCalls"]), "list_reminders was offered: the case proves nothing"
assert not res["met-selection"]["pass"] and res["met-selection"]["labels"] == ["selection_miss:list_reminders"], res["met-selection"]

rec, m = recs["met-budget"], res["met-budget"]["metrics"]
assert "max_iterations 2>1" in res["met-budget"]["fails"] and res["met-budget"]["labels"] == [], res["met-budget"]
assert m["iterations"] == 2 and m["prompt_tokens_max"] > 0 and m["tools_advertised_max"] >= 5, m
assert m["prompt_budget_pressure"] and m["prompt_budget_pressure"] > 0, m
assert rec["context_window"] > 0 and all(g["prompt_tokens_est"] > 0 and "completion_tokens_est" in g for g in rec["gwCalls"]), rec["gwCalls"]
# harness gaps explain two failures; the third (the budget) is the product's own
assert summary["labels"] == {"harness_unscripted:get_drive_health": 1, "selection_miss:list_reminders": 1}, summary["labels"]
assert summary["fails_excluding_harness"] == 1 and summary["pass_rate"] == 0.0 and summary["step_limit_hits"] == 0, summary
assert summary["metrics_p50"]["iterations"] >= 1 and summary["pass_rate_ci95"][0] == 0.0, summary
print("ok  labels and metrics: unscripted, selection_miss and the iteration budget, off the scripted records")

# A record from before WARP-3899 (no tool_names, no context_window) scores as before: same fails, no label, no error.
cases = {c["id"]: c for c in ev.load_jsonl(ROOT / "selftest/metrics_cases.jsonl")}
write_tools = json.loads(ev.WRITE_TOOLS_FILE.read_text())
old = {k: v for k, v in recs["met-selection"].items() if k != "context_window"}
old["gwCalls"] = [{k: v for k, v in g.items() if k != "tool_names"} for g in old["gwCalls"]]
before = ev.evaluate(cases["met-selection"], old, write_tools)
assert before["fails"] == res["met-selection"]["fails"] and before["labels"] == [], before
assert before["metrics"]["prompt_budget_pressure"] is None, before["metrics"]
bare = {k: v for k, v in old.items() if k not in ("gwCalls", "calls")}
assert ev.evaluate(cases["met-selection"], bare, write_tools)["metrics"]["prompt_tokens_max"] is None
print("ok  old records: no tool_names or context_window means no label, no pressure, same verdict")

# --- --compare: good passes every shared case, bad fails them all
cmp_ = json.loads(cli("--compare", GOOD, BAD, "--cases", *CASES))
assert "seed-001" in cmp_["regressions"] and cmp_["improvements"] == [] and cmp_["both_pass"] == 0, cmp_
assert cmp_["cases"] >= 6 and cmp_["sign_test_p"] < 0.05, cmp_
assert set(cmp_["cost_delta"]) == set(ev.COST_KEYS) and set(cmp_["tokens_per_passed_case"]) == {"A", "B"}, cmp_
print(f"ok  compare: {len(cmp_['regressions'])} regressions of {cmp_['cases']} shared cases, sign test p={cmp_['sign_test_p']}")

# --- --history, --flake-report, --baseline-out
hist, base = RUNS / "selftest-history.jsonl", RUNS / "selftest-baseline.json"
hist.unlink(missing_ok=True)
for label, run in (("good", GOOD), ("bad", BAD)):
    cli(run, "--json", "--cases", *CASES, "--history", hist, "--label", label, "--sha7", "abc1234")
lines = ev.load_jsonl(hist)
assert {x["label"] for x in lines} == {"good", "bad"} and all(x["sha7"] == "abc1234" and x["k"] == 1 for x in lines), lines[:2]
flake = json.loads(cli("--flake-report", "--history", hist, "--last", 2))
assert len(flake["runs_considered"]) == 2 and flake["cases"]["seed-001"] == 0.5, flake["cases"].get("seed-001")
assert "seed-001" in flake["quarantine_candidates"], flake["quarantine_candidates"]
last = json.loads(cli("--flake-report", "--history", hist, "--last", 1))   # the bad run alone: always failing, not flaky
assert last["cases"]["seed-001"] == 0.0 and "seed-001" not in last["quarantine_candidates"], last
base.unlink(missing_ok=True)
cli(GOOD, "--json", "--cases", *CASES, "--baseline-out", base)
b = json.load(open(base))
assert "pass_all_repeats_ci95" in b and "results" not in b and b["pass_rate"] == 1.0 and b["pass_rate_ci95"][1] == 1.0, b
print("ok  history, flake report and baseline: one line per case, seed-001 flaky at 0.5, summary-only baseline")
