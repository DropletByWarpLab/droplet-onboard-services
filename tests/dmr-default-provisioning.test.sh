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

  # Run the REAL branch out of the shipped file, never a copy of it.
  #
  # The first version of this helper reimplemented the if/else inline, and that
  # made these assertions theatre: reverting single-box.sh's fix left the suite
  # fully green because the test was exercising its own copy, not the code.
  # Extract the block instead, as the sibling dmr-profile-survives-setup.test.sh
  # does — a test that reimplements the logic keeps passing when the fix is
  # reverted, which is the one thing a regression test must never do.
  local block
  block="$(awk '/^    _current_llm=/,/^    fi$/' "$SINGLEBOX")"
  # An anchor that silently matched nothing would make this vacuous in a NEW
  # way. Make that failure loud instead of green.
  if [ -z "$block" ]; then
    rm -rf "$tmp"
    printf '__NO_BLOCK_EXTRACTED__'
    return
  fi

  local out
  out="$(
    log_info() { :; }
    log_warn() { :; }
    upsert_env() { [ "$1" = "LLM_MODEL" ] && printf '%s' "$2"; }
    local _current_llm _default_dmr_model
    eval "$block"
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

# --- 6b. A remote inference host must not be guessed at ---------------------
#
# OLLAMA_URL is independently overridable, and on the multi-box path nothing
# downstream can repair a wrong runtime: detect_single_box_mode() probes that
# very host, finds it reachable, classifies the box multi-box, and skips
# configure_single_box_env — the only code that would clobber the URL back.
# So `OLLAMA_URL=<remote> ./scripts/setup.sh` would otherwise write a dmr
# runtime and a docker.io/... model id pointed at a remote Ollama.

if grep -qE 'OLLAMA_URL is overridden' "$SECRETS"; then
  ok "setup refuses to guess the runtime when OLLAMA_URL is overridden alone"
else
  bad "no guard: OLLAMA_URL alone would silently provision a dmr runtime at a remote Ollama"
fi

# The documented multi-box command must satisfy the guard it now trips.
if grep -q 'OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh' "$SECRETS" \
   && ! grep -q 'INFERENCE_RUNTIME=ollama OLLAMA_URL=http://192.168.50.197:11434' "$SECRETS"; then
  bad "the documented multi-box command omits INFERENCE_RUNTIME — copy-pasting it now exits 1"
else
  ok "the documented multi-box command names the runtime explicitly"
fi

# --- 6c. The rollback script survives the profile split ---------------------
#
# WARP-1869 moved ollama off the always-active `single-box` profile, which is
# the standby rollback-single-box.sh was built around. It must now swap the
# token and start the container, or it strands the box with no runtime after
# it has already stopped dmr and rewritten both env files.

ROLLBACK="$REPO_ROOT/scripts/dmr/rollback-single-box.sh"
if [ -f "$ROLLBACK" ]; then
  if grep -qE "upsert +\"\\\$f\" +INFERENCE_RUNTIME +\"ollama\"" "$ROLLBACK"; then
    ok "rollback SETS INFERENCE_RUNTIME=ollama (a dropped key re-flips on the next setup run)"
  else
    bad "rollback drops INFERENCE_RUNTIME instead of setting it — the next setup.sh re-flips the box to DMR"
  fi
  if grep -q "newprofiles=\"\${newprofiles:+\$newprofiles,}ollama\"" "$ROLLBACK"; then
    ok "rollback swaps the profile token dmr->ollama (not just deletes dmr)"
  else
    bad "rollback deletes dmr without adding ollama — box ends with NO runtime profile"
  fi
  if grep -q 'dc --profile ollama up -d --no-deps ollama' "$ROLLBACK"; then
    ok "rollback actually starts the ollama container"
  else
    bad "rollback never starts ollama — it is no longer running by default"
  fi
else
  bad "rollback script not found at $ROLLBACK"
fi

# --- 7. The ollama opt-out still writes ollama values -----------------------

if grep -qE 'ollama_url="\$\{OLLAMA_URL:-http://droplet-ollama:11434\}"' "$SECRETS"; then
  ok "INFERENCE_RUNTIME=ollama still provisions the ollama chat URL"
else
  bad "the ollama opt-out path lost its URL default"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
