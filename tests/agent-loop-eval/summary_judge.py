#!/usr/bin/env python3
"""WARP-3305: summary-quality check for chat-started background runs.

Reads AgentRun rows exported from a box (JSON list of {id, goal, deliverable,
summary, trace}) and asks ONE judge prompt per run whether the summary the
chat will read is faithful to what the run actually found, complete against
the deliverable, and brief. Brevity's hard limit (2,000 characters, the
server cap) is checked in code, not by the judge.

  python3 summary_judge.py runs/agent-runs.json                 # first 20 rows
  python3 summary_judge.py runs/agent-runs.json --only <run id> # one at a time
  python3 summary_judge.py --demo                               # parser self-check, no model

The judge is any Ollama model (OLLAMA_URL, default http://127.0.0.1:11434).
One call per run, sequential, so it stays within a laptop's memory.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

SUMMARY_CAP = 2000
TRACE_BUDGET = 12000  # characters of tool evidence shown to the judge (16k window)
PASS = {"faithfulness": 4, "completeness": 3, "brevity": 3}

PROMPT = """You grade the summary a background task wrote for a chat assistant with a very small context.

Task goal: {goal}
Deliverable asked for: {deliverable}

Evidence the task gathered (tool calls and results, possibly truncated):
{evidence}

Summary written for the chat:
{summary}

Score each 1-5:
- faithfulness: every claim in the summary is supported by the evidence (5 = nothing unsupported)
- completeness: the summary gives what the deliverable asked for, or says clearly what is missing
- brevity: no filler; a reader gets the answer in one read
Reply with JSON only: {{"faithfulness": n, "completeness": n, "brevity": n, "unsupported": ["claim", ...]}}"""


def evidence(trace):
    # Tool calls and their results, newest last; cut from the front so the
    # end of the run (usually the findings) survives the budget.
    text = "\n".join(json.dumps(t, ensure_ascii=False)[:1500] for t in (trace or []))
    return text[-TRACE_BUDGET:]


def parse_scores(reply):
    m = re.search(r"\{.*\}", reply, re.S)
    if not m:
        raise ValueError(f"judge reply has no JSON: {reply[:200]!r}")
    d = json.loads(m.group(0))
    return {k: int(d[k]) for k in PASS} | {"unsupported": d.get("unsupported", [])}


def verdict(row, scores):
    fails = [f"{k} {scores[k]}<{v}" for k, v in PASS.items() if scores[k] < v]
    n = len(row.get("summary") or "")
    if n > SUMMARY_CAP:
        fails.append(f"length {n}>{SUMMARY_CAP}")
    if not (row.get("summary") or "").strip():
        fails.append("blank summary")
    return fails


def judge(row, model, url):
    body = json.dumps({"model": model, "stream": False, "format": "json", "options": {"temperature": 0},
                       "messages": [{"role": "user", "content": PROMPT.format(
                           goal=row.get("goal", ""), deliverable=row.get("deliverable") or "(none given)",
                           evidence=evidence(row.get("trace")), summary=row.get("summary") or "")}]}).encode()
    req = urllib.request.Request(f"{url}/api/chat", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return parse_scores(json.load(r)["message"]["content"])


def demo():
    s = parse_scores('sure: {"faithfulness": 5, "completeness": 2, "brevity": 4, "unsupported": []}')
    assert verdict({"summary": "ok"}, s) == ["completeness 2<3"]
    assert verdict({"summary": "x" * 2001}, s | {"completeness": 5}) == ["length 2001>2000"]
    assert verdict({"summary": " "}, s | {"completeness": 5}) == ["blank summary"]
    assert len(evidence([{"t": "a" * 5000}] * 20)) == TRACE_BUDGET
    print("demo ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export", nargs="?")
    ap.add_argument("--only", help="run id to judge alone")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--model", default="gpt-oss:20b")
    ap.add_argument("--demo", action="store_true")
    a = ap.parse_args()
    if a.demo:
        return demo()
    if not a.export:
        ap.error("export file required")
    rows = json.load(open(a.export))
    rows = [r for r in rows if r.get("id") == a.only] if a.only else rows[: a.limit]
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    passed = 0
    for r in rows:
        try:
            s = judge(r, a.model, url)
            fails = verdict(r, s)
        except Exception as e:  # one bad reply must not lose the other 19
            s, fails = {}, [f"judge_error {e}"]
        passed += not fails
        print(json.dumps({"id": r.get("id"), "pass": not fails, "fails": fails, **s}, ensure_ascii=False))
    print(f"{passed}/{len(rows)} summaries pass", file=sys.stderr)
    sys.exit(0 if rows and passed == len(rows) else 1)


if __name__ == "__main__":
    main()
