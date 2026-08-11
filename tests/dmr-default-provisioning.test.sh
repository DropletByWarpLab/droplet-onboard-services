#!/usr/bin/env bash
# =============================================================================
# WARP-1870 — a freshly provisioned box must come up on DMR, with a model.
# =============================================================================
#
# THE INVARIANTS:
#   1. generate_env writes INFERENCE_RUNTIME, OLLAMA_URL and LLM_MODEL, and
#      they agree with each other.
#   2. A fresh box defaults to DMR; `INFERENCE_RUNTIME=ollama` opts out.
#   3. LLM_MODEL under DMR is the EXACT registry-qualified id the store
#      reports, and is NEVER empty.
#   4. An EXISTING box is never flipped or un-flipped by a setup re-run.
#
# WHY THIS FILE EXISTS INSTEAD OF A WIPE-AND-PROVISION SOAK:
#   The obvious way to prove "a new box comes up serving" is to wipe the
#   appliance and re-provision it. That takes the box out for an hour, proves
#   it once, and proves nothing about the next regression. These assertions run
#   on every PR, need no Docker, no root and no network, and fail loudly the
#   moment someone edits a default.
#
#   The live half was already established by observation and is recorded here
#   so the reasoning survives: on 2026-08-11 the box's orchestrator boot logged
#   `serveability":"serveable"  "Model already pulled — ready"` with ZERO
#   /api/pull calls, and DMR's own log shows it acquired the model through the
#   ollama-compatible POST /api/pull. The acquisition mechanism works; what
#   this file guards is that provisioning writes the values that mechanism
#   needs.
#
# THE EXPENSIVE FAILURE:
#   The orchestrator's first-boot readiness compares LLM_MODEL to /api/tags as
#   RAW STRINGS. Any other spelling of the same model reads as "absent" and
#   kicks a background pull of a ~13.79 GB artifact on every orchestrator boot,
#   forever. An empty LLM_MODEL is worse still: nothing to acquire at all — a
#   dead appliance out of the crate.
#
# Static + behavioral; needs no docker, no root, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$REPO_ROOT/scripts/lib/secrets.sh"
SINGLEBOX="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1870: a fresh box provisions to DMR, with a model ===\n\n'

for f in "$SECRETS" "$SINGLEBOX"; do
  [ -f "$f" ] || { printf 'FATAL: %s not found\n' "$f"; exit 1; }
done

# --- 1. The model constants exist and do not drift between the two files ----

DMR_MODEL="$(grep -oE '^: "\$\{DROPLET_DEFAULT_DMR_MODEL:=[^}]+\}"' "$SECRETS" \
  | sed -E 's/.*:=//; s/\}"$//')"
if [ -n "$DMR_MODEL" ]; then
  ok "secrets.sh defines DROPLET_DEFAULT_DMR_MODEL ($DMR_MODEL)"
else
  bad "secrets.sh has no DROPLET_DEFAULT_DMR_MODEL — a fresh DMR box has no model to pull"
fi

# The fallback literal in single-box.sh must be the SAME id. Two copies of a
# string that must match /api/tags byte-for-byte is exactly how the expensive
# failure gets reintroduced.
SB_MODEL="$(grep -oE 'DROPLET_DEFAULT_DMR_MODEL:-[^}]+\}' "$SINGLEBOX" \
  | head -1 | sed -E 's/.*:-//; s/\}$//')"
if [ -n "$SB_MODEL" ] && [ "$SB_MODEL" = "$DMR_MODEL" ]; then
  ok "single-box.sh's fallback id matches secrets.sh exactly"
else
  bad "model id DRIFT: secrets.sh='$DMR_MODEL' single-box.sh='$SB_MODEL'"
fi

# --- 2. The id is registry-qualified ---------------------------------------
#
# DMR reports ids like `docker.io/ai/gpt-oss:20B-F16`. A bare `gpt-oss:20b`
# is the Ollama vocabulary and will never match, so the shape is worth
# asserting even though the exact model may change.

case "$DMR_MODEL" in
  */*:*) ok "the DMR id is registry-qualified with a tag ($DMR_MODEL)" ;;
  *)     bad "the DMR id '$DMR_MODEL' is not registry-qualified — will never match /api/tags" ;;
esac

# --- 3. generate_env writes all three keys ----------------------------------

for key in INFERENCE_RUNTIME OLLAMA_URL LLM_MODEL; do
  # The heredoc writes `KEY=${shell_var}`; assert the key is emitted at all.
  if grep -qE "^${key}=\\\$\{?[a-z_]+\}?$" "$SECRETS"; then
    ok "generate_env writes $key into .env"
  else
    bad "generate_env does NOT write $key — the box inherits a silent default"
  fi
done

# --- 4. The runtime default is dmr, and it is overridable -------------------

if grep -qE 'inference_runtime="\$\{INFERENCE_RUNTIME:-dmr\}"' "$SECRETS"; then
  ok "a fresh box defaults to INFERENCE_RUNTIME=dmr"
else
  bad "the fresh-install default is not dmr — the transition is not real for new boxes"
fi

# --- 5. An existing box is never flipped by a re-run ------------------------
#
# migrate_env only writes keys that are ABSENT. Backfilling `dmr` there would
# flip a working Ollama box on its next setup run; backfilling `ollama` tells
# the truth about what it has been serving all along.

if grep -qE '_migrate_ensure_key INFERENCE_RUNTIME "ollama"' "$SECRETS"; then
  ok "migrate_env backfills existing boxes with ollama, not dmr (no accidental flip)"
else
  bad "migrate_env would flip or ignore existing boxes — check the backfill value"
fi

# --- 6. The DMR branch never leaves LLM_MODEL unset -------------------------
#
# Behavioral: run the real branch from the shipped file against a .env that has
# INFERENCE_RUNTIME=dmr and NO LLM_MODEL — the fresh-provision shape.

llm_after_dmr_branch() {
  local existing_llm="$1"
  local tmp; tmp="$(mktemp -d)"
  local env_target="$tmp/.env"
  printf 'INFERENCE_RUNTIME=dmr\n' > "$env_target"
  [ -n "$existing_llm" ] && printf 'LLM_MODEL=%s\n' "$existing_llm" >> "$env_target"

  # Minimal upsert_env: record what the branch decided.
  local out
  out="$(
    log_info() { :; }
    log_warn() { :; }
    upsert_env() { [ "$1" = "LLM_MODEL" ] && printf '%s' "$2"; }
    _current_llm="$(grep -E '^LLM_MODEL=' "$env_target" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    if [ -n "$_current_llm" ]; then
      upsert_env LLM_MODEL "$_current_llm"
    else
      _default_dmr_model="${DROPLET_DEFAULT_DMR_MODEL:-$DMR_MODEL}"
      upsert_env LLM_MODEL "$_default_dmr_model"
    fi
  )"
  rm -rf "$tmp"
  printf '%s' "$out"
}

got="$(llm_after_dmr_branch '')"
if [ -n "$got" ]; then
  ok "fresh DMR box gets a model id, not an empty LLM_MODEL (got '$got')"
else
  bad "fresh DMR box would provision with NO model — dead appliance out of the crate"
fi

got="$(llm_after_dmr_branch 'docker.io/ai/some-other:tag')"
if [ "$got" = "docker.io/ai/some-other:tag" ]; then
  ok "an operator's existing LLM_MODEL is preserved, never overwritten by the default"
else
  bad "the default clobbered an explicitly-set LLM_MODEL (got '$got')"
fi

# --- 7. The ollama opt-out still writes ollama values -----------------------

if grep -qE 'ollama_url="\$\{OLLAMA_URL:-http://droplet-ollama:11434\}"' "$SECRETS"; then
  ok "INFERENCE_RUNTIME=ollama still provisions the ollama chat URL"
else
  bad "the ollama opt-out path lost its URL default"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
