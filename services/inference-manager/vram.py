"""Detect VRAM headroom for VRAM-aware manifest gating.

Three hardware shapes, resolved vendor-aware (WARP-3046):

* **NVIDIA dedicated GPU** — the nvidia driver publishes NO
  ``mem_info_vram_total`` under ``/sys/class/drm`` (that node is amdgpu's), and
  this sidecar has no GPU runtime to ask NVML. The number comes from the host
  device-bridge's ``GET /gpu``, which already sizes the card with host
  ``nvidia-smi`` (WARP-2883) and is installed by setup.sh on every single-box.
  Its answer is trusted only when it names an NVIDIA card: its AMD path is
  "largest sysfs node wins" too, and would echo an iGPU carve-out back.
* **AMD dedicated GPU** — read the driver's sysfs node directly
  (``/sys/class/drm/cardN/device/mem_info_vram_total``). This is the memory the
  runtime actually has to work with; it is NOT shared with the OS, so no
  reserve is subtracted. Nodes under :data:`_APU_CARVE_OUT_MAX_BYTES` are an
  integrated GPU's BIOS carve-out, not a card, and are skipped.
* **Unified memory** (Jetson, an APU-only Ryzen, a GPU-less host) — CPU/GPU
  share memory, so the right signal is ``MemTotal`` from ``/proc/meminfo`` minus
  a reserve for the OS and sidecar services — capped at the runtime
  container's own memory limit (``DMR_MEM_LIMIT``, passed in by compose with
  the ``dmr`` service's default). On this repo's single-box both of those
  shapes run the ``dmr`` service (the Raphael iGPU is no ROCm target, so DMR
  runs on the CPU), whose weights live inside that cgroup: RAM it may not use
  is not a budget. No limit set (upstream's Jetson shape, a host-native
  runtime) means no cap.

``VRAM_OVERRIDE_GB`` wins over all of them, as before.

**Unknown is not zero.** When no source can size the box — an NVIDIA card is
present but the bridge is down/unauthorised/unconfigured, ``/proc/meminfo``
is unreadable, or the runtime's memory limit is set but unreadable — detection
returns ``None``. ``0`` is a measurement the catalog renders as "nothing
fits"; ``None`` is the honest "couldn't size this box". The NVIDIA case in
particular must never fall through to the iGPU node (the .195 defect: 512 MiB
→ round(0.5) = 0) or to ``MemTotal`` (RAM the card cannot use). An NVIDIA card
counts as present on any of three signals: its DRM node's PCI vendor,
``GPU_VENDOR=nvidia`` (what setup.sh read off the PCI bus), or a display-class
NVIDIA function on the live PCI bus — the last two cover a card with no DRM
node because nvidia-drm is not loaded.

**Only a positive, sourced result is cached** (WARP-194 generalised): a card
does not change size at runtime, but a bridge that is briefly down, a
transiently unreadable ``/proc/meminfo`` or a genuine 0 must not pin the
catalog empty for the life of the process — the next call re-measures.

Per ADR-011 (hardware-agnostic naming): the public functions and the source
names describe *where the number came from*, never silicon vendor names. The
vendor IDs below are how the code tells the shapes apart, not a product name.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
from pathlib import Path

import httpx

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
# Only the amdgpu driver publishes `mem_info_vram_total` (WARP-3046: the
# nvidia driver publishes nothing here — verified on .195, and the reason
# device-bridge.py grew `nvidia_snapshot`). A box with a dedicated AMD card
# and an integrated GPU (this appliance's Raphael iGPU, owned by Frigate — see
# the architecture brief §3.1) matches more than one node;
# `_read_dgpu_vram_bytes` skips carve-out-sized nodes and takes the max of the
# rest.
_DGPU_VRAM_GLOB = "/sys/class/drm/card*/device/mem_info_vram_total"
# PCI vendor of every DRM card. Read to recognise an NVIDIA card, which has no
# memory node of its own and would otherwise be invisible here.
_DRM_VENDOR_GLOB = "/sys/class/drm/card*/device/vendor"
# `card*` also matches connectors (`card1-DP-3`); only `cardN` is a device.
_DRM_CARD_NAME = re.compile(r"card\d+")
_NVIDIA_VENDOR_ID = "0x10de"
# Every PCI function on the host (sysfs is not namespaced, so the container
# sees the host bus — verified in the running container on .195). Read to spot
# an NVIDIA card that has no DRM node because nvidia-drm is not loaded.
_PCI_DEVICE_GLOB = "/sys/bus/pci/devices/*"
# PCI base class 0x03 — VGA (0x0300), 3D (0x0302), other display (0x0380): the
# same three kinds gpu.sh's `gpu_vendor_from_bus` classifies from `lspci`. An
# NVIDIA card's audio function (0x0403) is not a GPU.
_PCI_DISPLAY_CLASS_PREFIX = "0x03"
# The runtime container's memory limit, in compose's `mem_limit` spelling. The
# unified-memory budget cannot exceed it (see the module docstring).
_RUNTIME_MEM_LIMIT_ENV = "DMR_MEM_LIMIT"
# docker's RAMInBytes grammar, which compose applies to `mem_limit`: a number,
# an optional binary unit, an optional `i`, an optional `b`, any case.
_MEM_LIMIT = re.compile(r"(\d+(?:\.\d+)?) ?([kmgtp])?i?b?", re.IGNORECASE)
_MEM_LIMIT_UNITS = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4, "p": 1024**5}
# The name device-bridge.py's `nvidia_snapshot` gives an NVIDIA GPU that has
# no DRM node (nvidia-drm not loaded). Only that path produces it.
_BRIDGE_NVIDIA_FALLBACK_CARD = re.compile(r"nvidia\d+")
# An amdgpu node below this is an integrated GPU's carve-out, not a card: the
# Raphael iGPU reports 512 MiB. CAVEAT (BIOS UMA): AM5 firmware lets the owner
# raise "UMA Frame Buffer Size" to 2/4/8/16 GB, and a carve-out at or above
# this threshold reads as a small dedicated card. That over-counts only on an
# APU-only box whose owner changed the BIOS default, and then only by the
# carve-out's own size — never the 0-GB empty catalog this threshold exists to
# prevent. A size test was chosen over an APU device-ID list because the list
# goes stale with every new APU and a miss there re-creates the 0-GB defect.
_APU_CARVE_OUT_MAX_BYTES = 2 * 1024**3
# The bridge answers from a local nvidia-smi call; anything slower than this is
# a wedged bridge, and the catalog read must not hang on it.
_BRIDGE_TIMEOUT_S = 2.0

# Detection-source names. The hardware-shape values are also the `source`
# field of the `vram_detected` structured event (RESILIENCE.md) — change them
# and every log pipeline grepping that field goes blind. `override` never
# appears in the event (the override path predates it) but is exposed via
# `detected_vram_source()` so placement checks (WARP-1825) can treat an
# override exactly like a dedicated card — that is what the hatch simulates.
# WARP-3046: `device_bridge` is a dedicated card too, sized by the host.
SOURCE_OVERRIDE = "override"
SOURCE_BRIDGE = "device_bridge"
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


def _card_name(sysfs_path: str) -> str:
    """``.../drm/card2/device/<attr>`` → ``card2``."""
    return Path(sysfs_path).parent.parent.name


def _drm_vendors() -> dict[str, str]:
    """``{cardN: pci-vendor-id}`` for every readable DRM card, lower-cased."""
    vendors: dict[str, str] = {}
    for path in sorted(glob.glob(_DRM_VENDOR_GLOB)):
        card = _card_name(path)
        if not _DRM_CARD_NAME.fullmatch(card):
            continue
        try:
            with open(path) as f:
                vendors[card] = f.read().strip().lower()
        except OSError:
            continue
    return vendors


def _pci_has_nvidia_display() -> bool:
    """Whether the live PCI bus carries a display-class NVIDIA function."""
    for device in sorted(glob.glob(_PCI_DEVICE_GLOB)):
        try:
            vendor = Path(device, "vendor").read_text().strip().lower()
            pci_class = Path(device, "class").read_text().strip().lower()
        except OSError:
            continue
        if vendor == _NVIDIA_VENDOR_ID and pci_class.startswith(_PCI_DISPLAY_CLASS_PREFIX):
            return True
    return False


def _nvidia_present(vendors: dict[str, str]) -> bool:
    """Whether an NVIDIA GPU is fitted, whether or not anything can size it.

    The DRM vendor map alone misses a card whose nvidia-drm module is not
    loaded — no ``/sys/class/drm`` entry at all (device-bridge.py names that
    card ``nvidia<index>`` for the same reason). ``GPU_VENDOR`` is setup.sh's
    PCI read, persisted to the ``.env`` this service loads; the live bus scan
    catches a card fitted since setup last ran.
    """
    if _NVIDIA_VENDOR_ID in vendors.values():
        return True
    if (os.getenv("GPU_VENDOR") or "").strip().lower() == "nvidia":
        return True
    return _pci_has_nvidia_display()


def _read_runtime_mem_limit_bytes() -> int | None:
    """The runtime container's memory cap in bytes, or ``None`` for no cap.

    Unset, blank or zero (docker's "unlimited") is no cap. Raises
    ``ValueError`` for a value compose itself would refuse — the caller treats
    that as "cannot size", never as "uncapped".
    """
    raw = (os.getenv(_RUNTIME_MEM_LIMIT_ENV) or "").strip()
    if not raw:
        return None
    match = _MEM_LIMIT.fullmatch(raw)
    if match is None:
        raise ValueError(raw)
    number, unit = match.groups()
    limit = int(float(number) * _MEM_LIMIT_UNITS[(unit or "").lower()])
    return limit if limit > 0 else None


def _read_dgpu_vram_bytes(glob_pattern: str) -> int | None:
    """Largest VRAM total (bytes) across the dedicated-card sysfs nodes.

    Returns ``None`` when no node matches, every match is unreadable, or every
    readable node is an integrated GPU's carve-out — the unified-memory path is
    the fallback for all three.
    """
    best: int | None = None
    for path in sorted(glob.glob(glob_pattern)):
        if not _DRM_CARD_NAME.fullmatch(_card_name(path)):
            continue
        try:
            with open(path) as f:
                value = int(f.read().strip())
        except (OSError, ValueError):
            continue
        if value < _APU_CARVE_OUT_MAX_BYTES:
            continue
        if best is None or value > best:
            best = value
    return best


def _bridge_config() -> tuple[str, str] | None:
    """``(base_url, token)`` for the host device-bridge, or ``None``.

    Same names and precedence the orchestrator uses (config.ts DEVICE_BRIDGE_URL
    with the legacy BRIDGE_URL alias; bridge-errors.ts `bridgeAuthToken()`:
    BRIDGE_AUTH_TOKEN, then SERVICE_TOKEN_DISPLAY — never DEVICE_SECRET_KEY).
    Both arrive through the service's `env_file: ../.env`. No default URL: a
    host-specific guess would be wrong on some shape, and an unconfigured
    bridge is simply "no NVIDIA source".
    """
    url = (os.getenv("DEVICE_BRIDGE_URL") or "").strip() or (
        os.getenv("BRIDGE_URL") or ""
    ).strip()
    token = (os.getenv("BRIDGE_AUTH_TOKEN") or "").strip() or (
        os.getenv("SERVICE_TOKEN_DISPLAY") or ""
    ).strip()
    if not url or not token:
        return None
    return url.rstrip("/"), token


def _is_nvidia_card(card: object, vendors: dict[str, str]) -> bool:
    if not isinstance(card, str):
        return False
    return vendors.get(card) == _NVIDIA_VENDOR_ID or bool(
        _BRIDGE_NVIDIA_FALLBACK_CARD.fullmatch(card)
    )


def _read_bridge_nvidia_vram_bytes(vendors: dict[str, str]) -> int | None:
    """The NVIDIA card's VRAM total from the device-bridge, or ``None``.

    ``None`` covers every way the bridge can fail to answer — unconfigured,
    down, 401, timeout, non-JSON — AND an answer that is not about an NVIDIA
    card. Never raises: detection must degrade to "unknown", not 500 the
    catalog.
    """
    config = _bridge_config()
    if config is None:
        return None
    url, token = config
    try:
        resp = httpx.get(
            f"{url}/gpu",
            headers={"X-Droplet-Auth": token},
            timeout=_BRIDGE_TIMEOUT_S,
        )
    except httpx.HTTPError as e:
        # The token is never logged; the exception type is enough to tell
        # "down" from "timed out".
        _struct_logger().warning("vram_bridge_unavailable", reason=type(e).__name__)
        return None
    if resp.status_code != 200:
        _struct_logger().warning("vram_bridge_unavailable", status=resp.status_code)
        return None
    try:
        body = resp.json()
    except ValueError:
        _struct_logger().warning("vram_bridge_unavailable", reason="non_json_body")
        return None
    if not isinstance(body, dict) or body.get("available") is not True:
        return None
    if not _is_nvidia_card(body.get("card"), vendors):
        return None
    total = body.get("vram_total_bytes")
    # `bool` is an `int` subclass; `True` is not a byte count.
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return None
    return total


def _read_int_env(name: str) -> int | None:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid %s=%r — ignoring", name, raw)
        return None


def _bytes_to_gb(total_bytes: int) -> int:
    # Round rather than floor: drivers report raw byte counts that fall a
    # little short of the marketing GB figure (a "16 GB" card reports
    # 17,095,983,104 B ≈ 15.92 GiB via sysfs, 17,103,323,136 B via nvidia-smi)
    # — floor would under-report a card like that by a full GB.
    return round(total_bytes / (1024**3))


def _measure() -> tuple[int | None, str | None]:
    """One uncached detection pass: ``(gb, source)``, both ``None`` if unknown."""
    override = _read_int_env("VRAM_OVERRIDE_GB")
    if override is not None:
        return override, SOURCE_OVERRIDE

    vendors = _drm_vendors()
    bridge_bytes = _read_bridge_nvidia_vram_bytes(vendors)
    if bridge_bytes is not None:
        gb = _bytes_to_gb(bridge_bytes)
        _struct_logger().info("vram_detected", source=SOURCE_BRIDGE, vram_gb=gb)
        return gb, SOURCE_BRIDGE

    if _nvidia_present(vendors):
        # An NVIDIA card is fitted and nothing could size it. Every remaining
        # source would describe a DIFFERENT memory — the iGPU carve-out or
        # system RAM — so the only true answer is "unknown".
        _struct_logger().warning(
            "vram_detection_failed",
            reason="nvidia_card_unsized",
            defaulting_to_gb=None,
        )
        return None, None

    dgpu_bytes = _read_dgpu_vram_bytes(_DGPU_VRAM_GLOB)
    if dgpu_bytes is not None:
        gb = _bytes_to_gb(dgpu_bytes)
        _struct_logger().info("vram_detected", source=SOURCE_DGPU, vram_gb=gb)
        return gb, SOURCE_DGPU

    reserve = _read_int_env("VRAM_RESERVE_GB")
    if reserve is None:
        reserve = 2

    kb = _read_memtotal_kb(_MEMINFO_PATH)
    if kb is None:
        # Emit the structured event RESILIENCE.md documents so JSON log
        # pipelines can filter on `vram_detection_failed`. See LLM-08.
        # WARP-194: never cached (see `detect`), so a transiently unreadable
        # /proc/meminfo (e.g. during an OOM event) self-heals on the next call.
        _struct_logger().warning(
            "vram_detection_failed", path=_MEMINFO_PATH, defaulting_to_gb=None
        )
        return None, None

    try:
        limit_bytes = _read_runtime_mem_limit_bytes()
    except ValueError:
        _struct_logger().warning(
            "vram_detection_failed",
            reason="runtime_mem_limit_unreadable",
            value=os.getenv(_RUNTIME_MEM_LIMIT_ENV),
            defaulting_to_gb=None,
        )
        return None, None

    gb = max(0, kb // (1024 * 1024) - reserve)
    if limit_bytes is None:
        _struct_logger().info("vram_detected", source=SOURCE_UNIFIED, vram_gb=gb)
        return gb, SOURCE_UNIFIED
    # WARP-3046: floored — a 4.75 GiB cgroup does not hold a 5 GB model.
    limit_gb = limit_bytes // 1024**3
    gb = min(gb, limit_gb)
    _struct_logger().info(
        "vram_detected", source=SOURCE_UNIFIED, vram_gb=gb, runtime_mem_limit_gb=limit_gb
    )
    return gb, SOURCE_UNIFIED


def detect() -> tuple[int | None, str | None]:
    """``(gb, source)`` of memory headroom available for model loading.

    Resolution order:
        1. VRAM_OVERRIDE_GB env var (testing hatch).
        2. The host device-bridge, when it reports an NVIDIA card.
        3. Any NVIDIA card (DRM node, GPU_VENDOR=nvidia, or a display-class
           NVIDIA PCI function) with no answer from 2 → unknown.
        4. Dedicated-GPU sysfs (`mem_info_vram_total`), carve-outs skipped,
           no reserve subtracted.
        5. /proc/meminfo MemTotal minus VRAM_RESERVE_GB (default 2), capped
           at DMR_MEM_LIMIT when that is set.
        6. Unknown if none of the above is readable.

    Unknown is ``(None, None)``. One pass answers both halves, so a caller
    that needs the number and its source never probes the bridge twice.
    """
    global _cached_gb, _cached_source
    if _cached_gb is not None:
        return _cached_gb, _cached_source
    gb, source = _measure()
    # Cache only a positive, sourced result (an override is cached whatever
    # its value: it is the operator's explicit answer, not a measurement).
    if gb is not None and (gb > 0 or source == SOURCE_OVERRIDE):
        _cached_gb = gb
        _cached_source = source
    return gb, source


async def detect_async() -> tuple[int | None, str | None]:
    """:func:`detect` on a worker thread, for async handlers.

    Detection can make a blocking HTTP call to the device-bridge (bounded by
    :data:`_BRIDGE_TIMEOUT_S`); running it inline would stall the event loop
    and every other route with it.
    """
    return await asyncio.to_thread(detect)


def detected_vram_gb() -> int | None:
    """GB of memory headroom for model loading, or ``None`` when unknown."""
    return detect()[0]


def detected_vram_source() -> str | None:
    """Which source produced the detection, running it if needed.

    ``None`` when detection could not size the box. Placement verification
    (WARP-1825) gates on this: ``size_vram`` only means "weights on the card"
    for :data:`SOURCE_DGPU` / :data:`SOURCE_BRIDGE` / :data:`SOURCE_OVERRIDE`.
    """
    return detect()[1]
