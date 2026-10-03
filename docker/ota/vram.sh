# vram.sh — WARP-3452: size the model context window to the GPU.
# Source this file (POSIX sh: dash runs it on the box); do not execute it.
#
# ONE copy, two callers: scripts/lib/gpu.sh (setup) and docker/ota/env-reconcile.sh
# (OTA). It lives under docker/ because a release's configs.tar.gz is
# `git archive HEAD docker`: an OTA box only ever receives docker/, so a probe
# kept in scripts/lib/ would be missing or stale where reconcile runs.
#
# The window costs VRAM: the KV cache grows with it. Measured on the bench box
# (RTX 5060 Ti 16 GB, gpt-oss:20B-F16): 12.7 GB at 16k, 14.0 GB at 64k. Coding
# tools need the 64k (Copilot agent mode sends ~24k-token prompts, refused with
# 400 at n_ctx 16384), so a 16 GiB card gets 65536 and anything smaller, an
# iGPU or a CPU-only box keeps 16384.

# NVIDIA VRAM in MiB, or nothing. The host's nvidia-smi first (setup). The OTA
# helper runs in a one-shot `chroot /host` container with no NVIDIA device
# access, where that fails, so fall back to the running DMR container: the
# dmr-cuda image carries nvidia-smi and the GPU (its healthcheck uses both).
_vram_nvidia_mib() {
  _vram_n=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    _vram_n="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
      | tr -d ' ' | sort -n | tail -n 1)" || _vram_n=""
  fi
  case "$_vram_n" in
    ''|*[!0-9]*)
      _vram_n=""
      if command -v docker >/dev/null 2>&1; then
        _vram_n="$(docker exec droplet-dmr nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
          | tr -d ' ' | sort -n | tail -n 1)" || _vram_n=""
      fi
      ;;
  esac
  case "$_vram_n" in ''|*[!0-9]*) ;; *) printf '%s' "$_vram_n" ;; esac
  return 0
}

# AMD VRAM in MiB from amdgpu's sysfs node, or nothing. The largest node wins,
# so a Raphael iGPU's 512 MiB carve-out never stands in for a discrete card.
# SYS_DRM_ROOT is a test seam, as in scripts/dmr/flip-single-box.sh.
_vram_amd_mib() {
  _vram_max=0
  for _vram_f in "${SYS_DRM_ROOT:-/sys/class/drm}"/card*/device/mem_info_vram_total; do
    _vram_b="$(cat "$_vram_f" 2>/dev/null)" || _vram_b=""
    case "$_vram_b" in ''|*[!0-9]*) continue ;; esac
    if [ "$_vram_b" -gt "$_vram_max" ]; then _vram_max="$_vram_b"; fi
  done
  if [ "$_vram_max" -gt 0 ]; then printf '%s' "$((_vram_max / 1048576))"; fi
  return 0
}

# gpu_vram_mib [vendor] — total VRAM of the discrete card in MiB, or nothing
# when it cannot be measured. vendor = GPU_VENDOR (nvidia|amd|none); empty
# (a box provisioned before setup wrote GPU_VENDOR) tries NVIDIA, then AMD.
gpu_vram_mib() {
  case "${1:-}" in
    nvidia) _vram_nvidia_mib ;;
    amd)    _vram_amd_mib ;;
    none)   printf '0' ;;
    *)
      _vram_any="$(_vram_nvidia_mib)"
      if [ -n "$_vram_any" ]; then printf '%s' "$_vram_any"; else _vram_amd_mib; fi
      ;;
  esac
  return 0
}

# context_window_for_vram_mib <MiB> — 65536 from 16 GiB up, else 16384; nothing
# when the input is not a number. Rounded to the nearest GiB because a "16 GB"
# card reports less than 16384 MiB (the bench box's RTX 5060 Ti: 16311).
context_window_for_vram_mib() {
  case "${1:-}" in ''|*[!0-9]*) return 0 ;; esac
  if [ $(( ($1 + 512) / 1024 )) -ge 16 ]; then printf '65536'; else printf '16384'; fi
  return 0
}
