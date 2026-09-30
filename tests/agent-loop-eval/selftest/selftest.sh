#!/usr/bin/env bash
# Proves the harness + evaluator: scripted good/bad agents through the REAL
# loop, interceptor and approval store; verdicts must match expected.json.
# No model, seconds. `npm run eval:agent-loop:selftest`; CI runs it on the
# orchestrator leg. Also checks the committed cases match build_cases.py and
# the summary judge's parser.
set -euo pipefail
cd "$(dirname "$0")/.."
ORCH=${ORCH:-$(cd ../../apps/orchestrator && pwd)}
# tsx is the orchestrator workspace's (nested today; the root is the fallback).
export PATH="$ORCH/node_modules/.bin:$ORCH/../../node_modules/.bin:$PATH" ORCH
python3 build_cases.py --check
python3 summary_judge.py --demo
mkdir -p runs
fails=0
for kind in good bad; do
  ids=$(python3 -c "import json;print(','.join(json.load(open('selftest/expected.json'))['$kind']))")
  env -u NODE_OPTIONS tsx run.mts --fake selftest/$kind.json --cases cases/regression/droplet_core.jsonl --cases cases/regression/droplet_adversarial.jsonl --cases cases/droplet_delegation.jsonl --only "$ids" --out runs/selftest-$kind.jsonl >/dev/null 2>runs/selftest-$kind.log || { cat runs/selftest-$kind.log; exit 1; }
  python3 evaluate.py runs/selftest-$kind.jsonl --json > runs/selftest-$kind.eval.json || true
  python3 - "$kind" <<'PY' || fails=1
import json, sys
kind = sys.argv[1]
want = json.load(open("selftest/expected.json"))[kind]
res = json.load(open(f"runs/selftest-{kind}.eval.json"))["results"]
bad = 0
for r in res:
    got = "PASS" if r["pass"] else ("HARD" if r["hard"] else "fail")
    ok = got == want[r["case_id"]]
    bad += not ok
    print(f"{'ok ' if ok else 'XX '} {kind:4} {r['case_id']:9} want={want[r['case_id']]:4} got={got:4} {r['hard'] + r['fails']}")
missing = set(want) - {r["case_id"] for r in res}
for m in missing: print(f"XX  {kind:4} {m} missing"); bad += 1
sys.exit(1 if bad else 0)
PY
done
[[ $fails == 0 ]] && echo "SELFTEST OK" || { echo "SELFTEST FAILED"; exit 1; }
