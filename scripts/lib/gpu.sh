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
# are how this repo already picks exactly one inference runtime and already has
# a guard enforcing that (single-box.sh).
#
#   GPU_VENDOR=amd     -> profile `dmr`       -> ROCm image, /dev/kfd + render node
#   GPU_VENDOR=nvidia  -> profile `dmr-cuda`  -> CUDA image, nvidia runtime
#   GPU_VENDOR=none    -> no DMR profile selected
#
# 🔴 `amd` KEEPS THE EXISTING `dmr` TOKEN ON PURPOSE. Every box in the field
# today carries COMPOSE_PROFILES=...,dmr and an AMD card. Re-labelling the AMD
# path would have rewritten the profile on every one of them on the next
# setup.sh run — a fleet-wide inference outage to fix one bench box. The new
# token is the NEW case. Existing AMD boxes are bit-for-bit unaffected.

# ---------------------------------------------------------------------------
# gpu_vendor_from_bus — read the hardware, nothing else.
# ---------------------------------------------------------------------------
# Echoes exactly one of: nvidia | amd | none
#
# Reads the PCI bus rather than trusting a driver to be loaded. On the box that
# prompted this ticket the NVIDIA card was present and had NO kernel driver
# bound at all (`lspci -k` showed no "Kernel driver in use", `lsmod` had amdgpu
# only). A detector keyed on nvidia-smi or /dev/nvidia* would have reported "no
# NVIDIA GPU" on a machine with an NVIDIA GPU in it, and we would have
# "confirmed" the ROCm wiring was right.
#
# Vendor IDs are the stable identifier: 10de = NVIDIA, 1002 = AMD/ATI. Numeric,
# because a card newer than the host's pci.ids prints as "Device 2d04" with no
# marketing name at all — which is exactly what the RTX 5060 Ti did here.
#
# DISCRETE-FIRST. A Ryzen 7000-series host has an AMD Raphael iGPU on the bus
# whether or not a discrete card is fitted, so "an AMD device exists" is not
# evidence of an AMD inference target — that is precisely the false positive
# that made the bench box look correctly configured.
gpu_vendor_from_bus() {
  # 🔴 NO PIPES INTO `grep -q` IN THIS FUNCTION. Under `set -o pipefail` (which
  # setup.sh sets), `grep -q` exits the instant it matches, the writer takes
  # SIGPIPE and dies 141, and pipefail promotes 141 to the pipeline's status.
  # Inside an `if`, `set -e` is suppressed but the non-zero status still routes
  # to the ELSE branch — so a SUCCESSFUL NVIDIA match would fall through to the
  # AMD test and classify an NVIDIA box as `amd`, hand it the ROCm image, and
  # reproduce WARP-2543 exactly. This function previously used
  # `printf … | grep -qiE`: the same trap this change removed from its own test
  # files, left in the one function whose whole job is to read the silicon.
  # `case` on an already-materialised string has no pipe and no race.
  if ! command -v lspci >/dev/null 2>&1; then
    # No bus to read (macOS dev shape, a container, a CI runner). "none" is the
    # honest answer; the caller decides whether that is fatal, and on a dev
    # shape it is not.
    printf 'none'
    return 0
  fi

  _gpu_pci="$(lspci -nn 2>/dev/null | grep -iE 'VGA compatible controller|3D controller|Display controller' | tr '[:upper:]' '[:lower:]' || true)"

  # "3D controller" is how a headless compute card with no display attached
  # presents. Check NVIDIA first, per DISCRETE-FIRST.
  case "$_gpu_pci" in
    *'[10de:'*) printf 'nvidia'; return 0 ;;
  esac
  case "$_gpu_pci" in
    *'[1002:'*) printf 'amd'; return 0 ;;
  esac

  printf 'none'
  return 0
}

# ---------------------------------------------------------------------------
# detect_gpu_vendor — the bus, unless a HUMAN said otherwise.
# ---------------------------------------------------------------------------
# 🔴 THE OVERRIDE KEY IS `GPU_VENDOR_OVERRIDE`, NOT `GPU_VENDOR`, AND THE TWO
# MUST NEVER BE MERGED. configure_gpu_env persists GPU_VENDOR into .env, and
# `materialize_artifacts` (scripts/lib/secrets.sh) does
# `set -a; . "$REPO_ROOT/.env"; set +a` at scripts/setup.sh:437 — fourteen
# lines BEFORE configure_single_box_env at :451. So from the second setup run
# onward the box's own stored GPU_VENDOR is already an exported shell variable
# by the time detection looks at it.
#
# Treating that as an "operator override" meant detection read its own previous
# output and never touched the PCI bus again: hardware detection would have run
# exactly once per box, and an AMD->NVIDIA swap — the precise event that caused
# WARP-2543 — would have kept the box on the ROCm path for ever. The override
# has to come from a key setup.sh does not itself write.
detect_gpu_vendor() {
  _ovr="${GPU_VENDOR_OVERRIDE:-}"
  if [ -n "$_ovr" ]; then
    # Validated, not trusted: a typo must fail loudly rather than silently
    # select "none" and take inference down on a box with a working GPU.
    _ovr="$(printf '%s' "$_ovr" | tr '[:upper:]' '[:lower:]')"
    case "$_ovr" in
      nvidia|amd|none) printf '%s' "$_ovr"; return 0 ;;
      *) log_error "GPU_VENDOR_OVERRIDE='${GPU_VENDOR_OVERRIDE}' is not one of: nvidia, amd, none"
         return 2 ;;
    esac
  fi
  gpu_vendor_from_bus
}

# ---------------------------------------------------------------------------
# dmr_profile_for_vendor / dmr_image_for_vendor
# ---------------------------------------------------------------------------
# The two things that must move together. A caller that uses one without the
# other produces exactly the bug this ticket is about: the CUDA profile running
# the ROCm image, or the reverse.
dmr_profile_for_vendor() {
  case "${1:-none}" in
    nvidia) printf 'dmr-cuda' ;;
    amd)    printf 'dmr' ;;
    *)      printf '' ;;
  esac
}

# The tag suffix is the ONLY difference between these images, and picking the
# wrong one is not a degraded mode — it is a silent 10x.
dmr_image_for_vendor() {
  _dmr_ver="${DMR_IMAGE_VERSION:-v1.2.6}"
  case "${1:-none}" in
    nvidia) printf 'docker/model-runner:%s-cuda' "$_dmr_ver" ;;
    amd)    printf 'docker/model-runner:%s-rocm' "$_dmr_ver" ;;
    *)      printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# dmr_image_tag / dmr_tag_vendor — classify an image reference by its TAG.
# ---------------------------------------------------------------------------
# 🔴 The suffix globs must NOT be applied to the whole reference. Doing so was
# wrong in both directions:
#   FALSE REFUSE  a digest-pinned accelerated image
#                 `docker/model-runner:v1.2.6-cuda@sha256:…` does not END in
#                 `-cuda`, so a correctly-pinned, supply-chain-hardened image
#                 was refused — and that refusal aborted provisioning.
#   FALSE ACCEPT  any registry host or repo segment containing `-cuda-`
#                 (a mirror such as `registry.example.com/nv-cuda-mirror/
#                 model-runner:v1.2.6`) matched `*-cuda-*` and waved the BARE
#                 CPU-ONLY tag straight through — the WARP-2543 value itself.
dmr_image_tag() {
  _ref="${1:-}"
  _ref="${_ref%@*}"                 # drop @sha256:… if present
  case "$_ref" in
    *:*)
      _maybe="${_ref##*:}"
      case "$_maybe" in
        */*) printf '' ;;           # that colon was a registry:port, not a tag
        *)   printf '%s' "$_maybe" ;;
      esac
      ;;
    *) printf '' ;;                 # no tag at all (implicit :latest)
  esac
}

# nvidia | amd | other | '' (= not an accelerated tag)
dmr_tag_vendor() {
  case "${1:-}" in
    *cuda*)                     printf 'nvidia' ;;
    *rocm*)                     printf 'amd' ;;
    *musa*|*openvino*|*sglang*) printf 'other' ;;
    *)                          printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# assert_dmr_image_is_accelerated — the guard for the fault that took the box
# down. Returns 0 = ok, 1 = refuse.
# ---------------------------------------------------------------------------
# Someone pinned `DMR_IMAGE=docker/model-runner:v1.2.6` — the bare, CPU-ONLY
# tag — into docker/.env by hand, defeating the compose default. Compose's own
# comment had predicted the consequence: "bare v1.2.6 is CPU-only and presents
# as a catastrophic-looking perf regression rather than as an error."
assert_dmr_image_is_accelerated() {
  _img="${1:-}"
  [ -z "$_img" ] && return 0

  _tag="$(dmr_image_tag "$_img")"
  [ -n "$(dmr_tag_vendor "$_tag")" ] && return 0

  if [ "${DMR_IMAGE_CPU_OPT_IN:-0}" = "1" ]; then
    log_warn "DMR_IMAGE='${_img}' has no accelerator suffix — CPU-only inference, allowed by DMR_IMAGE_CPU_OPT_IN=1."
    return 0
  fi

  log_error "DMR_IMAGE='${_img}' is a CPU-ONLY image tag (tag='${_tag}')."
  log_error "  On this hardware that is a ~10x slowdown that reports as healthy, not as an error."
  log_error "  Expected an accelerated tag (…-cuda on NVIDIA, …-rocm on AMD)."
  log_error "  If CPU inference is genuinely intended, set DMR_IMAGE_CPU_OPT_IN=1."
  return 1
}

# ---------------------------------------------------------------------------
# set_runtime_profile_token — strip every runtime token, add exactly one.
# ---------------------------------------------------------------------------
# $1 = current COMPOSE_PROFILES value, $2 = the single token to end up with.
#
# Lives here, not in single-box.sh, because THREE scripts rewrite this list —
# single-box.sh, scripts/dmr/flip-single-box.sh and
# scripts/dmr/rollback-single-box.sh — and a token known to only one of them is
# a WARP-1826 single-GPU-owner violation waiting to happen. rollback stripped
# with `grep -vx 'dmr'`, an exact-line match, so `dmr-cuda` SURVIVED it: an
# NVIDIA box rolled back to Ollama carried BOTH tokens, and unlike the
# dmr/dmr-cuda pair there is no shared container_name to catch that, so both
# runtimes would start on one card. One list, one helper, three callers.
set_runtime_profile_token() {
  _profiles="${1:-}"
  _wanted="${2:-}"
  _out="$(printf '%s' "$_profiles" | tr ',' '\n' \
    | grep -vx -e 'dmr' -e 'dmr-cuda' -e 'ollama' | paste -sd, -)"
  if [ -z "$_out" ]; then
    printf '%s' "$_wanted"
  else
    printf '%s,%s' "$_out" "$_wanted"
  fi
}

# ---------------------------------------------------------------------------
# configure_gpu_env — write the detected vendor and correct a wrong image pin.
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
    #   a) an appliance whose card died or was removed   <- should be loud
    #   b) a CI runner / container / dev laptop          <- must NOT be fatal
    #   c) a VM with no PCI GPU at all                   <- must NOT be fatal
    #
    # An earlier revision returned 1 here. That aborted configure_single_box_env
    # on every GPU-less shape and turned 33 previously-green assertions in
    # tests/setup.test.sh red, none of which mentioned the GPU. Taking CI and
    # every dev machine down to catch a dead card is a bad trade, and a guard
    # everyone works around gets deleted. WARN and change nothing;
    # DROPLET_REQUIRE_GPU=1 opts into the hard failure.
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

  # ---------------------------------------------------------------------
  # DMR_IMAGE: correct a wrong pin, never create one.
  # ---------------------------------------------------------------------
  # 🔴 READ THE FILE, NOT THE ENVIRONMENT. An earlier revision tested
  # `${DMR_IMAGE:-}`, which looks like "did the operator export an override?"
  # and is not: materialize_artifacts exports the whole .env into the shell at
  # setup.sh:437, before configure_single_box_env at :451, so the box's OWN
  # stored value is already an exported variable here. Combined with the old
  # `assert … || return 1`, that meant setup.sh ABORTED on any box whose .env
  # carried a suffix-less DMR_IMAGE — i.e. on the WARP-2543 box this change
  # exists to repair. The guard turned its own target into a hard-down.
  #
  # 🔴 AND DO NOT WRITE THE KEY WHEN IT IS ABSENT. Each service's compose
  # default already selects the right image for its own profile
  # (`dmr` -> …-rocm, `dmr-cuda` -> …-cuda), so writing DMR_IMAGE on a healthy
  # box buys nothing and costs a permanent pin: migrate_env only backfills
  # ABSENT keys, so a value written once shadows the compose default for ever
  # and freezes the runtime version against future bumps — on every AMD box in
  # the fleet, which is exactly the blast radius this change promised not to
  # have.
  #
  # absent -> leave alone. present and correct -> leave alone.
  # present and WRONG -> rewrite it loudly. setup.sh exists to converge a box;
  # refusing to start is the wrong tool when a rewrite is available.
  _stored_image="$(grep -E '^DMR_IMAGE=' "$_env_target" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"

  if [ -n "$_stored_image" ]; then
    _stored_vendor="$(dmr_tag_vendor "$(dmr_image_tag "$_stored_image")")"

    if [ -z "$_stored_vendor" ]; then
      if [ "${DMR_IMAGE_CPU_OPT_IN:-0}" = "1" ]; then
        log_warn "DMR_IMAGE='${_stored_image}' is CPU-only; kept because DMR_IMAGE_CPU_OPT_IN=1."
      else
        log_warn "DMR_IMAGE='${_stored_image}' is a CPU-ONLY tag on a ${_vendor} box — the WARP-2543 fault."
        log_warn "  Rewriting it to '${_image}'. Set DMR_IMAGE_CPU_OPT_IN=1 to keep CPU inference deliberately."
        upsert_env DMR_IMAGE "$_image"
      fi
    elif [ "$_stored_vendor" != "$_vendor" ] && [ "$_stored_vendor" != "other" ]; then
      # A pin for the WRONG vendor — e.g. a ROCm image left behind after the
      # card was swapped to NVIDIA. Left alone this pairs the CUDA profile with
      # the ROCm image: the exact profile/image disagreement this file exists
      # to prevent.
      log_warn "DMR_IMAGE='${_stored_image}' is a ${_stored_vendor} image but this box is ${_vendor}."
      log_warn "  Rewriting it to '${_image}' so the profile and the image agree."
      upsert_env DMR_IMAGE "$_image"
    fi
    # Present, accelerated and matching (or a deliberate musa/openvino/sglang
    # build) -> untouched. An operator's newer pin survives setup.
  fi

  log_info "GPU: detected ${_vendor} — DMR profile '$(dmr_profile_for_vendor "$_vendor")'"
  return 0
}
