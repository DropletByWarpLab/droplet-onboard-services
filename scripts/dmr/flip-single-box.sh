#!/usr/bin/env bash
# =============================================================================
# WARP-1772 — flip the single-box serving runtime: Ollama -> Docker Model Runner
# =============================================================================
#
# Run ON THE BOX, from the repo root, by an operator, AFTER every WARP-1749
# precondition is met (Phase-0 PASS, soak, size_vram decision, human sign-off).
# This script is the runbook made executable — every step is idempotent and
# every verification is a hard gate. Companion: rollback-single-box.sh.
#
# What it does, in order:
#   1. Preflights (shape, override file, soak marker, env backups)
#   2. Activates the dark `dmr` service and populates its store
#   3. Derives LLM_MODEL from the id DMR ITSELF reports (/api/tags) — the
#      registry-qualified string. Never hardcoded: the id-vocabulary gap is
#      the #1 measured failure class (silent _configure no-ops, boot
#      re-pull storms), and the fix is to use the daemon's own spelling.
#   4. Writes the four runtime-coupled vars into BOTH env files — root .env
#      (consumed by services via env_file) and docker/.env (compose
#      interpolation). Two files, two mechanisms, one word each.
#   5. Recreates every consumer with --force-recreate (env binds at import
#      time in the gateway; a restart re-reads nothing)
#   6. Verifies: engine up, context canary, capability-table env present,
#      no readiness re-pull storm, Ollama demoted to empty standby
#
# ROLLBACK: scripts/dmr/rollback-single-box.sh (~60s, Ollama stays installed).
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DMR_URL="${DMR_URL:-http://127.0.0.1:12434}"
OLLAMA_LOCAL_URL="${OLLAMA_LOCAL_URL:-http://127.0.0.1:11434}"
MODEL_REPO_KEY="${MODEL_REPO_KEY:-gpt-oss}"   # repository to serve, tag-free
DMR_PULL_REF="${DMR_PULL_REF:-ai/gpt-oss:20B-F16}"
EXPECTED_CTX="${EXPECTED_CTX:-16384}"
# Pins the DRM card whose VRAM the two runtimes contend for, e.g.
# FLIP_GPU_CARD=card1. Empty (the default) discovers it — see
# resolve_vram_node() in step 4. Set it when a box carries more than one
# VRAM-reporting GPU and discovery lands on the wrong one. The rack panel's
# PANEL_GPU_CARD is the same knob for the same reason.
FLIP_GPU_CARD="${FLIP_GPU_CARD:-}"
COMPOSE_DIR="$REPO_ROOT/docker"
ROOT_ENV="$REPO_ROOT/.env"
COMPOSE_ENV="$COMPOSE_DIR/.env"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '\033[1;36m[flip]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[flip] ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[flip] FATAL\033[0m %s\n' "$*" >&2; printf '[flip] Rollback: scripts/dmr/rollback-single-box.sh\n' >&2; exit 1; }

dc() { (cd "$COMPOSE_DIR" && docker compose -p droplet "$@"); }

# --- helpers -----------------------------------------------------------------
upsert() { # upsert FILE KEY VALUE — last-wins replace-or-append, atomic-ish
  local file="$1" key="$2" val="$3" stage
  stage="${file}.flip.$$"
  ( umask 077; { grep -vE "^${key}=" "$file" 2>/dev/null || true; \
                 printf '%s=%s\n' "$key" "$val"; } > "$stage" )
  chmod --reference="$file" "$stage" 2>/dev/null || chmod 600 "$stage"
  mv "$stage" "$file"
}

# =============================================================================
log "=== WARP-1772 single-box flip: Ollama -> DMR ==="

# --- 1. Preflights -----------------------------------------------------------
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "run from the repo root on the box"
grep -q '^  dmr:' "$COMPOSE_DIR/docker-compose.yml" || die "this tree has no dmr service — deploy a main that includes WARP-1772 first"
# WARP-1870: this used to `die` unless droplet-ollama was RUNNING, as a proxy
# for "is this the single-box shape?". That proxy inverted the day DMR became
# the provisioning default: a fresh box comes up on DMR with no ollama
# container at all, and an already-flipped box has none either — so the check
# refused to run on exactly the boxes it exists to serve, while blaming the
# shape.
#
# Assert the SHAPE directly instead. The in-container router is what the
# `single-box` profile actually gates (with the switch and camera-discovery),
# and it is present regardless of which inference runtime is selected.
docker ps --format '{{.Names}}' | grep -q '^droplet-openwrt$' \
  || die "droplet-openwrt is not running — is this the single-box shape? (the flip does not apply to multi-box)"

# Already on DMR? Nothing to flip, and continuing would stop the runtime that
# is currently serving.
if [ "$(grep -E '^INFERENCE_RUNTIME=' "$ROOT_ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')" = "dmr" ] \
   && docker ps --format '{{.Names}}' | grep -q '^droplet-dmr$'; then
  die "already on DMR (INFERENCE_RUNTIME=dmr and droplet-dmr is running) — nothing to flip.
    To go the other way: scripts/dmr/rollback-single-box.sh"
fi

if [ -f "$COMPOSE_DIR/docker-compose.override.yml" ] && [ "${DROPLET_OVERRIDE_ACK:-}" != "1" ]; then
  die "docker/docker-compose.override.yml exists. Recreating services without it
    strips whatever it carries. Read it, confirm it holds no runtime-coupled
    config, then re-run with DROPLET_OVERRIDE_ACK=1."
fi
if [ -f /home/droplet/warp1741-bench/SOAK-IN-PROGRESS ]; then
  die "a WARP-1741 soak is in progress — flipping mid-soak contends for the GPU. Wait for SOAK COMPLETE or remove the marker deliberately."
fi
[ -f "$ROOT_ENV" ]    || die "missing $ROOT_ENV"
[ -f "$COMPOSE_ENV" ] || die "missing $COMPOSE_ENV"
cp -p "$ROOT_ENV"    "${ROOT_ENV}.preflip-${STAMP}"
cp -p "$COMPOSE_ENV" "${COMPOSE_ENV}.preflip-${STAMP}"
ok "env snapshots: .env.preflip-${STAMP} (both files)"
log "NOTE: run this inside a quiet window of the hourly box-refresh (right after :35), or hold that automation for the duration."

# --- 2. dmr profile + service up ----------------------------------------------
profiles="$(grep -E '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | tail -1 | cut -d= -f2- || true)"
case ",$profiles," in
  *,dmr,*) ok "COMPOSE_PROFILES already contains dmr" ;;
  *) upsert "$COMPOSE_ENV" COMPOSE_PROFILES "${profiles:+$profiles,}dmr"
     ok "COMPOSE_PROFILES -> $(grep -E '^COMPOSE_PROFILES=' "$COMPOSE_ENV" | cut -d= -f2-)" ;;
esac

dc up -d dmr
for _ in $(seq 1 45); do
  curl -sf --max-time 3 "$DMR_URL/engines/status" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf --max-time 3 "$DMR_URL/engines/status" >/dev/null 2>&1 || die "dmr never answered /engines/status"
ok "dmr serving on $DMR_URL"

# --- 3. model artifact + derive the id DMR reports ----------------------------
list_names() {
  curl -sS -m 10 "$DMR_URL/api/tags" 2>/dev/null \
    | tr ',' '\n' | grep -o '"name":"[^"]*"' | cut -d'"' -f4 || true
}
matches_repo() { # candidate list on stdin -> names whose repository key matches
  grep -Ei "(^|/)(${MODEL_REPO_KEY})(:|$)" || true
}
names="$(list_names | matches_repo)"
if [ -z "$names" ]; then
  log "no ${MODEL_REPO_KEY} artifact in the DMR store — pulling ${DMR_PULL_REF} (13.8 GB; this is the long step)"
  curl -sS --max-time 3600 -X POST "$DMR_URL/api/pull" -H 'Content-Type: application/json' \
    -d "{\"name\":\"${DMR_PULL_REF}\",\"stream\":true}" | tail -2
  names="$(list_names | matches_repo)"
fi
[ -n "$names" ] || die "pull finished but no ${MODEL_REPO_KEY} entry in /api/tags — inspect the store"
count="$(printf '%s\n' "$names" | grep -c . || true)"
[ "$count" = "1" ] || die "ambiguous: ${count} ${MODEL_REPO_KEY} entries in the store:
$names
Remove the extras or set MODEL_REPO_KEY tighter — guessing here is how the wrong model becomes the box default."
NEW_LLM_MODEL="$(printf '%s\n' "$names" | head -1)"
ok "DMR reports the model as: ${NEW_LLM_MODEL}  <- this exact string becomes LLM_MODEL"

# --- 4. context canary BEFORE any consumer moves -------------------------------
# EVICT THE SERVING MODEL FIRST. Two 20Bs cannot share the 16 GiB card: the
# first execution (2026-08-10) ran this canary with Ollama still resident and
# the DMR load OOM'd (cudaMalloc 12036 MiB beside an 11.87 GiB resident) — the
# canary aborted correctly but blamed LLAMA_ARG_CTX_SIZE. Evict-first is safe
# here: env is untouched at this point, so on any abort the orchestrator's
# readiness warm restores the serving model unaided.
log "evicting the serving model for the canary window (self-heals on abort)"
curl -s --max-time 60 -X POST "$OLLAMA_LOCAL_URL/api/generate" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b","keep_alive":0}' >/dev/null 2>&1 || true

# Which card do we watch? Discovered, never hardcoded: a single box carries a
# discrete GPU AND an iGPU, and `cardN` numbering is not guaranteed stable
# across units — poll the wrong node and the read fails, "0" reads as free, and
# the wait becomes a silent no-op on exactly the hardware most likely to race
# the eviction. Mirrors _get_gpu() in services/oled-display/display.py: an
# explicit pin wins outright, indices sort numerically (card10 after card2),
# and a card only qualifies if it actually exposes the node we read. Among real
# candidates the largest VRAM pool wins — that is the discrete card, not the
# APU's small carve-out, which would otherwise sit under the threshold forever.
# `SYS_DRM_ROOT` is not an operator knob: it exists so this can be driven
# against a fixture tree, the same reason display.py names `_SYS_DRM`.
resolve_vram_node() {   # -> path to mem_info_vram_used, or empty if none
  local root="${SYS_DRM_ROOT:-/sys/class/drm}" idx n path total best="" best_total=-1
  if [ -n "$FLIP_GPU_CARD" ]; then
    # An explicit pin is honoured exactly — never fall back to another card,
    # the operator named that one on purpose.
    path="$root/$FLIP_GPU_CARD/device/mem_info_vram_used"
    [ -r "$path" ] && printf '%s' "$path"
    return 0
  fi
  idx="$(for d in "$root"/card*; do
           n="${d##*/card}"
           # `card1` yes; `card1-HDMI-A-3` (a connector) and an unmatched glob no.
           case "$n" in ''|*[!0-9]*) continue ;; esac
           printf '%s\n' "$n"
         done | sort -n)"
  for n in $idx; do
    path="$root/card$n/device/mem_info_vram_used"
    [ -r "$path" ] || continue
    total="$(cat "$root/card$n/device/mem_info_vram_total" 2>/dev/null || echo 0)"
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    [ "$total" -gt "$best_total" ] && { best="$path"; best_total="$total"; }
  done
  printf '%s' "$best"
}

vram_node="$(resolve_vram_node)"
if [ -n "$vram_node" ]; then
  log "watching $vram_node for the eviction (up to 120s)"
  evicted=0
  for _ in $(seq 1 24); do
    # A read that fails or comes back unparseable must NOT count as "free" —
    # that is the silent no-op this step exists to prevent — so anything we
    # cannot read as a number keeps us waiting instead.
    used="$(cat "$vram_node" 2>/dev/null || true)"
    case "$used" in ''|*[!0-9]*) used=9999999999 ;; esac
    [ "$used" -lt 2147483648 ] && { evicted=1; break; }
    sleep 5
  done
  [ "$evicted" = 1 ] || log "WARN: $vram_node never dropped below 2 GiB in 120s — the card still looks occupied. Proceeding; the --fail load probe below is the gate, and an allocation failure there means the eviction never took."
else
  log "WARN: no readable device/mem_info_vram_used under /sys/class/drm${FLIP_GPU_CARD:+ for the pinned FLIP_GPU_CARD=$FLIP_GPU_CARD} — the eviction CANNOT be verified on this host."
  log "WARN: waiting the same 120s blind rather than treating an unreadable card as free. If the load probe below reports an allocation failure, pin the discrete GPU (FLIP_GPU_CARD=cardN) and re-run."
  sleep 120
fi
log "loading the model once for the context canary (~15-60s)"
# --fail is load-bearing: without it a 5xx from a failed load exits 0 and the
# failure surfaces one step later as a missing-log-line mystery.
curl -sS --fail --max-time 600 -X POST "$DMR_URL/engines/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"${NEW_LLM_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4}" >/dev/null \
  || die "load probe FAILED against ${NEW_LLM_MODEL} — read 'docker logs droplet-dmr' first:
    an out-of-memory allocation there means something still holds the card."
ctx_line="$(docker logs --since 15m droplet-dmr 2>&1 | grep 'n_ctx_slot' | tail -1 || true)"
case "$ctx_line" in
  *"n_ctx_slot = ${EXPECTED_CTX}"*) ok "context canary: n_ctx_slot = ${EXPECTED_CTX}" ;;
  *) die "context canary FAILED — wanted n_ctx_slot = ${EXPECTED_CTX}, log says: ${ctx_line:-<no line>}
    NO line at all means llama-server never spawned — check 'docker logs
    droplet-dmr' for an allocation failure before suspecting the env. A WRONG
    value means LLAMA_ARG_CTX_SIZE did not apply. Either way do not proceed:
    the ~80-schema owner prompt would truncate silently (WARP-854)." ;;
esac

# --- 5. write the four vars into BOTH env files --------------------------------
for f in "$ROOT_ENV" "$COMPOSE_ENV"; do
  upsert "$f" INFERENCE_RUNTIME dmr
  upsert "$f" OLLAMA_URL        "http://dmr:12434"
  upsert "$f" RAGAS_OLLAMA_URL  "http://dmr:12434/v1"
  upsert "$f" LLM_MODEL         "$NEW_LLM_MODEL"
done
ok "runtime vars written to $ROOT_ENV and $COMPOSE_ENV (one word, BOTH halves — the half-migrated-box trap)"

# --- 6. recreate every consumer -------------------------------------------------
recreate="ai-gateway orchestrator voice-io"
docker ps --format '{{.Names}}' | grep -q 'rag-eval' && recreate="$recreate rag-eval"
log "force-recreating: $recreate (env binds at import time — restart re-reads nothing)"
# shellcheck disable=SC2086  # word-splitting is the point
dc up -d --no-deps --force-recreate $recreate

# --- 7. verify -------------------------------------------------------------------
sleep 25
fail=0

rt="$(docker exec droplet-ai-gateway-1 sh -c 'echo "$INFERENCE_RUNTIME"' 2>/dev/null || true)"
if [ "$rt" = "dmr" ]; then ok "ai-gateway container carries INFERENCE_RUNTIME=dmr (capability table active)"; else
  log "FAIL: ai-gateway INFERENCE_RUNTIME='$rt' — tools would silently report false"; fail=1; fi

url_in_gw="$(docker exec droplet-ai-gateway-1 sh -c 'echo "$OLLAMA_URL"' 2>/dev/null || true)"
if [ "$url_in_gw" = "http://dmr:12434" ]; then ok "ai-gateway chat path -> $url_in_gw"; else
  log "FAIL: ai-gateway OLLAMA_URL='$url_in_gw'"; fail=1; fi

if docker logs --since 3m droplet-orchestrator-1 2>&1 | grep -q "starting background pull"; then
  log "FAIL: orchestrator kicked a background pull — the id vocabulary is off (LLM_MODEL vs /api/tags). Check ${NEW_LLM_MODEL} against /api/tags verbatim."; fail=1
else ok "no readiness re-pull (id vocabulary agrees)"; fi

ans="$(curl -sS --max-time 240 -X POST "$DMR_URL/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"${NEW_LLM_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: flip OK\"}],\"max_tokens\":2000}" \
  | tr -d '\n' | grep -o '"content":"[^"]*"' | head -1 || true)"
case "$ans" in *"flip OK"*) ok "serving round-trip through DMR: ${ans}" ;; *) log "FAIL: round-trip answered: ${ans:-<empty>}"; fail=1 ;; esac

# --- 8. demote Ollama to empty standby -------------------------------------------
curl -sS --max-time 60 -X POST "$OLLAMA_LOCAL_URL/api/generate" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b","keep_alive":0}' >/dev/null 2>&1 || true
sleep 3
resident="$(curl -s --max-time 5 "$OLLAMA_LOCAL_URL/api/ps" | grep -c '"name"' || true)"
if [ "${resident:-0}" = "0" ]; then ok "Ollama demoted to empty standby (container stays up = ~60s rollback)"; else
  log "WARN: Ollama still holds a model — nothing should re-warm it now; check who did (docker logs droplet-ollama)"; fi

if [ "$fail" != "0" ]; then
  die "one or more verifications FAILED — roll back now and investigate. Env snapshots: *.preflip-${STAMP}"
fi

log "=== FLIP COMPLETE ==="
log "manual follow-ups: (1) dashboard chat + a tool call by hand, (2) Models page shows the honest-metrics placeholders, (3) run the model-id migration CLI for stored rows (docs/MODEL_ID_MIGRATION.md), (4) watch the next hourly box-refresh tick leaves the flip intact."
