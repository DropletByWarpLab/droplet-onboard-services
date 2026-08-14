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

# WARP-1908: resolve through a symlink BEFORE staging — see the matching
# note in flip-single-box.sh. docker/.env is a symlink to ../.env so that
# Compose's ${...} interpolation source and the services' `env_file:` are
# one file; `mv` onto the LINK path would replace it with a regular file
# and fork the two permanently, silently blanking every key that only root
# .env carries.
_resolve_env_target() { readlink -f "$1" 2>/dev/null || printf '%s' "$1"; }

upsert() {
  local file key="$2" val="$3" stage
  file="$(_resolve_env_target "$1")"
  stage="${file}.rollback.$$"
  ( umask 077; { grep -vE "^${key}=" "$file" 2>/dev/null || true; \
                 printf '%s=%s\n' "$key" "$val"; } > "$stage" )
  chmod --reference="$file" "$stage" 2>/dev/null || chmod 600 "$stage"
  mv "$stage" "$file"
}
drop_key() {
  local file key="$2" stage
  file="$(_resolve_env_target "$1")"   # WARP-1908 — write through the symlink
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
  # SET it, don't DROP it (WARP-1870). Dropping used to be equivalent because
  # absent defaulted to ollama everywhere. It no longer does: a fresh box now
  # provisions to dmr, ai-gateway reads the key at import with an "ollama"
  # default that is now a LIE about intent, and single-box.sh derives the
  # compose profile from it — so an absent key means the next setup.sh re-run
  # re-flips the box straight back to DMR, undoing this rollback silently.
  upsert  "$f" INFERENCE_RUNTIME "ollama"
  upsert  "$f" OLLAMA_URL       "http://ollama:11434"
  upsert  "$f" RAGAS_OLLAMA_URL "http://ollama:11434/v1"
  upsert  "$f" LLM_MODEL        "$OLLAMA_MODEL"
done
# COMPOSE_PROFILES: SWAP the runtime token, don't just delete dmr.
#
# Before WARP-1869 deleting `dmr` was enough, because `ollama` rode the
# always-active `single-box` profile and was therefore already running. Now
# ollama has its OWN profile, so dropping dmr without adding ollama leaves the
# box with NO runtime token at all — no inference, and nothing to warm two
# steps below, which is exactly where this script would then die with dmr
# already stopped and both env files already rewritten.
profiles="$(grep -E '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2- || true)"
newprofiles="$(printf '%s' "$profiles" | tr ',' '\n' | grep -vx 'dmr' | grep -vx 'ollama' | paste -sd, - || true)"
newprofiles="${newprofiles:+$newprofiles,}ollama"
[ "$profiles" != "$newprofiles" ] && upsert "$COMPOSE_ENV" COMPOSE_PROFILES "$newprofiles"
# The root .env is what setup.sh runs compose with (--env-file $REPO_ROOT/.env),
# so the token has to be in BOTH files or the next scripted run disagrees with
# this one. That split is what WARP-1865 was.
rprofiles="$(grep -E '^COMPOSE_PROFILES=' "$ROOT_ENV" | tail -1 | cut -d= -f2- || true)"
rnew="$(printf '%s' "$rprofiles" | tr ',' '\n' | grep -vx 'dmr' | grep -vx 'ollama' | paste -sd, - || true)"
rnew="${rnew:+$rnew,}ollama"
[ "$rprofiles" != "$rnew" ] && upsert "$ROOT_ENV" COMPOSE_PROFILES "$rnew"
ok "env restored in $ROOT_ENV and $COMPOSE_ENV (INFERENCE_RUNTIME=ollama, profile token swapped dmr->ollama, URLs and LLM_MODEL back to Ollama)"

# --- 2b. START Ollama — it is no longer running by default ---------------------
# Pre-WARP-1869 this step did not exist because ollama rode `single-box` and
# was always up. Now it must be brought up explicitly, BEFORE anything tries to
# warm it.
dc --profile ollama up -d --no-deps ollama
for _ in $(seq 1 60); do
  curl -sf --max-time 3 "$OLLAMA_LOCAL_URL/api/tags" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf --max-time 3 "$OLLAMA_LOCAL_URL/api/tags" >/dev/null 2>&1 \
  || die "ollama did not become reachable at $OLLAMA_LOCAL_URL — cannot roll back onto a runtime that will not start"
ok "ollama started and answering"

# The store may be EMPTY: the flip does not populate it, and a box that has
# been on DMR for a while has never pulled this model. Warming an absent model
# fails in a way that reads like a placement problem, so pull first if needed.
if ! curl -s --max-time 5 "$OLLAMA_LOCAL_URL/api/tags" | grep -qF "\"${OLLAMA_MODEL}\""; then
  log "${OLLAMA_MODEL} is not in the Ollama store — pulling (~13 GB, several minutes)"
  curl -sS --max-time 3600 -X POST "$OLLAMA_LOCAL_URL/api/pull" \
    -H 'Content-Type: application/json' -d "{\"model\":\"${OLLAMA_MODEL}\"}" >/dev/null \
    || die "pull of ${OLLAMA_MODEL} failed — the rollback cannot complete without weights"
  ok "pulled ${OLLAMA_MODEL}"
fi

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
