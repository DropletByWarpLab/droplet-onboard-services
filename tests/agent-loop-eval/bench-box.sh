#!/usr/bin/env bash
# Model run of the agent-loop eval on a bench box (WARP-3286). Runs ON the box,
# as root (docker), against the box's own ai-gateway and model:
#
#   sudo tests/agent-loop-eval/bench-box.sh <label> [run.mts args...]
#   sudo tests/agent-loop-eval/bench-box.sh stage                  # 66 cases x 3
#   sudo tests/agent-loop-eval/bench-box.sh del --cases cases/droplet_delegation.jsonl
#
# The harness runs in node:20-bookworm on the compose network and reaches
# http://ai-gateway:8000 the way the orchestrator does. The gateway token,
# model and context length come from the live orchestrator container; the
# token is passed by name only, never printed or put on a command line. The
# checkout is bootstrapped (npm ci + npm run bootstrap) on first use.
# Writes runs/<UTC date>-<label>.{jsonl,log,report.txt}; the report ends with
# the pass^k summary. Sequential by design: one GPU, one model. Back-to-back
# runs pace themselves: run.mts waits out the gateway's 60 req/min 429s.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LABEL=${1:?usage: bench-box.sh <label> [run.mts args...]}; shift
# Compose names on a box installed by setup.sh.
ORCH_CT=${ORCH_CT:-droplet-orchestrator-1}
NET=${NET:-droplet_default}
env_of() { docker exec "$ORCH_CT" printenv "$1" || true; }
export AGENT_EVAL_GATEWAY_TOKEN; AGENT_EVAL_GATEWAY_TOKEN=$(env_of SERVICE_TOKEN_AI_GATEWAY)
MODEL=${MODEL:-$(env_of LLM_MODEL)}
: "${MODEL:?no model: set MODEL, or LLM_MODEL on $ORCH_CT}"
CTX=$(env_of OLLAMA_CONTEXT_LENGTH)
NAME=$(date -u +%F)-$LABEL
mkdir -p "$HERE/runs"
chown "$(stat -c %u:%g "$REPO")" "$HERE/runs"
echo "model=$MODEL -> $HERE/runs/$NAME.*"
docker run --rm --user "$(stat -c %u:%g "$REPO")" --network "$NET" -v "$REPO:/repo" -w /repo \
  -e HOME=/tmp -e CI=1 -e AGENT_EVAL_GATEWAY_URL=http://ai-gateway:8000 -e AGENT_EVAL_GATEWAY_TOKEN \
  -e OLLAMA_CONTEXT_LENGTH="${CTX:-16384}" -e AGENT_BLANK_TURN_DEBUG=1 -e LOG_LEVEL=warn \
  node:20-bookworm bash -c '
    set -eo pipefail
    npm run -s bootstrap:check >/dev/null 2>&1 || { npm ci --no-audit --no-fund --loglevel=error && npm run bootstrap; }
    cd tests/agent-loop-eval
    N=$1 M=$2; shift 2
    PATH=/repo/apps/orchestrator/node_modules/.bin:/repo/node_modules/.bin:$PATH
    tsx run.mts --model "$M" --repeat 3 --out runs/$N.jsonl "$@" 2> runs/$N.log || { tail -n 20 runs/$N.log; exit 1; }
    python3 evaluate.py runs/$N.jsonl > runs/$N.report.txt || true   # exit 1 = a hard gate tripped
    tail -n 25 runs/$N.report.txt
  ' _ "$NAME" "$MODEL" "$@"
