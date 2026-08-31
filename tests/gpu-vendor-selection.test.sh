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
out="$( GPU_VENDOR_OVERRIDE=nvidia detect_gpu_vendor )"
[ "$out" = "nvidia" ] && ok "override GPU_VENDOR_OVERRIDE=nvidia honoured" || bad "override not honoured (got '$out')"

out="$( GPU_VENDOR_OVERRIDE=NVIDIA detect_gpu_vendor )"
[ "$out" = "nvidia" ] && ok "override is case-insensitive" || bad "override case handling (got '$out')"

( GPU_VENDOR_OVERRIDE=nvidai detect_gpu_vendor >/dev/null 2>&1 )
[ $? -ne 0 ] && ok "a typo'd GPU_VENDOR_OVERRIDE is REFUSED, not silently treated as 'none'" \
             || bad "typo'd GPU_VENDOR_OVERRIDE accepted — would silently disable the GPU"

# Detection must not depend on a driver being loaded. On the box that prompted
# this ticket the NVIDIA card was present with NO kernel driver bound, so a
# detector keyed on nvidia-smi or /dev/nvidia* would have reported "no NVIDIA
# GPU" on a machine that had one — and confirmed the wrong wiring as correct.
# Materialised, not piped: `grep … | grep -q` under `set -o pipefail` is the
# same SIGPIPE trap as above, and here it would fail in the DANGEROUS
# direction — the pipeline reporting non-zero sends this to the `ok` branch,
# so the test would claim detection is driver-independent precisely when it
# had found evidence that it is not. `[[:space:]]` rather than `\s`, which is
# a GNU extension.
_lib_code="$(grep -vE '^[[:space:]]*#' "$LIB")"
if grep -qE 'nvidia-smi|/dev/nvidia' <<<"$_lib_code"; then
  bad "detect_gpu_vendor keys off a loaded driver — it must read the PCI bus"
else
  ok "detection does not depend on a loaded driver (reads the PCI bus)"
fi

# --- 3b. DRIVE THE REAL DETECTION PATH THROUGH A STUBBED lspci --------------
#
# 🔴 This section replaces a `grep -q '10de' "$LIB"` assertion that was
# satisfied by a COMMENT in gpu.sh ("Vendor IDs are the stable identifier:
# 10de = NVIDIA, 1002 = AMD/ATI"). It therefore held even if the entire
# detection body were deleted, and it was the ONLY coverage the hardware path
# had — every other call in this file sets GPU_VENDOR_OVERRIDE, which
# short-circuits before lspci is ever reached. The function whose whole job is
# to read the silicon — the fault that started this ticket — had no test.
#
# PATH-stubbed lspci, the idiom this repo already uses for docker/cryptsetup.

_stub_lspci() {
  # $1 = fixture name; writes a stub lspci onto PATH and echoes the bin dir
  _sd="$(mktemp -d)"
  case "$1" in
    nvidia-discrete-plus-amd-igpu)
      # The ACTUAL bench box: an NVIDIA discrete card AND the Ryzen iGPU.
      # DISCRETE-FIRST must pick nvidia; picking amd here is WARP-2543.
      cat > "$_sd/out" <<'FIX'
01:00.0 VGA compatible controller [0300]: NVIDIA Corporation Device [10de:2d04] (rev a1)
0d:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Raphael [1002:164e] (rev c3)
FIX
      ;;
    amd-only)
      cat > "$_sd/out" <<'FIX'
0d:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Raphael [1002:164e] (rev c3)
FIX
      ;;
    nvidia-3d-controller)
      # A headless compute card presents as "3D controller", not VGA.
      cat > "$_sd/out" <<'FIX'
01:00.0 3D controller [0302]: NVIDIA Corporation Device [10de:20b5]
FIX
      ;;
    no-gpu)
      : > "$_sd/out"
      ;;
  esac
  printf '#!/bin/sh
cat %s
' "$_sd/out" > "$_sd/lspci"
  chmod +x "$_sd/lspci"
  printf '%s' "$_sd"
}

_detect_with() {
  _d="$(_stub_lspci "$1")"
  ( PATH="$_d:$PATH"; unset GPU_VENDOR_OVERRIDE; gpu_vendor_from_bus )
  rm -rf "$_d"
}

got="$(_detect_with nvidia-discrete-plus-amd-igpu)"
[ "$got" = "nvidia" ]   && ok "DISCRETE-FIRST: NVIDIA card + AMD iGPU on the bus -> nvidia (the real bench box)"   || bad "NVIDIA discrete alongside an AMD iGPU detected as '$got' — this IS the WARP-2543 misdetection"

got="$(_detect_with amd-only)"
[ "$got" = "amd" ] && ok "AMD-only bus -> amd (the installed fleet)"                    || bad "AMD-only bus detected as '$got'"

got="$(_detect_with nvidia-3d-controller)"
[ "$got" = "nvidia" ] && ok "headless compute card ('3D controller', no marketing name) -> nvidia"                       || bad "3D-controller NVIDIA card detected as '$got'"

got="$(_detect_with no-gpu)"
[ "$got" = "none" ] && ok "no GPU on the bus -> none" || bad "empty bus detected as '$got'"

# lspci absent entirely (container / CI runner / macOS dev shape).
got="$( PATH="/nonexistent-$$"; unset GPU_VENDOR_OVERRIDE; gpu_vendor_from_bus 2>/dev/null || true )"
[ "$got" = "none" ] && ok "lspci absent -> none (dev/CI shapes still provision)"                     || bad "lspci absent produced '$got'"

# 🔴 The SIGPIPE regression guard. `printf … | grep -q` under pipefail can
# report a SUCCESSFUL match as a failure, and here that misclassifies an NVIDIA
# box as AMD — silently reproducing WARP-2543. Detection must not pipe.
if grep -nE "grep -q" "$LIB" | grep -v "^[0-9]*: *#" | grep -q .; then
  bad "gpu.sh pipes into grep -q — under pipefail a matched NVIDIA test can fall through to the AMD branch"
else
  ok "gpu.sh contains no pipe-into-grep -q (SIGPIPE cannot misclassify the vendor)"
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
( GPU_VENDOR_OVERRIDE=none configure_gpu_env "$tmp/.env" >/dev/null 2>&1 )
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
( GPU_VENDOR_OVERRIDE=none DROPLET_REQUIRE_GPU=1 configure_gpu_env "$tmp/.env" >/dev/null 2>&1 )
[ $? -ne 0 ] && ok "no GPU + DROPLET_REQUIRE_GPU=1: REFUSES (opt-in strict mode)" \
             || bad "DROPLET_REQUIRE_GPU=1 did not refuse a GPU-less DMR box"

rm -rf "$tmp"

# --- 4b. the WARP-2543 pin, tested the way it actually occurred --------------
#
# 🔴 As a LINE IN THE .env FILE, not an exported shell variable. The original
# assertion here passed DMR_IMAGE in the environment and was labelled "exactly
# how WARP-2543 shipped" — it wasn't. The incident value was a file line, and
# configure_gpu_env must read the FILE: `materialize_artifacts` does
# `set -a; . .env; set +a` at setup.sh:437, fourteen lines before
# configure_single_box_env at :451, so by then the box's own stored value is
# already an exported variable and "is it an operator override?" is
# unanswerable from the environment.
#
# It must also CORRECT the pin, not refuse. The earlier `assert … || return 1`
# aborted configure_single_box_env — i.e. setup.sh failed outright on the very
# box this change exists to repair. The guard turned its own target into a
# hard-down.
tmp2="$(mktemp -d)"
upsert_env() { printf '%s=%s\n' "$1" "$2" >> "$tmp2/.env"; }

printf 'INFERENCE_RUNTIME=dmr\nDMR_IMAGE=docker/model-runner:v1.2.6\n' > "$tmp2/.env"
( GPU_VENDOR_OVERRIDE=nvidia configure_gpu_env "$tmp2/.env" >/dev/null 2>&1 )
if grep -q '^DMR_IMAGE=.*-cuda$' "$tmp2/.env"; then
  ok ".env-pinned CPU-only DMR_IMAGE is REWRITTEN to the vendor image, not refused"
else
  bad "file-pinned CPU image not corrected (got: $(grep '^DMR_IMAGE=' "$tmp2/.env" | tail -1))"
fi

# A vendor MISMATCH must also be corrected: a ROCm pin left behind after a card
# swap would otherwise pair the CUDA profile with the ROCm image — the exact
# profile/image disagreement gpu.sh says it exists to prevent.
printf 'INFERENCE_RUNTIME=dmr\nDMR_IMAGE=docker/model-runner:v1.2.6-rocm\n' > "$tmp2/.env"
( GPU_VENDOR_OVERRIDE=nvidia configure_gpu_env "$tmp2/.env" >/dev/null 2>&1 )
grep -q '^DMR_IMAGE=.*-cuda$' "$tmp2/.env" \
  && ok "a ROCm pin on an NVIDIA box is rewritten to the CUDA image" \
  || bad "vendor-mismatched pin survived (got: $(grep '^DMR_IMAGE=' "$tmp2/.env" | tail -1))"

# 🔴 An AMD box with NO pin must NOT gain one. migrate_env only backfills
# ABSENT keys, so a value written once shadows the compose default for ever and
# freezes the runtime version — on every AMD box in the fleet.
printf 'INFERENCE_RUNTIME=dmr\n' > "$tmp2/.env"
( GPU_VENDOR_OVERRIDE=amd configure_gpu_env "$tmp2/.env" >/dev/null 2>&1 )
grep -q '^DMR_IMAGE=' "$tmp2/.env" \
  && bad "an AMD box with no DMR_IMAGE gained a permanent pin — freezes the version fleet-wide" \
  || ok "no DMR_IMAGE written when absent (compose default stays the source of truth)"

# An operator's newer, correct pin must survive setup untouched.
printf 'INFERENCE_RUNTIME=dmr\nDMR_IMAGE=docker/model-runner:v9.9.9-rocm\n' > "$tmp2/.env"
( GPU_VENDOR_OVERRIDE=amd configure_gpu_env "$tmp2/.env" >/dev/null 2>&1 )
grep -q '^DMR_IMAGE=docker/model-runner:v9.9.9-rocm$' "$tmp2/.env" \
  && ok "a correct, newer operator pin is left alone" \
  || bad "an operator's valid pin was overwritten (got: $(grep '^DMR_IMAGE=' "$tmp2/.env" | tail -1))"

# GPU_VENDOR must never be readable back as an override, or detection latches
# to its own past output and a card swap can never move the box again.
printf 'INFERENCE_RUNTIME=dmr\n' > "$tmp2/.env"
( GPU_VENDOR=amd GPU_VENDOR_OVERRIDE= ; export GPU_VENDOR; unset GPU_VENDOR_OVERRIDE
  _d="$(_stub_lspci nvidia-discrete-plus-amd-igpu)"; PATH="$_d:$PATH"; detect_gpu_vendor ) > "$tmp2/vendor" 2>/dev/null
grep -q '^nvidia$' "$tmp2/vendor" \
  && ok "a persisted GPU_VENDOR does NOT shadow detection (no self-latching after a card swap)" \
  || bad "detection returned '$(cat "$tmp2/vendor")' — a stored GPU_VENDOR is being read back as an override"
rm -rf "$tmp2"

# --- 5. compose wiring matches the vendor model ------------------------------
#
# Everything above tests shell functions. None of it reads docker-compose.yml,
# so reverting the compose half would leave all of it green — the WARP-1870
# lesson (a fix whose only behaviour change has no test).
COMPOSE="$REPO_ROOT/docker/docker-compose.yml"

# WARP-2543 — materialise each awk range into a variable instead of piping it
# into `grep -q`.
#
# `set -o pipefail` (line 1) plus `grep -q` is a SIGPIPE trap: grep exits the
# instant it matches, awk gets SIGPIPE, and the PIPELINE status becomes 141 —
# so a SUCCESSFUL match reports as a failure. Whether it fires depends on
# whether awk finished writing before grep left, i.e. on output size and
# scheduling, so it passes locally and fails on CI. That is exactly how the
# first push of this branch failed `setup-unit` on an assertion that was green
# on three local runs, and it is the same shape as the fips-lint SIGPIPE bug.
# No pipe, no race.
_block() { awk "$1" "$COMPOSE"; }

if grep -qE '^  dmr-cuda:' "$COMPOSE"; then
  ok "compose declares the dmr-cuda service"
else
  bad "compose has no dmr-cuda service — GPU_VENDOR=nvidia would select a profile that starts nothing"
fi

_b="$(_block '/^  dmr-cuda:/,/^  inference-manager:/')"
if grep -q 'profiles: \["dmr-cuda"\]' <<<"$_b"; then
  ok "dmr-cuda is gated on its own profile"
else
  bad "dmr-cuda is not gated on the dmr-cuda profile"
fi

# The alias is load-bearing: every consumer dials http://dmr:12434.
_b="$(_block '/^  dmr-cuda:/,/^  inference-manager:/')"
if grep -qE '^ +- dmr$' <<<"$_b"; then
  ok "dmr-cuda carries the 'dmr' network alias (consumers dial http://dmr:12434)"
else
  bad "dmr-cuda has no 'dmr' network alias — every consumer would fail to resolve it"
fi

# The AMD service must NOT have gained NVIDIA wiring, and must keep its own.
_b="$(_block '/^  dmr:/,/^  dmr-cuda:/')"
if grep -q '/dev/kfd' <<<"$_b"; then
  ok "the AMD 'dmr' service still wires /dev/kfd (unchanged for the installed fleet)"
else
  bad "the AMD 'dmr' service lost its ROCm device wiring"
fi

_b="$(_block '/^  dmr:/,/^  dmr-cuda:/')"
if grep -q 'runtime: nvidia' <<<"$_b"; then
  bad "the AMD 'dmr' service gained 'runtime: nvidia' — it would fail to start on every AMD box"
else
  ok "the AMD 'dmr' service has no nvidia runtime (correctly untouched)"
fi

# The GPU-residency healthcheck is the fail-loud half of this ticket. Without
# it, an NVIDIA box that loses its driver goes back to silent CPU inference.
_b="$(_block '/^  dmr-cuda:/,/^  inference-manager:/')"
if grep -q 'nvidia-smi' <<<"$_b"; then
  ok "dmr-cuda healthcheck asserts GPU visibility (silent CPU fallback becomes unhealthy)"
else
  bad "dmr-cuda has no GPU-residency healthcheck — a CPU fallback would still report healthy"
fi

# 🔴 ...AND it must still assert API liveness. A service-level `healthcheck:`
# REPLACES the image's HEALTHCHECK rather than merging with it, and the CUDA
# image ships `curl -f .../engines/status`. A GPU-only probe would discard that,
# so a model-runner that had died would report healthy — trading one blind spot
# for another, and the same "the API answers" vs "the GPU is used" confusion
# that let WARP-2543 run for days.
_b="$(_block '/^  dmr-cuda:/,/^  inference-manager:/')"
if grep -q 'engines/status' <<<"$_b"; then
  ok "dmr-cuda healthcheck ALSO probes /engines/status (image healthcheck not silently dropped)"
else
  bad "dmr-cuda healthcheck replaced the image's /engines/status probe — a dead runner would report healthy"
fi

# The model-catalog sidecar must be selected on BOTH DMR shapes. Gated on `dmr`
# alone it silently vanished from the NVIDIA project, and the Models page
# renders nothing rather than erroring.
# NOTE the end anchor: `/^  [a-z...]:$/` would match the START line too, and an
# awk range whose start also matches its end spans exactly one line — the same
# silent-truncation trap this suite already hit once. Anchor on the next real
# service instead.
_im="$(awk '/^  inference-manager:/,/^  openwrt:/' "$COMPOSE")"
if grep -qF 'profiles: ["dmr", "dmr-cuda"]' <<<"$_im"; then
  ok "inference-manager is selected on both dmr and dmr-cuda"
else
  bad "inference-manager is not profiled for dmr-cuda — the model catalog dies on the NVIDIA shape"
fi

# ...and it must not depend_on a profile-excluded service: compose rejects the
# WHOLE project ("depends on undefined service"), and systemd runs
# `docker compose config -q` as ExecStartPre — so that is a full-appliance
# outage, not a degraded service.
# Comment lines stripped first: the compose block explains at length WHY the
# depends_on was removed, and matching that prose would fail the assertion for
# the very reason it passes.
_im_code="$(grep -vE '^[[:space:]]*#' <<<"$_im")"
if grep -qE '^[[:space:]]*depends_on:' <<<"$_im_code"; then
  bad "inference-manager still declares depends_on — on the other profile that makes the whole compose project invalid"
else
  ok "inference-manager declares no depends_on (cannot invalidate the project on either shape)"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
