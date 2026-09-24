"""Tests for the VRAM detection module."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest


def _write_meminfo(tmp_path: Path, kb_total: int) -> Path:
    p = tmp_path / "meminfo"
    p.write_text(f"MemTotal:     {kb_total} kB\nMemFree: 100 kB\n")
    return p


def test_detects_total_minus_reserve(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    # 8 GiB in kB
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 6


def test_override_env_wins(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "12")
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 4 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 12


def test_invalid_override_falls_back(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "not-a-number")
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 14


def test_missing_meminfo_is_unknown_not_zero(tmp_path, monkeypatch):
    """WARP-3046: an unreadable source means UNKNOWN (None), not "0 GB of
    GPU". 0 is a measurement the catalog renders as "nothing fits"; None is
    the honest "couldn't size this box"."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(tmp_path / "nope"))

    assert vram.detected_vram_gb() is None


def test_unparseable_meminfo_is_unknown_not_zero(tmp_path, monkeypatch):
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    p = tmp_path / "meminfo"
    p.write_text("garbage without MemTotal\n")
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(p))

    assert vram.detected_vram_gb() is None


def test_detection_failure_emits_structured_event(tmp_path, monkeypatch):
    """On meminfo failure, the documented `vram_detection_failed` structured
    event is emitted (RESILIENCE.md tells operators to grep for it). See LLM-08.
    """
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    missing = tmp_path / "nope"
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(missing))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() is None

    events = [e for e in logs if e.get("event") == "vram_detection_failed"]
    assert len(events) == 1, f"expected one vram_detection_failed event, got: {logs}"
    assert events[0]["path"] == str(missing)
    assert events[0]["log_level"] == "warning"


def test_caches_result(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    first = vram.detected_vram_gb()
    # Mutate underlying file — cache should not refresh
    meminfo.write_text("MemTotal: 1 kB\n")
    second = vram.detected_vram_gb()
    assert first == second == 14


def _write_dgpu_node(tmp_path: Path, card: str, bytes_total: int) -> None:
    node = tmp_path / "drm" / card / "device" / "mem_info_vram_total"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text(str(bytes_total))


def _dgpu_glob(tmp_path: Path) -> str:
    return str(tmp_path / "drm" / "card*" / "device" / "mem_info_vram_total")


# ── WARP-1111 §7.4: dGPU sysfs detection ──


def test_dgpu_sysfs_preferred_over_meminfo(tmp_path, monkeypatch):
    """A dedicated-GPU sysfs node wins over /proc/meminfo, and its number is
    used as-is (no VRAM_RESERVE_GB subtraction — the GPU's memory isn't
    shared with the OS)."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    # 17,095,983,104 B is the live-box's real reading for its "16 GB" card
    # (architecture brief §3.1) — rounds to 16, not floors to 15.
    _write_dgpu_node(tmp_path, "card0", 17_095_983_104)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))
    # meminfo would give a very different (wrong, for a dGPU host) answer —
    # prove it's not what's being read.
    meminfo = _write_meminfo(tmp_path, 30 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 16


def test_dgpu_sysfs_picks_max_across_cards(tmp_path, monkeypatch):
    """A box with both a dedicated card and an integrated GPU (e.g. this
    appliance's Raphael iGPU) reports both sysfs nodes — take the larger,
    landing on the dedicated card without identifying it by vendor ID."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 536_870_912)  # ~512 MiB iGPU
    _write_dgpu_node(tmp_path, "card1", 17_179_869_184)  # exactly 16 GiB dGPU
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 16


def test_dgpu_sysfs_skips_unreadable_node(tmp_path, monkeypatch):
    """A garbage/unreadable sysfs node is skipped, not fatal — the remaining
    readable node still wins."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    node = tmp_path / "drm" / "card0" / "device" / "mem_info_vram_total"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text("not-a-number")
    _write_dgpu_node(tmp_path, "card1", 8_589_934_592)  # exactly 8 GiB
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 8


def test_dgpu_sysfs_absent_falls_back_to_meminfo(tmp_path, monkeypatch):
    """No dGPU sysfs node at all (unified-memory host) — behave exactly as
    before this change."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))  # no nodes written
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 6


def test_override_wins_over_dgpu_sysfs(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "12")
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 12


def test_dgpu_detection_emits_structured_event_with_source(tmp_path, monkeypatch):
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() == 16

    events = [e for e in logs if e.get("event") == "vram_detected"]
    assert len(events) == 1, f"expected one vram_detected event, got: {logs}"
    assert events[0]["source"] == "dgpu_sysfs"
    assert events[0]["vram_gb"] == 16


def test_unified_memory_detection_emits_structured_event_with_source(tmp_path, monkeypatch):
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))  # no nodes
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() == 6

    events = [e for e in logs if e.get("event") == "vram_detected"]
    assert len(events) == 1
    assert events[0]["source"] == "unified_memory"
    assert events[0]["vram_gb"] == 6


def test_dgpu_sysfs_result_is_cached(tmp_path, monkeypatch):
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    first = vram.detected_vram_gb()
    _write_dgpu_node(tmp_path, "card0", 1)  # mutate — cache should not refresh
    second = vram.detected_vram_gb()
    assert first == second == 16


def test_failed_detection_is_not_cached(tmp_path, monkeypatch):
    """A transient meminfo read failure must NOT be cached — the next call
    re-attempts detection so a device that hit an OOM event self-heals instead
    of staying stuck at 0 GB headroom until restart (WARP-194)."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(tmp_path / "nope"))

    # First call: meminfo unreadable → unknown, and crucially it is not cached.
    assert vram.detected_vram_gb() is None
    assert vram._cached_gb is None

    # meminfo becomes readable again → detection recovers on the next call.
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))
    assert vram.detected_vram_gb() == 14


# ── WARP-3046: vendor-aware detection ────────────────────────────────────
#
# Every fixture above is AMD-shaped (a dGPU node next to an iGPU node), which
# is exactly why none of them noticed when .195's card became an NVIDIA RTX
# 5060 Ti: the nvidia driver publishes NO `mem_info_vram_total`, so the only
# node left was the Raphael iGPU's 512 MiB carve-out, round(0.5) = 0, and that
# 0 was cached as a successful `dgpu_sysfs` read. The fixtures below model the
# real .195 tree (measured live 2026-09-23): card1 = 0x10de with no mem_info
# node, card2 = 0x1002 with 536870912 bytes.

BRIDGE_URL = "http://bridge.test:9090"
BRIDGE_TOKEN = "bridge-token-for-tests"
# The device-bridge's GET /gpu on .195, verbatim in the fields vram.py reads.
NVIDIA_BRIDGE_SNAPSHOT = {
    "available": True,
    "card": "card1",
    "name": "NVIDIA GeForce RTX 5060 Ti",
    "reason": None,
    "vram_total_bytes": 17_103_323_136,
    "processes": [],
}
IGPU_CARVE_OUT_BYTES = 536_870_912


def _write_vendor(tmp_path: Path, card: str, vendor: str) -> None:
    node = tmp_path / "drm" / card / "device" / "vendor"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text(f"{vendor}\n")


def _point_sysfs_at(tmp_path: Path, monkeypatch) -> None:
    import vram
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))
    monkeypatch.setattr(
        vram, "_DRM_VENDOR_GLOB", str(tmp_path / "drm" / "card*" / "device" / "vendor")
    )


def _nvidia_plus_igpu(tmp_path: Path, monkeypatch) -> None:
    """The .195 tree: an NVIDIA dGPU with no node, an AMD iGPU carve-out.

    MemTotal is pinned to .195's 30 GiB so that falling through to the
    unified-memory path would read a confident 28 — an "unknown" result must
    come from the NVIDIA rule, never from the test host lacking /proc/meminfo.
    """
    import vram
    _write_vendor(tmp_path, "card1", "0x10de")
    _write_vendor(tmp_path, "card2", "0x1002")
    _write_dgpu_node(tmp_path, "card2", IGPU_CARVE_OUT_BYTES)
    _point_sysfs_at(tmp_path, monkeypatch)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 30 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))


def _configure_bridge(monkeypatch, *, token_var: str = "SERVICE_TOKEN_DISPLAY") -> None:
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("DEVICE_BRIDGE_URL", BRIDGE_URL)
    monkeypatch.setenv(token_var, BRIDGE_TOKEN)


def test_nvidia_card_is_sized_from_the_bridge_not_the_igpu(tmp_path, monkeypatch, respx_mock):
    """The .195 regression: 16, from the bridge — never the carve-out's 0."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    route = respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json=NVIDIA_BRIDGE_SNAPSHOT)

    assert vram.detected_vram_gb() == 16
    assert vram.detected_vram_source() == vram.SOURCE_BRIDGE
    # The bridge's own auth header, with the token the orchestrator also uses
    # as its fallback (bridge-errors.ts `bridgeAuthToken()`).
    assert route.calls.last.request.headers["X-Droplet-Auth"] == BRIDGE_TOKEN


def test_bridge_auth_token_wins_over_the_display_token(tmp_path, monkeypatch, respx_mock):
    """Same precedence as the orchestrator: BRIDGE_AUTH_TOKEN, then
    SERVICE_TOKEN_DISPLAY — never DEVICE_SECRET_KEY."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "the-dedicated-one")
    route = respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json=NVIDIA_BRIDGE_SNAPSHOT)

    assert vram.detected_vram_gb() == 16
    assert route.calls.last.request.headers["X-Droplet-Auth"] == "the-dedicated-one"


@pytest.mark.parametrize(
    "failure",
    [
        {"side_effect": httpx.ConnectError("connection refused")},
        {"side_effect": httpx.ReadTimeout("timed out")},
        {"return_value": httpx.Response(401, json={"error": "unauthorized"})},
        {"return_value": httpx.Response(500, text="boom")},
        {"return_value": httpx.Response(200, text="not json")},
    ],
    ids=["down", "timeout", "401", "500", "garbage"],
)
def test_bridge_failure_on_an_nvidia_box_is_unknown_and_not_cached(
    tmp_path, monkeypatch, respx_mock, failure
):
    """A bridge that is down must read as UNKNOWN (None) — not 0, and not the
    iGPU — and must not be cached, so the next call's healthy answer is used."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    route = respx_mock.get(f"{BRIDGE_URL}/gpu")
    route.mock(**failure)

    assert vram.detected_vram_gb() is None
    assert vram.detected_vram_source() is None
    assert vram._cached_gb is None

    route.mock(return_value=httpx.Response(200, json=NVIDIA_BRIDGE_SNAPSHOT))
    assert vram.detected_vram_gb() == 16
    assert vram.detected_vram_source() == vram.SOURCE_BRIDGE


def test_nvidia_card_without_a_configured_bridge_is_unknown(tmp_path, monkeypatch):
    """No NVIDIA source at all: unknown. Falling through to the iGPU (0) or
    to MemTotal (RAM the card cannot use) would both be a confident lie."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _nvidia_plus_igpu(tmp_path, monkeypatch)

    assert vram.detected_vram_gb() is None


def test_bridge_echoing_the_amd_igpu_is_not_trusted(tmp_path, monkeypatch, respx_mock):
    """The bridge's AMD path is 'largest mem_info node wins' too — with no
    nvidia-smi on the host it answers with the iGPU carve-out. Only an NVIDIA
    answer is trusted; on an NVIDIA box anything else is unknown."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json={
        "available": True, "card": "card2", "name": "Raphael",
        "vram_total_bytes": IGPU_CARVE_OUT_BYTES,
    })

    assert vram.detected_vram_gb() is None


def test_bridge_nvidia_answer_without_a_drm_node_is_trusted(tmp_path, monkeypatch, respx_mock):
    """nvidia-drm not loaded: no DRM card for the NVIDIA GPU at all, so the
    bridge names it `nvidia<index>` (device-bridge.py nvidia_snapshot). That
    name is only ever produced by the NVIDIA path, so it is trusted."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_vendor(tmp_path, "card0", "0x1002")
    _write_dgpu_node(tmp_path, "card0", IGPU_CARVE_OUT_BYTES)
    _point_sysfs_at(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    respx_mock.get(f"{BRIDGE_URL}/gpu").respond(
        200, json={**NVIDIA_BRIDGE_SNAPSHOT, "card": "nvidia0"}
    )

    assert vram.detected_vram_gb() == 16


@pytest.mark.parametrize("total", [None, 0, -1, "17103323136", True])
def test_bridge_nvidia_answer_without_a_usable_total_is_unknown(
    tmp_path, monkeypatch, respx_mock, total
):
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    respx_mock.get(f"{BRIDGE_URL}/gpu").respond(
        200, json={**NVIDIA_BRIDGE_SNAPSHOT, "vram_total_bytes": total}
    )

    assert vram.detected_vram_gb() is None


def test_bridge_result_is_cached(tmp_path, monkeypatch, respx_mock):
    """A positive, sourced answer is cached: the card does not change size at
    runtime, and the catalog read must not cost a bridge round-trip each time."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    route = respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json=NVIDIA_BRIDGE_SNAPSHOT)

    assert vram.detected_vram_gb() == 16
    assert vram.detected_vram_gb() == 16
    assert route.call_count == 1


def test_override_wins_over_the_bridge(tmp_path, monkeypatch, respx_mock):
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "12")
    route = respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json=NVIDIA_BRIDGE_SNAPSHOT)

    assert vram.detected_vram_gb() == 12
    assert vram.detected_vram_source() == vram.SOURCE_OVERRIDE
    assert route.call_count == 0


def test_lone_apu_carve_out_falls_through_to_unified_memory(tmp_path, monkeypatch):
    """An APU-only Ryzen box (GPU_VENDOR=amd, no dGPU): the 512 MiB carve-out
    is the only node. It is not a dedicated card — the APU draws on system RAM
    — so this is the unified-memory shape, not '0 GB of GPU'."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    _write_vendor(tmp_path, "card0", "0x1002")
    _write_dgpu_node(tmp_path, "card0", IGPU_CARVE_OUT_BYTES)
    _point_sysfs_at(tmp_path, monkeypatch)
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 14
    assert vram.detected_vram_source() == vram.SOURCE_UNIFIED


def test_real_amd_dgpu_is_unchanged_even_with_a_bridge(tmp_path, monkeypatch, respx_mock):
    """The shipping AMD shape keeps reading its own sysfs node. A configured
    bridge answering with that same AMD card is not an NVIDIA answer, so it is
    ignored rather than trusted — the sysfs read is the authority here."""
    import vram
    _write_vendor(tmp_path, "card0", "0x1002")
    _write_dgpu_node(tmp_path, "card0", 17_095_983_104)
    _write_vendor(tmp_path, "card1", "0x1002")
    _write_dgpu_node(tmp_path, "card1", IGPU_CARVE_OUT_BYTES)
    _point_sysfs_at(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    respx_mock.get(f"{BRIDGE_URL}/gpu").respond(200, json={
        "available": True, "card": "card0", "vram_total_bytes": 17_095_983_104,
    })

    assert vram.detected_vram_gb() == 16
    assert vram.detected_vram_source() == vram.SOURCE_DGPU


def test_real_amd_dgpu_is_unchanged_when_the_bridge_is_down(tmp_path, monkeypatch, respx_mock):
    import vram
    _write_vendor(tmp_path, "card0", "0x1002")
    _write_dgpu_node(tmp_path, "card0", 17_095_983_104)
    _point_sysfs_at(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    respx_mock.get(f"{BRIDGE_URL}/gpu").mock(side_effect=httpx.ConnectError("refused"))

    assert vram.detected_vram_gb() == 16


def test_connector_entries_are_not_cards(tmp_path, monkeypatch):
    """`/sys/class/drm` also lists connectors (`card1-DP-3`); only `cardN`
    names a device, so a connector can never count as an NVIDIA card."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    _write_vendor(tmp_path, "card1-DP-3", "0x10de")
    _point_sysfs_at(tmp_path, monkeypatch)
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 6


def test_zero_unified_budget_is_reported_but_not_cached(tmp_path, monkeypatch):
    """Only a POSITIVE sourced result is cached. A genuine 0 (MemTotal at or
    under the reserve) is still reported, but re-measured next call."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 1 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 0
    assert vram._cached_gb is None


def test_detect_returns_the_number_and_its_source_in_one_pass(tmp_path, monkeypatch, respx_mock):
    """`detect()` is what /models/eligible calls: one probe, both answers —
    so an unknown result can never cost the bridge two timeouts per request."""
    import vram
    _nvidia_plus_igpu(tmp_path, monkeypatch)
    _configure_bridge(monkeypatch)
    route = respx_mock.get(f"{BRIDGE_URL}/gpu").mock(side_effect=httpx.ConnectError("x"))

    assert vram.detect() == (None, None)
    assert route.call_count == 1
