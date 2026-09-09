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
# WARP-2543 — materialised rather than piped into `grep -q`. With
# `set -o pipefail`, grep -q exits on first match, awk takes SIGPIPE, and the
# pipeline reports 141 — a successful match failing as if it had not matched.
# It is scheduling-dependent, so it passed three local runs and failed CI.
_guard_block="$(awk '/WARP-1865/,/^  fi$/' "$LIB")"
if grep -q 'INFERENCE_RUNTIME' <<<"$_guard_block"; then
  ok "the guard is decided by INFERENCE_RUNTIME (the durable operator property)"
else
  bad "the guard does not read INFERENCE_RUNTIME"
fi

# --- PART 2 (behavioral): extract the merge logic and exercise it ------------
#
# Runs the real code path from the file rather than a copy of it: a test that
# reimplements the logic keeps passing when the fix is reverted.

merged_for() {
  # $1 = existing COMPOSE_PROFILES value, $2 = INFERENCE_RUNTIME value,
  # $3 = GPU_VENDOR (optional; omitted means "not yet detected", which the
  #      shipped block treats as `amd` — the whole installed fleet).
  local existing="$1" runtime="$2" vendor="${3:-}"
  local tmp; tmp="$(mktemp -d)"
  local env_file="$tmp/.env" env_target="$tmp/.env"
  printf 'COMPOSE_PROFILES=%s\n' "$existing" > "$env_file"
  [ -n "$runtime" ] && printf 'INFERENCE_RUNTIME=%s\n' "$runtime" >> "$env_file"
  [ -n "$vendor" ]  && printf 'GPU_VENDOR=%s\n' "$vendor" >> "$env_file"

  # Pull the merge + guard block straight out of the shipped script.
  #
  # WARP-2543 — the end marker is now an explicit sentinel rather than
  # `^  fi$`. The old range broke the moment the block grew an inner `if`:
  # awk stopped at the INNER `fi`, so the extracted text omitted the
  # strip-and-add that actually selects the runtime — and it would still
  # eval cleanly, still emit a plausible string, and still pass. A truncated
  # extraction is worse than a broken one because it is invisible.
  local block
  block="$(awk '/^  existing_profiles=\$\(grep -E/,/END RUNTIME PROFILE SELECTION/' "$LIB")"

  local out
  out="$(
    log_info() { :; }
    log_warn() { :; }
    log_error() { :; }
    # The shipped block resolves the DMR shape through gpu.sh. Source the real
    # one: stubbing it here would let a wrong vendor->profile mapping ship
    # green, which is the exact class of bug WARP-2543 was.
    # shellcheck source=../scripts/lib/gpu.sh
    source "$REPO_ROOT/scripts/lib/gpu.sh"
    local merged_profiles existing_profiles _profiles_runtime
    local _wanted_profile _gpu_vendor
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

# The MIRROR direction — a rollback, not a flip. A box still carrying `dmr`
# whose runtime is now ollama (or unset) must not keep dmr AND gain ollama.
# The exclusion has to be two-directional or it only half-works: the flip
# direction was covered from the start, this one was not, and both tokens
# present is the SINGLE GPU OWNER violation regardless of which way you
# arrived at it.
for rt in ollama ''; do
  label="${rt:-<unset>}"
  got="$(merged_for 'linux,display,eval,single-box,docs,dmr' "$rt")"
  case ",$got," in
    *,dmr,*) bad "rollback direction (runtime=$label): stale dmr NOT stripped — two runtimes, one GPU (got '$got')" ;;
    *)       ok  "rollback direction (runtime=$label): stale dmr stripped (got '$got')" ;;
  esac
  case ",$got," in
    *,ollama,*) ok "rollback direction (runtime=$label): ollama present so the box has a runtime (got '$got')" ;;
    *)          bad "rollback direction (runtime=$label): NO runtime token at all (got '$got')" ;;
  esac
  for p in linux single-box docs; do
    case ",$got," in
      *,"$p",*) : ;;
      *)        bad "rollback direction (runtime=$label): strip dropped '$p' (got '$got')" ;;
    esac
  done
done

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

# ── WARP-2543: the vendor axis ─────────────────────────────────────────────
#
# GPU_VENDOR picks WHICH DMR shape, independently of INFERENCE_RUNTIME picking
# WHICH DAEMON. The failure being designed out is the two disagreeing: a box
# that starts the ROCm service against an NVIDIA card (or the reverse) finds no
# usable device, falls back to CPU, and serves the 20B at ~8 tok/s with every
# healthcheck green. That ran for days on the bench box.

# The installed fleet: AMD silicon keeps the EXACT token it already carries.
# If this ever flips to `dmr-cuda`, every AMD box in the field rewrites its
# COMPOSE_PROFILES on the next setup.sh run and loses inference.
got="$(merged_for 'linux,single-box' 'dmr' 'amd')"
case ",$got," in
  *,dmr,*) ok "GPU_VENDOR=amd: keeps the existing 'dmr' token — installed fleet unaffected (got '$got')" ;;
  *)       bad "GPU_VENDOR=amd: 'dmr' token missing — this would break every AMD box in the field (got '$got')" ;;
esac
case ",$got," in
  *,dmr-cuda,*) bad "GPU_VENDOR=amd: got the NVIDIA profile — ROCm box would start the CUDA service (got '$got')" ;;
  *)            ok  "GPU_VENDOR=amd: dmr-cuda correctly absent (got '$got')" ;;
esac

got="$(merged_for 'linux,single-box' 'dmr' 'nvidia')"
case ",$got," in
  *,dmr-cuda,*) ok "GPU_VENDOR=nvidia: selects 'dmr-cuda' (got '$got')" ;;
  *)            bad "GPU_VENDOR=nvidia: 'dmr-cuda' missing — no inference service would start (got '$got')" ;;
esac
# The one that actually bit: the AMD service wired to an NVIDIA card. Its
# /dev/kfd + render node still RESOLVE (to a 512 MiB integrated GPU), so it
# starts, reports healthy, and serves from CPU.
case ",$got," in
  *,dmr,*) bad "GPU_VENDOR=nvidia: bare 'dmr' present — ROCm service on an NVIDIA card = silent CPU fallback (got '$got')" ;;
  *)       ok  "GPU_VENDOR=nvidia: bare 'dmr' correctly absent (got '$got')" ;;
esac

# Exactly one runtime token, whatever the starting state. This is the property
# the rewrite makes true BY CONSTRUCTION rather than by remembering to strip
# each sibling — with three tokens the pairwise version needs six strips and
# stays one forgotten line from putting two runtimes on one card.
for start in 'linux,dmr' 'linux,dmr-cuda' 'linux,ollama' 'linux,dmr,dmr-cuda,ollama'; do
  for v in amd nvidia; do
    got="$(merged_for "$start" 'dmr' "$v")"
    n="$(printf '%s' "$got" | tr ',' '\n' | grep -cE '^(dmr|dmr-cuda|ollama)$')"
    if [ "$n" = "1" ]; then
      ok "exactly one runtime token from '$start' at vendor=$v (got '$got')"
    else
      bad "$n runtime tokens from '$start' at vendor=$v — single-GPU-owner violation (got '$got')"
    fi
  done
done

# A vendor with no accelerator must NOT silently fall through to a token that
# would serve inference from CPU. Refusing is the correct outcome: 8 tok/s
# reporting healthy is worse than not starting.
# An unclassifiable GPU falls back to the PRE-WARP-2543 token rather than
# aborting: CI, containers and dev laptops all land here, and refusing broke
# every one of them. The warning is the signal; the behaviour is unchanged.
got="$(merged_for 'linux,single-box' 'dmr' 'none')"
case ",$got," in
  *,dmr-cuda,*) bad "GPU_VENDOR=none: selected the NVIDIA profile on unclassified hardware (got '$got')" ;;
  *,dmr,*)      ok  "GPU_VENDOR=none: falls back to the pre-existing 'dmr' token, no abort (got '$got')" ;;
  *)            bad "GPU_VENDOR=none: no runtime profile at all — box would have no inference (got '$got')" ;;
esac

# The pre-existing merge contract must survive.
got="$(merged_for 'linux,display,eval,docs' 'dmr')"
for p in linux display eval docs single-box dmr; do
  case ",$got," in
    *,"$p",*) : ;;
    *) bad "merge dropped '$p' (got '$got')"; continue 2 ;;
  esac
done
ok "existing profiles all preserved alongside single-box + dmr (got '$got')"

# ── the compose half of the invariant ──────────────────────────────────────
#
# Everything above exercises the COMPOSE_PROFILES *string* single-box.sh emits.
# None of it reads docker-compose.yml — so reverting the one line that moved
# `ollama` off the `single-box` profile left every assertion above green while
# restoring the two-runtimes-on-one-GPU shape. The token strip cannot cover it
# either: it operates on COMPOSE_PROFILES, and is structurally incapable of
# stopping a service gated on `single-box`, a token unconditionally active on
# this shape. Assert the compose file directly.

COMPOSE="$REPO_ROOT/docker/docker-compose.yml"
svc_profiles() {
  # The `profiles:` line inside one service block, up to the next service key.
  awk -v s="  $1:" '$0==s{f=1;next} f&&/^  [a-z0-9_-]+:/{exit} f' "$COMPOSE" \
    | grep -oE '^[[:space:]]*profiles: \[.*\]' | head -1
}

if [ -f "$COMPOSE" ]; then
  ollama_profiles="$(svc_profiles ollama)"
  case "$ollama_profiles" in
    *'"ollama"'*)
      ok "compose: ollama is gated on its OWN profile ($ollama_profiles)" ;;
    *'"single-box"'*)
      bad "compose: ollama is back on the single-box profile — it starts beside dmr on every flipped box (SINGLE GPU OWNER, WARP-1826)" ;;
    *)
      bad "compose: could not read ollama's profiles (got '$ollama_profiles')" ;;
  esac

  # The bundle must NOT have followed it off. Dropping single-box from these
  # takes out the router, the switch agent and camera discovery — compose
  # 1783-1791 records that exact edit shipping an outage once already.
  for svc in openwrt switch camera-discovery; do
    prof="$(svc_profiles "$svc")"
    case "$prof" in
      *'"single-box"'*) ok "compose: $svc still carries the single-box profile" ;;
      *)                bad "compose: $svc LOST single-box (got '$prof') — router/switch/cameras would not start" ;;
    esac
  done
else
  bad "compose file not found at $COMPOSE"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
