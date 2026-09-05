#!/usr/bin/env bash
# install-nvidia-runtime.sh — make an NVIDIA card usable by the DMR container.
#
# WARP-2543. Idempotent, re-runnable, and a NO-OP on any box whose accelerator
# is not NVIDIA — which is most of the fleet, and deliberately so.
#
# ============================================================================
# WHY THIS EXISTS AS A SCRIPT AND NOT A RUNBOOK
# ============================================================================
# The bench box sat with an NVIDIA RTX 5060 Ti fitted, no driver bound, no
# container toolkit, and Docker's runtime list showing `runc` only — while the
# stack happily served the 20B from CPU at 8 tok/s with every healthcheck
# green. A runbook would not have prevented that, because nobody knew there was
# anything to run. Provisioning belongs on the provision path so a reimage
# reproduces it; that is the difference between a fix and an anecdote.
#
# ============================================================================
# WHAT IT DOES
# ============================================================================
#   1. Refuses unless the detected accelerator is NVIDIA.
#   2. Installs the NVIDIA driver Ubuntu recommends FOR THIS CARD.
#   3. Installs nvidia-container-toolkit and registers the `nvidia` runtime.
#   4. Verifies the runtime end-to-end, in a container, against the real GPU.
#
# ============================================================================
# WHAT IT DOES NOT DO
# ============================================================================
# It never reboots. A driver install on a box with the old module loaded needs
# one, and choosing when a customer appliance reboots is not this script's
# call — it says so and exits non-zero so the caller decides.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../lib/logging.sh
source "$REPO_ROOT/scripts/lib/logging.sh"
# shellcheck source=../lib/gpu.sh
source "$REPO_ROOT/scripts/lib/gpu.sh"

DRY_RUN="${DRY_RUN:-0}"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    log_info "[dry-run] $*"
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------
# 1. Vendor gate
# ---------------------------------------------------------------------------
# 🔴 THE MOST IMPORTANT LINES IN THIS FILE. Boxes in the field run AMD cards
# and MUST stay on the ROCm path. Installing an NVIDIA driver on one of them
# would, at best, waste an install; at worst the packaging touches the amdgpu
# stack the box's inference actually depends on. This script must be inert
# there, and the gate is what makes running it fleet-wide safe.
vendor="$(detect_gpu_vendor)"
if [ "$vendor" != "nvidia" ]; then
  log_info "Accelerator is '${vendor}', not nvidia — nothing to do."
  log_info "  (An AMD box serves DMR from the ROCm image via the 'dmr' profile and needs none of this.)"
  exit 0
fi

# log_step takes (current, total, msg) — calling it with one argument expands
# an unset $2 and, under `set -u`, kills the script at its first real statement
# on the only hardware it targets. Verified: `log_step "x"` -> "$2: unbound
# variable", exit 1.
log_info "NVIDIA runtime provisioning (WARP-2543)"
lspci -nn | grep -iE 'VGA compatible controller|3D controller' | grep -i '10de' | sed 's/^/  card: /' || true

# ---------------------------------------------------------------------------
# 2. Driver
# ---------------------------------------------------------------------------
# `ubuntu-drivers devices` resolves the recommendation from the card's own
# modalias, so a future card gets the right driver without editing this file.
# Hard-coding a version is how a box ends up with a driver that predates its
# GPU — Blackwell (GB20x) needs >= 570 and the OPEN kernel modules; the
# proprietary flavour does not support it at all.
# Materialised, never piped into `grep -q`. Under `set -o pipefail` grep -q
# exits on first match, the producer takes SIGPIPE and dies 141, and pipefail
# promotes that to the pipeline status — so a SUCCESSFUL match takes the else
# branch. Same trap this PR removed from its own test files.
_smi_l="$(nvidia-smi -L 2>/dev/null || true)"
if command -v nvidia-smi >/dev/null 2>&1 && case "$_smi_l" in *'GPU 0'*) true ;; *) false ;; esac; then
  log_success "NVIDIA driver already loaded: $(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)"
else
  log_info "No working NVIDIA driver — installing the recommended one."
  run apt-get update -qq

  # ubuntu-drivers-common provides the recommendation engine itself.
  command -v ubuntu-drivers >/dev/null 2>&1 || run apt-get install -y -qq ubuntu-drivers-common

  # `ubuntu-drivers devices` enumerates EVERY device with a third-party driver
  # — wifi (bcmwl-kernel-source), oem-*-meta kernel metapackages, guest modules
  # — each in its own section, each able to carry its own "recommended" line.
  # Taking the first one unconstrained can install a wifi driver and then
  # report NVIDIA provisioning as done. Constrain to nvidia-driver-* packages.
  _ud="$(ubuntu-drivers devices 2>/dev/null || true)"
  recommended="$(printf '%s
' "$_ud" | awk '/recommended/ && $3 ~ /^nvidia-driver-/ {print $3}' | sort -u | head -1)"
  if [ -z "$recommended" ]; then
    log_error "ubuntu-drivers has no recommendation for this card."
    log_error "  Refusing to guess a driver version — an unsupported one loads and then fails at CUDA init,"
    log_error "  which reads as 'GPU present but broken' and is harder to diagnose than no driver at all."
    exit 1
  fi

  # Prefer the -open flavour when the recommendation is not already open:
  # required on Blackwell, and NVIDIA's default for Turing and later.
  case "$recommended" in
    *-open) driver_pkg="$recommended" ;;
    *)      driver_pkg="${recommended}-open"
            apt-cache show "$driver_pkg" >/dev/null 2>&1 || driver_pkg="$recommended" ;;
  esac

  log_info "Installing ${driver_pkg} (ubuntu-drivers recommended: ${recommended})"
  run apt-get install -y -qq "$driver_pkg"

  # Secure Boot signs DKMS modules through MOK, which needs an interactive
  # enrollment at the next boot — impossible on a headless appliance and a
  # confusing way to fail (driver "installed", module refuses to load).
  # Report it rather than pretend the install succeeded.
  _sb="$(mokutil --sb-state 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  if command -v mokutil >/dev/null 2>&1 && case "$_sb" in *enabled*) true ;; *) false ;; esac; then
    log_warn "Secure Boot is ENABLED — the DKMS module needs MOK enrollment at the console before it will load."
  fi

  log_warn "Driver installed but not loaded. A REBOOT is required before the GPU is usable."
  log_warn "  Not rebooting automatically: on a customer appliance that is an operator decision."
  NEEDS_REBOOT=1
fi

# ---------------------------------------------------------------------------
# 3. Container toolkit
# ---------------------------------------------------------------------------
# Without this, `runtime: nvidia` in compose fails with "unknown runtime" —
# which is loud and therefore acceptable, but the box has no inference until
# it is fixed.
# Materialised: the piped form reinstalled the toolkit and RESTARTED DOCKER on
# every run of an already-correct box, because docker info keeps writing after
# grep -q exits and pipefail turned the resulting SIGPIPE into "not found".
_dockerinfo="$(docker info 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
if command -v nvidia-ctk >/dev/null 2>&1 && case "$_dockerinfo" in *nvidia*) true ;; *) false ;; esac; then
  log_success "nvidia-container-toolkit already installed and registered with Docker."
else
  log_info "Installing nvidia-container-toolkit."

  # NVIDIA's apt repo. Registered in docs/security/allowed-egress.yaml
  # (id: setup-nvidia-container-toolkit) — the egress gate fails the PR
  # otherwise, and that entry carries the security review.
  keyring=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  if [ ! -f "$keyring" ]; then
    run sh -c "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | gpg --dearmor -o '$keyring'"
  fi
  run sh -c "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=$keyring] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list"

  run apt-get update -qq
  run apt-get install -y -qq nvidia-container-toolkit

  # Writes the `nvidia` runtime into /etc/docker/daemon.json.
  run nvidia-ctk runtime configure --runtime=docker
  run systemctl restart docker
  log_success "nvidia-container-toolkit installed; Docker restarted with the nvidia runtime."
fi

# ---------------------------------------------------------------------------
# 4. Verify — in a container, against the real device
# ---------------------------------------------------------------------------
# The check that matters. Every intermediate step can look fine while the
# end-to-end path is broken, and "the packages are installed" is exactly the
# kind of proxy assertion that let WARP-2543 run for days. Prove the GPU is
# reachable from inside a container or report failure.
if [ "${NEEDS_REBOOT:-0}" = "1" ]; then
  log_warn "Skipping the container GPU check — reboot first, then re-run this script to verify."
  exit 75  # EX_TEMPFAIL: not a failure, not a success. Caller must re-run.
fi

if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] would verify: docker run --rm --runtime=nvidia --gpus all <cuda image> nvidia-smi -L"
  exit 0
fi

log_info "Verifying GPU visibility from inside a container…"
# 🔴 Materialised, not piped into `grep -q`. This is the check that decides
# pass/fail for the entire NVIDIA provisioning run, and in the piped form it
# failed in the WORST direction: grep -q exits on the first match, docker run
# takes SIGPIPE and dies 141, pipefail promotes it, and a box whose GPU is
# working perfectly reports "GPU is NOT visible inside containers" and exits 1.
_ctr_gpus="$(docker run --rm --runtime=nvidia --gpus all \
     --entrypoint nvidia-smi "${DMR_IMAGE:-docker/model-runner:v1.2.6-cuda}" -L 2>/dev/null || true)"
case "$_ctr_gpus" in
  *'GPU 0'*)
  log_success "GPU is visible inside containers — DMR can offload."
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | sed 's/^/  /'
    ;;
  *)
  log_error "GPU is NOT visible inside containers."
  log_error "  DMR would start and silently serve from CPU (~8 tok/s on the 20B, healthchecks green)."
  log_error "  Check: nvidia-smi on the host, 'docker info | grep -i runtime', /etc/docker/daemon.json"
  exit 1
    ;;
esac
