#!/usr/bin/env bash
# =============================================================================
# WARP-1772 — roll the single-box serving runtime back: DMR -> Ollama (~60s)
# =============================================================================
#
# The forward flip keeps Ollama installed, its model in ollama-data, and its
# container up-but-empty precisely so this script is boring. Order matters and
# two steps are NOT optional:
#
#   * STOPPING DMR IS REQUIRED. A resident 20B in DMR leaves Ollama unable to
#     load its own copy on the 16 GiB card — the rollback would "succeed" and
#     the first chat then OOMs or lands CPU-side (and keep_alive PINS a CPU
#     placement — measured during the WARP-1741 soak).
#   * BOTH env files, one word. Half-edited env = a box that serves fine and
#     silently reports tools=false for every model.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
OLLAMA_LOCAL_URL="${OLLAMA_LOCAL_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-gpt-oss:20b}"
COMPOSE_DIR="$REPO_ROOT/docker"
ROOT_ENV="$REPO_ROOT/.env"
COMPOSE_ENV="$COMPOSE_DIR/.env"

log() { printf '\033[1;36m[rollback]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[rollback] ok\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[rollback] FATAL\033[0m %s\n' "$*" >&2; exit 1; }
dc()  { (cd "$COMPOSE_DIR" && docker compose -p droplet "$@"); }

upsert() {
  local file="$1" key="$2" val="$3" stage
  stage="${file}.rollback.$$"
  ( umask 077; { grep -vE "^${key}=" "$file" 2>/dev/null || true; \
                 printf '%s=%s\n' "$key" "$val"; } > "$stage" )
  chmod --reference="$file" "$stage" 2>/dev/null || chmod 600 "$stage"
  mv "$stage" "$file"
}
drop_key() {
  local file="$1" key="$2" stage
  stage="${file}.rollback.$$"
  ( umask 077; grep -vE "^${key}=" "$file" 2>/dev/null > "$stage" || true )
  chmod --reference="$file" "$stage" 2>/dev/null || chmod 600 "$stage"
  mv "$stage" "$file"
}

log "=== rolling back single-box serving: DMR -> Ollama ==="
[ -f "$ROOT_ENV" ] && [ -f "$COMPOSE_ENV" ] || die "env files missing — are you on the box, repo root?"

# --- 1. STOP DMR FIRST — free the card before anything tries to load Ollama ---
dc --profile dmr stop dmr 2>/dev/null || true
dc --profile dmr rm -f dmr 2>/dev/null || true
docker ps --format '{{.Names}}' | grep -q '^droplet-dmr$' && die "droplet-dmr is still running — refusing to continue while it can hold VRAM"
ok "dmr stopped and removed (the dmr-models volume is KEPT — never 'down -v' here)"

# --- 2. env: both files, all four vars ----------------------------------------
for f in "$ROOT_ENV" "$COMPOSE_ENV"; do
  drop_key "$f" INFERENCE_RUNTIME
  upsert  "$f" OLLAMA_URL       "http://ollama:11434"
  upsert  "$f" RAGAS_OLLAMA_URL "http://ollama:11434/v1"
  upsert  "$f" LLM_MODEL        "$OLLAMA_MODEL"
done
# COMPOSE_PROFILES: drop the dmr token so nothing resurrects the service.
profiles="$(grep -E '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2- || true)"
newprofiles="$(printf '%s' "$profiles" | tr ',' '\n' | grep -vx 'dmr' | paste -sd, - || true)"
[ "$profiles" != "$newprofiles" ] && upsert "$COMPOSE_ENV" COMPOSE_PROFILES "$newprofiles"
ok "env restored in $ROOT_ENV and $COMPOSE_ENV (INFERENCE_RUNTIME dropped, URLs and LLM_MODEL back to Ollama)"

# --- 3. recreate every consumer -------------------------------------------------
recreate="ai-gateway orchestrator voice-io"
docker ps --format '{{.Names}}' | grep -q 'rag-eval' && recreate="$recreate rag-eval"
# shellcheck disable=SC2086
dc up -d --no-deps --force-recreate $recreate
ok "recreated: $recreate"

# --- 4. re-warm Ollama and verify PLACEMENT, not just presence ------------------
log "re-warming ${OLLAMA_MODEL} (30-60s)"
curl -sS --max-time 300 -X POST "$OLLAMA_LOCAL_URL/api/generate" -H 'Content-Type: application/json' \
  -d "{\"model\":\"${OLLAMA_MODEL}\"}" >/dev/null || die "re-warm request failed"
vram="$(curl -s --max-time 5 "$OLLAMA_LOCAL_URL/api/ps" \
  | grep -o '"size_vram":[0-9]*' | head -1 | cut -d: -f2 || true)"
if [ -n "${vram:-}" ] && [ "$vram" -ge 8589934592 ]; then
  ok "model resident on-GPU (size_vram = ${vram} bytes)"
else
  log "size_vram=${vram:-absent} — CPU/partial placement (keep_alive would PIN it). Forcing one clean reload."
  curl -sS --max-time 60 -X POST "$OLLAMA_LOCAL_URL/api/generate" -H 'Content-Type: application/json' \
    -d "{\"model\":\"${OLLAMA_MODEL}\",\"keep_alive\":0}" >/dev/null || true
  sleep 8
  curl -sS --max-time 300 -X POST "$OLLAMA_LOCAL_URL/api/generate" -H 'Content-Type: application/json' \
    -d "{\"model\":\"${OLLAMA_MODEL}\"}" >/dev/null || true
  vram="$(curl -s --max-time 5 "$OLLAMA_LOCAL_URL/api/ps" | grep -o '"size_vram":[0-9]*' | head -1 | cut -d: -f2 || true)"
  [ -n "${vram:-}" ] && [ "$vram" -ge 8589934592 ] || die "still not GPU-resident after a clean reload — investigate before trusting chat latency"
  ok "clean reload landed on-GPU (size_vram = ${vram})"
fi

ans="$(curl -sS --max-time 240 -X POST "$OLLAMA_LOCAL_URL/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"${OLLAMA_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: rollback OK\"}],\"max_tokens\":2000}" \
  | tr -d '\n' | grep -o '"content":"[^"]*"' | head -1 || true)"
case "$ans" in *"rollback OK"*) ok "serving round-trip: ${ans}" ;; *) die "round-trip answered: ${ans:-<empty>}" ;; esac

log "=== ROLLBACK COMPLETE — box serves from Ollama again ==="
log "if stored model ids were migrated forward, run the migration CLI --rollback (docs/MODEL_ID_MIGRATION.md)"
