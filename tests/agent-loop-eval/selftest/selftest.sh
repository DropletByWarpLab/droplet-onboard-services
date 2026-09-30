#!/usr/bin/env bash
# Proves the harness + evaluator: scripted good/bad agents through the REAL
# loop, interceptor and approval store; each case's verdict AND exact hard-gate
# list must match expected.json. No model, seconds. `npm run
# eval:agent-loop:selftest`; CI runs it on the orchestrator leg. Also checks the
# committed cases match build_cases.py, the summary judge's parser, that only a
# gateway 429 is retried, that an outage aborts the run, and that the clock
# tool, the prompt's date and {{today+N}} agree.
# gate_cases.jsonl isolates H2 and H3: the product's guards keep every
# regression case from executing a duplicate or forbidden write.
set -euo pipefail
cd "$(dirname "$0")/.."
ORCH=${ORCH:-$(cd ../../apps/orchestrator && pwd)}
# tsx is the orchestrator workspace's (nested today; the root is the fallback).
export PATH="$ORCH/node_modules/.bin:$ORCH/../../node_modules/.bin:$PATH" ORCH AGENT_EVAL_RETRY_WAIT_MS=0
CASES=(cases/regression/droplet_core.jsonl cases/regression/droplet_adversarial.jsonl cases/droplet_delegation.jsonl selftest/gate_cases.jsonl)
python3 build_cases.py --check
python3 summary_judge.py --demo
mkdir -p runs
fails=0
for kind in good bad; do
  ids=$(python3 -c "import json;print(','.join(json.load(open('selftest/expected.json'))['$kind']))")
  env -u NODE_OPTIONS tsx run.mts --fake selftest/$kind.json "${CASES[@]/#/--cases=}" --only "$ids" --out runs/selftest-$kind.jsonl >/dev/null 2>runs/selftest-$kind.log || { cat runs/selftest-$kind.log; exit 1; }
  python3 evaluate.py runs/selftest-$kind.jsonl --json --cases "${CASES[@]}" > runs/selftest-$kind.eval.json || true
  python3 - "$kind" <<'PY' || fails=1
import json, sys
kind = sys.argv[1]
want = json.load(open("selftest/expected.json"))[kind]
res = json.load(open(f"runs/selftest-{kind}.eval.json"))["results"]
bad = 0
for r in res:
    got = ["PASS" if r["pass"] else ("HARD" if r["hard"] else "fail"), r["hard"]]
    ok = got == want[r["case_id"]]
    bad += not ok
    print(f"{'ok ' if ok else 'XX '} {kind:4} {r['case_id']:9} want={want[r['case_id']]} got={got} {r['fails']}")
missing = set(want) - {r["case_id"] for r in res}
for m in missing: print(f"XX  {kind:4} {m} missing"); bad += 1
sys.exit(1 if bad else 0)
PY
done
python3 - <<'PY' || fails=1
import datetime, json
recs = {k: {r["case_id"]: r for r in map(json.loads, open(f"runs/selftest-{k}.jsonl"))} for k in ("good", "bad")}
# Only a 429 is retried (and resumed); a 5xx is recorded as the failure it is.
r429, r5xx = recs["good"]["seed-029"], recs["bad"]["seed-030"]
assert r429["attempts"] == 2 and "429" in r429["retry_errors"][0], r429.get("retry_errors")
assert r5xx["attempts"] == 1 and "502" in r5xx["harness_error"], r5xx.get("attempts")
# The clock tool's day, the prompt's day and {{today+3}} agree.
r = recs["good"]["seed-004"]
iso = next(s["result"]["iso"] for s in r["steps"] if s.get("type") == "tool_result" and "iso" in (s.get("result") or {}))
plus3 = (datetime.date.fromisoformat(r["today"]) + datetime.timedelta(days=3)).isoformat()
assert iso[:10] == r["today"] and plus3 in r["turns_asked"][0], (iso, r["today"], r["turns_asked"])
print("ok  retry: 429 retried once, 502 recorded; clock: tool, prompt and {{today+3}} agree")
PY
rc=0
env -u NODE_OPTIONS tsx run.mts --fake selftest/outage.json --only seed-001,seed-002,seed-003,seed-005 --out runs/selftest-outage.jsonl >/dev/null 2>runs/selftest-outage.log || rc=$?
if [[ $rc == 2 && $(wc -l < runs/selftest-outage.jsonl) -eq 3 ]] && grep -q '^ABORTED' runs/selftest-outage.log; then
  echo "ok  outage: aborted after 3 consecutive gateway failures"
else
  echo "XX  outage: want exit 2 after 3 records, got exit $rc"; cat runs/selftest-outage.log; fails=1
fi
[[ $fails == 0 ]] && echo "SELFTEST OK" || { echo "SELFTEST FAILED"; exit 1; }
