#!/usr/bin/env bash
# gpu.sh — Accelerator vendor detection and the DMR wiring that follows from it.
# Source this file; do not execute directly.
#
# WARP-2543. Until this file existed the single-box compose hard-wired ONE
# accelerator vendor — AMD/ROCm — into `dmr`: the `-rocm` image tag, /dev/kfd,
# a render node, and ROCR_VISIBLE_DEVICES. That was correct for every box the
# fleet had, and the compose comment beside it said so explicitly:
#
#     "adopt the overlay idiom only if single-box ever ships on non-AMD
#      silicon."
#
# The lab bench box then shipped on non-AMD silicon (an NVIDIA RTX 5060 Ti,
# GB206) and NOTHING fired. The ROCm device paths still resolved — to the AMD
# Raphael *iGPU* with 512 MiB of VRAM — so llama.cpp took `-ngl 999`, found
# nowhere to put 14 GB of weights, and fell back to CPU. Measured on the box:
#
#     prompt eval  12-19 tok/s      (GPU-resident: hundreds to thousands)
#     eval          8.22 tok/s      (GPU-resident: 40-80+)
#
# Every LLM-backed surface — and therefore every agent tool — became "super
# slow", with a green /api/health and 26 healthy containers throughout.
#
# ============================================================================
# THE INVARIANT THIS FILE EXISTS TO HOLD
# ============================================================================
# The accelerator vendor is a THIRD axis, independent of the two the codebase
# already tracks. Do not conflate them (WARP-1926 documents what conflation
# costs):
#
#   INFERENCE_RUNTIME   dmr | ollama    WHICH DAEMON serves inference
#   provider            local | cloud   WHERE inference runs (persisted column)
#   GPU_VENDOR          nvidia|amd|none WHICH SILICON the daemon offloads to
#
# GPU_VENDOR selects a compose PROFILE, not a service name, because profiles
# are how this repo already picks exactly one inference runtime and already
# has a guard enforcing that (single-box.sh). A vendor that maps to no profile
# starts NO inference service at all — loudly — which is the whole point. The
# failure mode being designed out is a runtime that starts and silently serves
# from the wrong device.
#
#   GPU_VENDOR=amd     -> profile `dmr`       -> ROCm image, /dev/kfd + render node
#   GPU_VENDOR=nvidia  -> profile `dmr-cuda`  -> CUDA image, nvidia runtime
#   GPU_VENDOR=none    -> (no dmr profile)    -> refuses; see assert_gpu_ready
#
# 🔴 `amd` KEEPS THE EXISTING `dmr` TOKEN ON PURPOSE. Every box in the field
# today carries COMPOSE_PROFILES=...,dmr and an AMD card. Re-labelling the AMD
# path would have rewritten the profile on every one of them on the next
# setup.sh run — a fleet-wide inference outage to fix one bench box. The new
# token is the NEW case. Existing AMD boxes are bit-for-bit unaffected.

# ---------------------------------------------------------------------------
# detect_gpu_vendor — read the hardware, not the config.
# ---------------------------------------------------------------------------
# Echoes exactly one of: nvidia | amd | none
#
# Deliberately reads the PCI bus rather than trusting a driver to be loaded.
# On the box that prompted this ticket the NVIDIA card was present and had NO
# kernel driver bound at all (`lspci -k` showed no "Kernel driver in use",
# `lsmod` had amdgpu only). A detector keyed on nvidia-smi or /dev/nvidia*
# would have reported "no NVIDIA GPU" on a machine with an NVIDIA GPU in it,
# and we would have "confirmed" the ROCm wiring was right.
#
# Vendor IDs are the stable identifier: 10de = NVIDIA, 1002 = AMD/ATI.
#
# DISCRETE-FIRST. A Ryzen 7000-series host has an AMD Raphael iGPU on the bus
# whether or not a discrete card is fitted, so "an AMD device exists" is not
# evidence of an AMD inference target — that is precisely the false positive
# that made the bench box look correctly configured. A discrete NVIDIA card
# therefore wins over an integrated AMD one. Two discrete cards is not a
# shape this appliance ships, and is left to the operator override.
detect_gpu_vendor() {
  # Operator override always wins, and is how a box with hardware we cannot
  # classify still provisions. Validated, not trusted: a typo must fail loudly
  # here rather than silently select "none" and take inference down.
  if [ -n "${GPU_VENDOR:-}" ]; then
    case "$(printf '%s' "$GPU_VENDOR" | tr '[:upper:]' '[:lower:]')" in
      nvidia|amd|none)
        printf '%s' "$(printf '%s' "$GPU_VENDOR" | tr '[:upper:]' '[:lower:]')"
        return 0
        ;;
      *)
        log_error "GPU_VENDOR='${GPU_VENDOR}' is not one of: nvidia, amd, none"
        return 2
        ;;
    esac
  fi

  if ! command -v lspci >/dev/null 2>&1; then
    # No bus to read (macOS dev shape, a container, a CI runner). "none" is
    # the honest answer; it is the caller's job to decide whether that is
    # fatal, and on a dev shape it is not.
    printf 'none'
    return 0
  fi

  # -n keeps numeric vendor:device IDs so this does not depend on the host's
  # pci.ids vintage — a fresh Blackwell card on an older pci.ids prints as
  # "Device 2d04" with no marketing name, which a name-based grep would miss.
  _gpu_pci="$(lspci -nn 2>/dev/null | grep -iE 'VGA compatible controller|3D controller|Display controller' || true)"

  # 3D controller = a discrete accelerator with no display attached, which is
  # how a headless compute card presents. Check NVIDIA first per DISCRETE-FIRST.
  if printf '%s' "$_gpu_pci" | grep -qiE '\[10de:'; then
    printf 'nvidia'
    return 0
  fi

  if printf '%s' "$_gpu_pci" | grep -qiE '\[1002:'; then
    printf 'amd'
    return 0
  fi

  printf 'none'
  return 0
}

# ---------------------------------------------------------------------------
# dmr_profile_for_vendor / dmr_image_for_vendor
# ---------------------------------------------------------------------------
# The two things that must move together. They are separate functions but a
# caller that uses one without the other produces exactly the bug this ticket
# is about: the CUDA profile running the ROCm image, or vice versa. The
# single caller is configure_gpu_env below; keep it that way.
dmr_profile_for_vendor() {
  case "${1:-none}" in
    nvidia) printf 'dmr-cuda' ;;
    amd)    printf 'dmr' ;;
    *)      printf '' ;;
  esac
}

# The tag suffix is the ONLY difference between these images, and picking the
# wrong one is not a degraded mode — it is a silent 10x. The bare tag is the
# CPU-only build; it is never selected here, and DMR_IMAGE_CPU_OPT_IN below is
# the only way to reach it.
dmr_image_for_vendor() {
  _dmr_ver="${DMR_IMAGE_VERSION:-v1.2.6}"
  case "${1:-none}" in
    nvidia) printf 'docker/model-runner:%s-cuda' "$_dmr_ver" ;;
    amd)    printf 'docker/model-runner:%s-rocm' "$_dmr_ver" ;;
    *)      printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# assert_dmr_image_is_accelerated — the guard for the fault that actually
# took the box down.
# ---------------------------------------------------------------------------
# The bench box was not misconfigured by this repo. Someone pinned
# `DMR_IMAGE=docker/model-runner:v1.2.6` — the bare, CPU-ONLY tag — into
# docker/.env by hand, defeating the compose default. Compose's own comment
# had predicted the consequence: "bare v1.2.6 is CPU-only and presents as a
# catastrophic-looking perf regression rather than as an error."
#
# So: a DMR_IMAGE with no accelerator suffix is refused. An operator who
# genuinely wants CPU inference (a dev laptop, a hardware-less CI shape) sets
# DMR_IMAGE_CPU_OPT_IN=1 and says so out loud. Returns 0 = ok, 1 = refuse.
assert_dmr_image_is_accelerated() {
  _img="${1:-}"
  [ -z "$_img" ] && return 0

  case "$_img" in
    *-cuda|*-cuda-*|*-rocm|*-rocm-*|*-musa|*-openvino|*vllm*|*sglang*)
      return 0 ;;
  esac

  if [ "${DMR_IMAGE_CPU_OPT_IN:-0}" = "1" ]; then
    log_warn "DMR_IMAGE='${_img}' has no accelerator suffix — CPU-only inference, allowed by DMR_IMAGE_CPU_OPT_IN=1."
    return 0
  fi

  log_error "DMR_IMAGE='${_img}' is a CPU-ONLY image tag."
  log_error "  On this hardware that is a ~10x slowdown that reports as healthy, not as an error."
  log_error "  Expected an accelerated tag (…-cuda on NVIDIA, …-rocm on AMD)."
  log_error "  If CPU inference is genuinely intended, set DMR_IMAGE_CPU_OPT_IN=1."
  return 1
}

# ---------------------------------------------------------------------------
# configure_gpu_env — write the detected vendor and everything downstream.
# ---------------------------------------------------------------------------
# Called from configure_single_box_env. Idempotent; safe to re-run.
#
# Writes GPU_VENDOR so the decision is INSPECTABLE after the fact. The reason
# this outage cost days is that no artefact on the box recorded which
# accelerator the stack believed it had — the only way to find out was to read
# llama.cpp's tok/s and infer backwards.
configure_gpu_env() {
  _env_target="${1:?configure_gpu_env: env file required}"

  _vendor="$(detect_gpu_vendor)" || return 1
  upsert_env GPU_VENDOR "$_vendor"

  # Only DMR boxes have a vendor-selected profile; an Ollama box keeps its own
  # wiring, which this ticket deliberately does not touch.
  _runtime="$(grep -E '^INFERENCE_RUNTIME=' "$_env_target" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]' || true)"
  [ "$_runtime" = "dmr" ] || return 0

  _image="$(dmr_image_for_vendor "$_vendor")"
  if [ -z "$_image" ]; then
    # NO CLASSIFIABLE GPU. Three very different situations produce this and
    # lspci alone cannot tell them apart:
    #
    #   a) an appliance whose card died or was removed   <- must be loud
    #   b) a CI runner / container / dev laptop          <- must NOT be fatal
    #   c) a VM with no PCI GPU at all                   <- must NOT be fatal
    #
    # An earlier revision of this function returned 1 here. That is the
    # "correct" posture for (a) and it broke (b) and (c) completely: setup.sh
    # aborts inside configure_single_box_env, and 33 previously-green unit
    # tests went red because every knob written after this point stopped being
    # written. Taking CI and every dev machine down to catch a dead GPU is a
    # bad trade, and a guard that everyone has to work around is a guard that
    # gets deleted.
    #
    # So: WARN, change nothing, and let the compose default stand — i.e. the
    # exact behaviour that shipped before this ticket. Provisioning that
    # genuinely requires a GPU opts into the hard failure with
    # DROPLET_REQUIRE_GPU=1.
    #
    # This is NOT the guard that catches WARP-2543 anyway. Two others do, and
    # both stay hard: assert_dmr_image_is_accelerated refuses the CPU-only
    # image tag (the value that actually caused the outage), and dmr-cuda's
    # nvidia-smi healthcheck turns a GPU-less NVIDIA box unhealthy instead of
    # letting it serve from CPU while green.
    if [ "${DROPLET_REQUIRE_GPU:-0}" = "1" ]; then
      log_error "INFERENCE_RUNTIME=dmr but no GPU was detected (GPU_VENDOR=${_vendor}), and DROPLET_REQUIRE_GPU=1."
      log_error "  Refusing to provision DMR onto CPU inference."
      return 1
    fi
    log_warn "No GPU detected (GPU_VENDOR=${_vendor}) but INFERENCE_RUNTIME=dmr."
    log_warn "  Leaving DMR_IMAGE to the compose default. On real hardware this means CPU inference"
    log_warn "  (~8 tok/s on a 20B — WARP-2543). Set DROPLET_REQUIRE_GPU=1 to make this fatal."
    return 0
  fi

  # An operator DMR_IMAGE override still wins — but only after passing the
  # accelerated-tag guard, which is the check that was missing.
  if [ -n "${DMR_IMAGE:-}" ]; then
    assert_dmr_image_is_accelerated "$DMR_IMAGE" || return 1
    upsert_env DMR_IMAGE "$DMR_IMAGE"
  else
    upsert_env DMR_IMAGE "$_image"
  fi

  log_info "GPU: detected ${_vendor} — DMR profile '$(dmr_profile_for_vendor "$_vendor")', image '$(grep -E '^DMR_IMAGE=' "$_env_target" | tail -1 | cut -d= -f2-)'"
  return 0
}
