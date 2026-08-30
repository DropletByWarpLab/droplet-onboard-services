#!/usr/bin/env bash
# =============================================================================
# WARP-2543 — the accelerator vendor decides the DMR shape, and a CPU-only
# image tag is refused.
# =============================================================================
#
# WHAT SHIPPED, AND WHAT IT COST:
#   The lab bench box had an NVIDIA RTX 5060 Ti (GB206) fitted. Nothing in the
#   stack knew. Three faults stacked:
#
#     1. docker/.env carried DMR_IMAGE=docker/model-runner:v1.2.6 — the BARE
#        tag, which is the CPU-ONLY build. Hand-pinned, defeating the compose
#        default. Compose's own comment had predicted the consequence:
#        "bare v1.2.6 is CPU-only and presents as a catastrophic-looking perf
#        regression rather than as an error."
#     2. compose still handed DMR the AMD ROCm devices (/dev/kfd + a render
#        node). Those still RESOLVED — to the AMD Raphael *integrated* GPU
#        with 512 MiB of VRAM.
#     3. No driver was bound to the NVIDIA card at all, and Docker had no
#        nvidia runtime.
#
#   Result, measured on the box: prompt eval 12-19 tok/s, generation
#   8.22 tok/s on a 20.91B model. Roughly a tenth of GPU speed. Every
#   container healthy, /api/health green, for days. The only symptom was a
#   human saying "the tools feel slow".
#
# THE INVARIANTS UNDER TEST:
#   1. Vendor detection reads HARDWARE, and an unusable/absent accelerator is
#      reported honestly rather than defaulted into a working-looking value.
#   2. The profile and the image for a vendor always agree.
#   3. A DMR_IMAGE with no accelerator suffix is REFUSED, because that is the
#      single value that caused the outage.
#
# Static + behavioral; no docker, no root, no network, no GPU required.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/gpu.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-2543: GPU vendor selection + CPU-image refusal ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

# Silence the lib's logging without stubbing anything it computes.
log_info() { :; }
log_warn() { :; }
log_error() { :; }
# shellcheck source=../scripts/lib/gpu.sh
source "$LIB"

# --- 1. profile <-> image agreement -----------------------------------------
#
# These two functions are separate but must never disagree. A CUDA profile
# running the ROCm image is the same bug class as the original incident, just
# arriving from the config side instead of the hardware side.

for v in amd nvidia; do
  prof="$(dmr_profile_for_vendor "$v")"
  img="$(dmr_image_for_vendor "$v")"
  case "$v:$prof:$img" in
    amd:dmr:*-rocm)         ok "amd -> profile 'dmr' + rocm image ($img)" ;;
    nvidia:dmr-cuda:*-cuda) ok "nvidia -> profile 'dmr-cuda' + cuda image ($img)" ;;
    *)                      bad "vendor '$v' maps to profile '$prof' + image '$img' — profile and image disagree" ;;
  esac
done

# `none` must produce NOTHING, not a plausible-looking default. A default here
# would reintroduce the whole bug: something starts, finds no device, serves
# from CPU, reports healthy.
if [ -z "$(dmr_profile_for_vendor none)" ] && [ -z "$(dmr_image_for_vendor none)" ]; then
  ok "vendor 'none' yields no profile and no image (refuses rather than guesses)"
else
  bad "vendor 'none' produced a profile/image — a GPU-less box would provision DMR onto CPU"
fi

# 🔴 The AMD token must stay `dmr`. Every box in the field carries it. If this
# is ever renamed, all of them rewrite COMPOSE_PROFILES on the next setup.sh
# run and lose inference — a fleet outage to fix one bench box.
if [ "$(dmr_profile_for_vendor amd)" = "dmr" ]; then
  ok "AMD profile token is still exactly 'dmr' (installed fleet unaffected)"
else
  bad "AMD profile token changed — this rewrites COMPOSE_PROFILES on every deployed AMD box"
fi

# --- 2. the CPU-image refusal — the guard for the actual root cause ----------
#
# Each of these is a tag that really exists upstream. The bare one is the tag
# that was actually pinned on the box.

check_img() {
  # $1 = image, $2 = expected (accept|refuse), $3 = label
  ( DMR_IMAGE_CPU_OPT_IN=0; assert_dmr_image_is_accelerated "$1" >/dev/null 2>&1 )
  rc=$?
  if [ "$2" = "accept" ] && [ "$rc" -eq 0 ]; then ok "$3"
  elif [ "$2" = "refuse" ] && [ "$rc" -ne 0 ]; then ok "$3"
  else bad "$3 (rc=$rc, expected $2)"; fi
}

check_img "docker/model-runner:v1.2.6"       refuse "REFUSES the bare CPU-only tag — the exact value that caused WARP-2543"
check_img "docker/model-runner:v1.2.6-cuda"  accept "accepts the CUDA tag"
check_img "docker/model-runner:v1.2.6-rocm"  accept "accepts the ROCm tag"
check_img "docker/model-runner:latest"       refuse "REFUSES a floating bare tag"
check_img "docker/model-runner:v1.2.0-musa"  accept "accepts other accelerated builds (musa)"
check_img "docker/model-runner:v1.2.0-vllm-cuda" accept "accepts vllm-cuda"

# The opt-in exists so a dev laptop / hardware-less CI shape can still run,
# but it must be EXPLICIT. Silence is what let the outage persist.
( DMR_IMAGE_CPU_OPT_IN=1; assert_dmr_image_is_accelerated "docker/model-runner:v1.2.6" >/dev/null 2>&1 )
if [ $? -eq 0 ]; then
  ok "DMR_IMAGE_CPU_OPT_IN=1 allows the CPU image (deliberate, opt-in)"
else
  bad "DMR_IMAGE_CPU_OPT_IN=1 did not allow the CPU image — no escape hatch for dev shapes"
fi

# --- 3. detection reads hardware, and validates an override ------------------
#
# A typo'd override must FAIL rather than silently degrade to 'none' (which
# would take inference down on a box that has a perfectly good GPU).
out="$( GPU_VENDOR=nvidia detect_gpu_vendor )"
[ "$out" = "nvidia" ] && ok "override GPU_VENDOR=nvidia honoured" || bad "override not honoured (got '$out')"

out="$( GPU_VENDOR=NVIDIA detect_gpu_vendor )"
[ "$out" = "nvidia" ] && ok "override is case-insensitive" || bad "override case handling (got '$out')"

( GPU_VENDOR=nvidai detect_gpu_vendor >/dev/null 2>&1 )
[ $? -ne 0 ] && ok "a typo'd GPU_VENDOR is REFUSED, not silently treated as 'none'" \
             || bad "typo'd GPU_VENDOR accepted — would silently disable the GPU"

# Detection must not depend on a driver being loaded. On the box that prompted
# this ticket the NVIDIA card was present with NO kernel driver bound, so a
# detector keyed on nvidia-smi or /dev/nvidia* would have reported "no NVIDIA
# GPU" on a machine that had one — and confirmed the wrong wiring as correct.
if grep -vE '^\s*#' "$LIB" | grep -qE 'nvidia-smi|/dev/nvidia'; then
  bad "detect_gpu_vendor keys off a loaded driver — it must read the PCI bus"
else
  ok "detection does not depend on a loaded driver (reads the PCI bus)"
fi

# It must key on stable numeric vendor IDs, not marketing names: a card newer
# than the host's pci.ids prints as "Device 2d04" with no name at all.
if grep -q '10de' "$LIB" && grep -q '1002' "$LIB"; then
  ok "detection keys on numeric PCI vendor IDs (10de/1002), not marketing names"
else
  bad "detection does not use numeric vendor IDs — a new card with no pci.ids entry would be missed"
fi

# --- 4. configure_gpu_env: what is fatal, and what is only loud --------------
tmp="$(mktemp -d)"
printf 'INFERENCE_RUNTIME=dmr\n' > "$tmp/.env"
upsert_env() { printf '%s=%s\n' "$1" "$2" >> "$tmp/.env"; }

# An unclassifiable GPU is NOT fatal by default. A CI runner, a container and a
# dev laptop all land here. An earlier revision of this fix returned non-zero,
# which aborted configure_single_box_env on every one of those shapes — 33
# previously-green unit tests went red because every knob written after that
# point stopped being written. A guard everyone has to work around gets
# deleted, so this one warns instead.
( GPU_VENDOR=none configure_gpu_env "$tmp/.env" >/dev/null 2>&1 )
[ $? -eq 0 ] && ok "no GPU: warns and continues (CI, containers and dev machines still provision)" \
             || bad "no GPU: aborted — this breaks CI, containers and every dev machine"

# But it must not INVENT an image it cannot justify: writing one here would be
# picking an accelerator at random on hardware we failed to classify.
if grep -q '^DMR_IMAGE=' "$tmp/.env"; then
  bad "no GPU: a DMR_IMAGE was written anyway — guessing an accelerator we could not detect"
else
  ok "no GPU: no DMR_IMAGE written (compose default stands, behaviour unchanged)"
fi

# Appliance provisioning that genuinely cannot proceed without a GPU opts in.
( GPU_VENDOR=none DROPLET_REQUIRE_GPU=1 configure_gpu_env "$tmp/.env" >/dev/null 2>&1 )
[ $? -ne 0 ] && ok "no GPU + DROPLET_REQUIRE_GPU=1: REFUSES (opt-in strict mode)" \
             || bad "DROPLET_REQUIRE_GPU=1 did not refuse a GPU-less DMR box"

( GPU_VENDOR=nvidia DMR_IMAGE=docker/model-runner:v1.2.6 configure_gpu_env "$tmp/.env" >/dev/null 2>&1 )
[ $? -ne 0 ] && ok "configure_gpu_env REFUSES an operator-pinned CPU-only DMR_IMAGE" \
             || bad "a hand-pinned CPU image was accepted — this is exactly how WARP-2543 shipped"
rm -rf "$tmp"

# --- 5. compose wiring matches the vendor model ------------------------------
#
# Everything above tests shell functions. None of it reads docker-compose.yml,
# so reverting the compose half would leave all of it green — the WARP-1870
# lesson (a fix whose only behaviour change has no test).
COMPOSE="$REPO_ROOT/docker/docker-compose.yml"

if grep -qE '^  dmr-cuda:' "$COMPOSE"; then
  ok "compose declares the dmr-cuda service"
else
  bad "compose has no dmr-cuda service — GPU_VENDOR=nvidia would select a profile that starts nothing"
fi

if awk '/^  dmr-cuda:/,/^  inference-manager:/' "$COMPOSE" | grep -q 'profiles: \["dmr-cuda"\]'; then
  ok "dmr-cuda is gated on its own profile"
else
  bad "dmr-cuda is not gated on the dmr-cuda profile"
fi

# The alias is load-bearing: every consumer dials http://dmr:12434.
if awk '/^  dmr-cuda:/,/^  inference-manager:/' "$COMPOSE" | grep -qE '^ +- dmr$'; then
  ok "dmr-cuda carries the 'dmr' network alias (consumers dial http://dmr:12434)"
else
  bad "dmr-cuda has no 'dmr' network alias — every consumer would fail to resolve it"
fi

# The AMD service must NOT have gained NVIDIA wiring, and must keep its own.
if awk '/^  dmr:/,/^  dmr-cuda:/' "$COMPOSE" | grep -q '/dev/kfd'; then
  ok "the AMD 'dmr' service still wires /dev/kfd (unchanged for the installed fleet)"
else
  bad "the AMD 'dmr' service lost its ROCm device wiring"
fi

if awk '/^  dmr:/,/^  dmr-cuda:/' "$COMPOSE" | grep -q 'runtime: nvidia'; then
  bad "the AMD 'dmr' service gained 'runtime: nvidia' — it would fail to start on every AMD box"
else
  ok "the AMD 'dmr' service has no nvidia runtime (correctly untouched)"
fi

# The GPU-residency healthcheck is the fail-loud half of this ticket. Without
# it, an NVIDIA box that loses its driver goes back to silent CPU inference.
if awk '/^  dmr-cuda:/,/^  inference-manager:/' "$COMPOSE" | grep -q 'nvidia-smi'; then
  ok "dmr-cuda healthcheck asserts GPU visibility (silent CPU fallback becomes unhealthy)"
else
  bad "dmr-cuda has no GPU-residency healthcheck — a CPU fallback would still report healthy"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
