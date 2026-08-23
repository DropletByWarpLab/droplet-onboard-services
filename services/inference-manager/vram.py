"""Detect VRAM headroom for VRAM-aware manifest gating.

Two hardware shapes:

* **Dedicated GPU** (the shipping single-box: an AMD/NVIDIA card with its
  own memory) — read the driver's sysfs node directly
  (``/sys/class/drm/card*/device/mem_info_vram_total``). This is the
  authoritative number for the memory Ollama actually has to work with; it
  is NOT shared with the OS, so no reserve is subtracted.
* **Unified memory** (legacy shape, e.g. Jetson) — CPU/GPU share memory, so
  the right signal is ``MemTotal`` from ``/proc/meminfo`` minus a reserve
  for the OS and sidecar services.

dGPU sysfs is preferred when present; unified memory is the fallback when
no dGPU node exists (WARP-1111 §7.4 — the code previously always read
``/proc/meminfo``, which is wrong for a dedicated-GPU host: it would count
system RAM the GPU can't use). ``VRAM_OVERRIDE_GB`` wins over both, as
before. A *successful* result is cached for the process lifetime since
detected hardware does not change at runtime; a *failed* read is
deliberately not cached so detection self-heals on a later call (WARP-194).

Per ADR-011 (hardware-agnostic naming): the public function and its return
value are described in terms of "dedicated GPU" / "unified memory", never
silicon vendor names.
"""

from __future__ import annotations

import glob
import logging
import os

from logging_config import get_logger

logger = logging.getLogger(__name__)


def _struct_logger():
    """Structlog logger for the documented structured events (RESILIENCE.md
    tells operators to grep JSON logs for `vram_detection_failed` /
    `vram_detected`). The stdlib `logger` above is kept for the
    non-documented `_read_int_env` validation warning.

    Resolved fresh on every call rather than cached at module-import time:
    structlog's `cache_logger_on_first_use` (set by `configure_structlog()`
    in main.py) freezes a *cached* proxy's processor chain on its first real
    log call, which would survive a later `structlog.testing.capture_logs()`
    context if that first call happened outside one — exactly the ordering a
    module-level singleton can't control across a whole test session. A
    fresh `get_logger()` call every time sidesteps that entirely.
    """
    return get_logger(__name__)

_MEMINFO_PATH = "/proc/meminfo"
# Every dGPU driver that exposes `mem_info_vram_total` (amdgpu; nouveau/nvidia
# expose an analogous node under the same glob shape) publishes it here. A box
# with both a dedicated card and an integrated GPU (e.g. this appliance's
# Raphael iGPU, owned by Frigate — see the architecture brief §3.1) can match
# more than one node; `_read_dgpu_vram_bytes` takes the max, not the sum, to
# land on the dedicated card without needing to identify it by vendor ID.
_DGPU_VRAM_GLOB = "/sys/class/drm/card*/device/mem_info_vram_total"

# Detection-source names. The two hardware-shape values are also the `source`
# field of the `vram_detected` structured event (RESILIENCE.md) — change them
# and every log pipeline grepping that field goes blind. `override` never
# appears in the event (the override path predates it) but is exposed via
# `detected_vram_source()` so placement checks (WARP-1825) can treat an
# override exactly like a dedicated card — that is what the hatch simulates.
SOURCE_OVERRIDE = "override"
SOURCE_DGPU = "dgpu_sysfs"
SOURCE_UNIFIED = "unified_memory"

_cached_gb: int | None = None
_cached_source: str | None = None


def _read_memtotal_kb(path: str) -> int | None:
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    parts = line.split()
                    return int(parts[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def _read_dgpu_vram_bytes(glob_pattern: str) -> int | None:
    """Largest VRAM total (bytes) across all matching dGPU sysfs nodes.

    Returns ``None`` when no node matches or every match is unreadable —
    the unified-memory path is the fallback for that case.
    """
    best: int | None = None
    for path in sorted(glob.glob(glob_pattern)):
        try:
            with open(path) as f:
                value = int(f.read().strip())
        except (OSError, ValueError):
            continue
        if best is None or value > best:
            best = value
    return best


def _read_int_env(name: str) -> int | None:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid %s=%r — ignoring", name, raw)
        return None


def detected_vram_gb() -> int:
    """Return GB of memory headroom available for model loading.

    Resolution order:
        1. VRAM_OVERRIDE_GB env var (testing hatch).
        2. Dedicated-GPU sysfs (`mem_info_vram_total`), no reserve subtracted.
        3. /proc/meminfo MemTotal minus VRAM_RESERVE_GB (default 2).
        4. 0 if neither source is readable.
    """
    global _cached_gb, _cached_source
    if _cached_gb is not None:
        return _cached_gb

    override = _read_int_env("VRAM_OVERRIDE_GB")
    if override is not None:
        _cached_gb = override
        _cached_source = SOURCE_OVERRIDE
        return _cached_gb

    dgpu_bytes = _read_dgpu_vram_bytes(_DGPU_VRAM_GLOB)
    if dgpu_bytes is not None:
        # Round rather than floor: sysfs reports raw byte counts that fall a
        # little short of the marketing GB figure (a "16 GB" card reports
        # 17,095,983,104 B ≈ 15.92 GiB) — floor would under-report a card
        # like that by a full GB. This is also the answer to "why does the
        # live box already report 16 GB": the sysfs byte count rounds to 16.
        gb = round(dgpu_bytes / (1024**3))
        _cached_gb = max(0, gb)
        _cached_source = SOURCE_DGPU
        _struct_logger().info(
            "vram_detected", source=SOURCE_DGPU, vram_gb=_cached_gb
        )
        return _cached_gb

    reserve = _read_int_env("VRAM_RESERVE_GB")
    if reserve is None:
        reserve = 2

    kb = _read_memtotal_kb(_MEMINFO_PATH)
    if kb is None:
        # Emit the structured event RESILIENCE.md documents so JSON log
        # pipelines can filter on `vram_detection_failed`. See LLM-08.
        _struct_logger().warning(
            "vram_detection_failed", path=_MEMINFO_PATH, defaulting_to_gb=0
        )
        # WARP-194: do NOT cache a failed read. /proc/meminfo can be transiently
        # unreadable (e.g. during an OOM event); caching 0 would pin model
        # eligibility empty for the whole process lifetime, leaving the device
        # stuck-degraded until a manual container restart. Returning uncached
        # lets the next call re-attempt detection and self-heal.
        return 0

    total_gb = kb // (1024 * 1024)
    _cached_gb = max(0, total_gb - reserve)
    _cached_source = SOURCE_UNIFIED
    _struct_logger().info(
        "vram_detected", source=SOURCE_UNIFIED, vram_gb=_cached_gb
    )
    return _cached_gb


def detected_vram_source() -> str | None:
    """Which source produced the cached detection, running it if needed.

    ``None`` when detection has not succeeded (the failed-read path is
    deliberately uncached — WARP-194 — and sets no source). Placement
    verification (WARP-1825) gates on this: ``size_vram`` only means
    "weights on the card" for :data:`SOURCE_DGPU` / :data:`SOURCE_OVERRIDE`.
    """
    if _cached_gb is None:
        detected_vram_gb()
    return _cached_source
