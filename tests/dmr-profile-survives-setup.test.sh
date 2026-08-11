#!/usr/bin/env bash
# =============================================================================
# WARP-1865 — a setup re-run must not un-flip a DMR box by half.
# =============================================================================
#
# THE INVARIANT:
#   When INFERENCE_RUNTIME=dmr, the COMPOSE_PROFILES that setup writes MUST
#   contain `dmr`.
#
# WHY (this shipped, and it is a silent inference outage):
#   The flip lives in two halves and they were written to two different files.
#
#     scripts/dmr/flip-single-box.sh  upserts COMPOSE_PROFILES=...,dmr into
#                                     docker/.env
#     scripts/setup.sh                runs compose with
#                                     --env-file "$REPO_ROOT/.env"
#
#   The WARP-1772 guard preserves the DMR *URLs* on a re-run
#   (OLLAMA_URL=http://dmr:12434, RAGAS_OLLAMA_URL, LLM_MODEL) but the
#   *profile* was left to the flip runbook. So a re-run against the root .env:
#
#     - starts ollama          (at the time, ollama rode the `single-box`
#                               profile, which is always active on this shape)
#     - does NOT start dmr     (its profile is `dmr`, absent)
#     - keeps OLLAMA_URL=http://dmr:12434, now dangling
#
#   Chat, the RAGAS judge and LLM_MODEL all point at a container that is not
#   running, and setup logs success. Measured on the appliance: the root .env
#   had `linux,display,eval,single-box,docs` while docker/.env had the same
#   plus `dmr`.
#
#   This is the same un-flip failure the URL guard was written to stop
#   (single-box.sh's own comment calls it "the flip audit's nastiest finding:
#   a factory re-provision that un-flips the box") arriving through the other
#   half of the flip.
#
# The counterpart matters as much: a box that is NOT flipped must never gain
# the dmr profile. An accidental flip is as bad as an accidental un-flip.
#
# Static + behavioral; needs no docker, no root, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1865: dmr profile survives a setup re-run ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

# --- PART 1 (static): the guard exists and is gated on INFERENCE_RUNTIME -----

if grep -q 'WARP-1865' "$LIB"; then
  ok "single-box.sh carries the WARP-1865 profile guard"
else
  bad "single-box.sh has no WARP-1865 guard — a re-run will drop the dmr profile"
fi

# The guard must key off INFERENCE_RUNTIME, not off whatever profiles happen to
# be present: reading the profile list to decide the profile list cannot
# recover a box whose root .env already lost `dmr`, which is the broken state.
if awk '/WARP-1865/,/^  fi$/' "$LIB" | grep -q 'INFERENCE_RUNTIME'; then
  ok "the guard is decided by INFERENCE_RUNTIME (the durable operator property)"
else
  bad "the guard does not read INFERENCE_RUNTIME"
fi

# --- PART 2 (behavioral): extract the merge logic and exercise it ------------
#
# Runs the real code path from the file rather than a copy of it: a test that
# reimplements the logic keeps passing when the fix is reverted.

merged_for() {
  # $1 = existing COMPOSE_PROFILES value, $2 = INFERENCE_RUNTIME value
  local existing="$1" runtime="$2"
  local tmp; tmp="$(mktemp -d)"
  local env_file="$tmp/.env" env_target="$tmp/.env"
  printf 'COMPOSE_PROFILES=%s\n' "$existing" > "$env_file"
  [ -n "$runtime" ] && printf 'INFERENCE_RUNTIME=%s\n' "$runtime" >> "$env_file"

  # Pull the merge + guard block straight out of the shipped script.
  local block
  block="$(awk '/^  existing_profiles=\$\(grep -E/,/^  fi$/' "$LIB")"

  local out
  out="$(
    log_info() { :; }
    local merged_profiles existing_profiles _profiles_runtime
    eval "$block"
    printf '%s' "$merged_profiles"
  )"
  rm -rf "$tmp"
  printf '%s' "$out"
}

got="$(merged_for 'linux,display,eval,single-box,docs' 'dmr')"
case ",$got," in
  *,dmr,*) ok "flipped box: dmr preserved (got '$got')" ;;
  *)       bad "flipped box: dmr MISSING — inference would point at a stopped container (got '$got')" ;;
esac

got="$(merged_for 'linux,display,eval,single-box,docs' 'ollama')"
case ",$got," in
  *,dmr,*) bad "un-flipped box: dmr was ADDED — an accidental flip (got '$got')" ;;
  *)       ok  "un-flipped box: dmr correctly absent (got '$got')" ;;
esac

got="$(merged_for 'linux,display' '')"
case ",$got," in
  *,dmr,*) bad "no INFERENCE_RUNTIME: dmr was added (got '$got')" ;;
  *)       ok  "no INFERENCE_RUNTIME: dmr correctly absent (got '$got')" ;;
esac

# ── mutual exclusion: exactly ONE inference runtime token ──────────────────
#
# `ollama` moved off the `single-box` profile onto its own, so the runtime is
# now chosen by a single token. Two failure modes matter equally: a box with
# BOTH tokens puts two runtimes on one card (SINGLE GPU OWNER, WARP-1826 — the
# WARP-1824 shape where a 20B model landed 0/25 layers on the GPU and served
# from CPU), and a box with NEITHER has no inference at all.

got="$(merged_for 'linux,display,eval,single-box,docs' 'ollama')"
case ",$got," in
  *,ollama,*) ok "un-flipped box: ollama profile added — the box has a runtime (got '$got')" ;;
  *)          bad "un-flipped box: NO runtime profile — box would start with no inference (got '$got')" ;;
esac

got="$(merged_for 'linux,display,eval,single-box,docs' 'dmr')"
case ",$got," in
  *,ollama,*) bad "flipped box: ollama present alongside dmr — two runtimes, one GPU (got '$got')" ;;
  *)          ok  "flipped box: ollama correctly absent (got '$got')" ;;
esac

# A half-finished flip leaves ollama in the list while INFERENCE_RUNTIME=dmr.
# Both tokens present is the one outcome worse than either alone, so the guard
# must strip the loser rather than merely skip adding it.
got="$(merged_for 'linux,single-box,ollama' 'dmr')"
case ",$got," in
  *,ollama,*) bad "half-flipped box: stale ollama NOT stripped (got '$got')" ;;
  *)          ok  "half-flipped box: stale ollama stripped (got '$got')" ;;
esac
case ",$got," in
  *,dmr,*) ok "half-flipped box: dmr present after the strip (got '$got')" ;;
  *)       bad "half-flipped box: strip removed dmr too (got '$got')" ;;
esac
# The strip must not eat the unrelated profiles around it.
for p in linux single-box; do
  case ",$got," in
    *,"$p",*) : ;;
    *)        bad "half-flipped box: strip dropped '$p' (got '$got')" ;;
  esac
done

got="$(merged_for 'linux,single-box,ollama' 'ollama')"
count="$(printf '%s' "$got" | tr ',' '\n' | grep -c '^ollama$')"
if [ "$count" = "1" ]; then
  ok "idempotent: ollama appears exactly once on re-run (got '$got')"
else
  bad "ollama appears $count times — re-running setup duplicates it (got '$got')"
fi

got="$(merged_for 'linux,display' '')"
case ",$got," in
  *,ollama,*) ok "no INFERENCE_RUNTIME: defaults to the ollama runtime (got '$got')" ;;
  *)          bad "no INFERENCE_RUNTIME: no runtime profile at all (got '$got')" ;;
esac

# Idempotency — a second run must not duplicate the entry.
got="$(merged_for 'linux,single-box,dmr' 'dmr')"
count="$(printf '%s' "$got" | tr ',' '\n' | grep -c '^dmr$')"
if [ "$count" = "1" ]; then
  ok "idempotent: dmr appears exactly once on re-run (got '$got')"
else
  bad "dmr appears $count times — re-running setup duplicates it (got '$got')"
fi

# The pre-existing merge contract must survive.
got="$(merged_for 'linux,display,eval,docs' 'dmr')"
for p in linux display eval docs single-box dmr; do
  case ",$got," in
    *,"$p",*) : ;;
    *) bad "merge dropped '$p' (got '$got')"; continue 2 ;;
  esac
done
ok "existing profiles all preserved alongside single-box + dmr (got '$got')"

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
