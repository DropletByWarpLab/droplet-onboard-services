"""Unit tests for the device-bridge GPU telemetry probe (WARP-1861).

Diagnosing "why is the GPU pinned?" used to mean SSHing to the box and
reading sysfs by hand: nothing in the product could answer it. The Models
page hardcoded `gpu: null`, hardware-summary left `util`/`temp_c` null, and
the only component that read the card at all was the rack panel — which
cannot say *who* is using it.

This bridge runs on the host, so it can read both halves: the card's own
counters from /sys/class/drm, and the processes holding it from
/sys/class/kfd. Container attribution comes from /proc/<pid>/cgroup, which
already carries the container id — no Docker socket needed.

Card resolution is the subtle part and is why these tests carry a decoy.
The mini-rack exposes TWO amdgpu nodes: a 15.9 GiB discrete card and a
512 MiB iGPU carve-out. The iGPU also publishes mem_info_vram_used, and its
~17 MiB sits permanently below any multi-GiB "is the card free?" threshold —
so a resolver that picks the lowest index, or hardcodes a card, silently
describes the wrong device and reads as "idle" forever. Resolve by largest
mem_info_vram_total, as scripts/dmr/flip-single-box.sh already does.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_gpu_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ─── fixture sysfs trees ────────────────────────────────────────────────

def _write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


def _make_drm(root: Path, cards: dict[str, dict]) -> Path:
    """Build a fake /sys/class/drm.

    `cards` maps node name -> attribute dict. A node whose dict is None is a
    connector entry (cardN-HDMI-A-3), created with no device/ subdir.
    """
    drm = root / "drm"
    for name, attrs in cards.items():
        if attrs is None:
            (drm / name).mkdir(parents=True, exist_ok=True)
            continue
        dev = drm / name / "device"
        for key, val in attrs.items():
            if key == "hwmon":
                for hk, hv in val.items():
                    _write(dev / "hwmon" / "hwmon3" / hk, f"{hv}\n")
            else:
                _write(dev / key, f"{val}\n")
    return drm


# The measured lab-box shape: card1 = 15.9 GiB dGPU under load,
# card2 = 512 MiB iGPU carve-out sitting idle. card1-HDMI-A-3 is a
# connector, not a card.
_LAB_BOX = {
    "card1": {
        "mem_info_vram_total": 17095983104,
        "mem_info_vram_used": 14190886912,
        "gpu_busy_percent": 97,
        "hwmon": {"power1_average": 164000000, "temp1_input": 62000},
    },
    "card2": {
        "mem_info_vram_total": 536870912,
        "mem_info_vram_used": 18186240,
        "gpu_busy_percent": 0,
        "hwmon": {"temp1_input": 47000},
    },
    "card1-HDMI-A-3": None,
}


# ─── card resolution ────────────────────────────────────────────────────

def test_resolves_the_discrete_card_not_the_lowest_index(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Largest VRAM wins. Here it happens to also be card1 — the point is
    the RULE, which the next test pins with the order reversed."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge.resolve_gpu_card() == "card1"


def test_igpu_at_lower_index_does_not_win(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The decoy: a 512 MiB iGPU enumerated FIRST must not be picked.

    A lowest-index resolver returns card0 here and reports a permanently
    idle 512 MiB device while the real card is saturated.
    """
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, {
        "card0": {"mem_info_vram_total": 536870912,
                  "mem_info_vram_used": 18186240, "gpu_busy_percent": 0},
        "card1": {"mem_info_vram_total": 17095983104,
                  "mem_info_vram_used": 14190886912, "gpu_busy_percent": 97},
    })
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge.resolve_gpu_card() == "card1"


def test_card_sort_is_numeric_not_lexical(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """card10 must not sort before card2 — and largest-VRAM must still win."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, {
        "card2": {"mem_info_vram_total": 536870912, "gpu_busy_percent": 0},
        "card10": {"mem_info_vram_total": 17095983104, "gpu_busy_percent": 97},
    })
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge.resolve_gpu_card() == "card10"


def test_connector_entries_are_skipped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """cardN-HDMI-A-3 is a connector; it has no device/ and must be ignored."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge._drm_cards() == ["card1", "card2"]


def test_env_pin_overrides_resolution(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An explicit BRIDGE_GPU_CARD pin wins over the largest-VRAM rule."""
    bridge = _load_bridge(monkeypatch, {"BRIDGE_GPU_CARD": "card2"})
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge.resolve_gpu_card() == "card2"


def test_env_pin_naming_a_missing_card_resolves_to_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A pin that doesn't exist is a misconfiguration, not a fallback.

    Silently falling back would make the pin untrustworthy — an operator who
    pinned the wrong name would get plausible numbers from another device.
    """
    bridge = _load_bridge(monkeypatch, {"BRIDGE_GPU_CARD": "card9"})
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    assert bridge.resolve_gpu_card() is None


def test_no_cards_resolves_to_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An empty/absent drm tree yields None — never a card name."""
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(tmp_path / "nonexistent"))
    assert bridge.resolve_gpu_card() is None


# ─── snapshot ───────────────────────────────────────────────────────────

def test_snapshot_reports_the_discrete_card_under_load(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(tmp_path / "nokfd"))

    snap = bridge.gpu_snapshot()
    assert snap["available"] is True
    assert snap["card"] == "card1"
    assert snap["busy_percent"] == 97
    assert snap["vram_total_bytes"] == 17095983104
    assert snap["vram_used_bytes"] == 14190886912
    # Derived for the dashboard tile so two surfaces can't disagree on the
    # arithmetic. 14190886912/17095983104 = 0.83.
    assert snap["vram_used_fraction"] == pytest.approx(0.83, abs=0.01)
    assert snap["power_watts"] == pytest.approx(164.0, abs=0.1)
    assert snap["temp_c"] == pytest.approx(62.0, abs=0.1)


def test_missing_card_is_unavailable_not_idle(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """"No GPU found" must never render as a healthy idle GPU.

    The `|| echo 0` reflex produces exactly that lie: a 0% reading that a
    threshold check happily passes.
    """
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(tmp_path / "nonexistent"))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(tmp_path / "nokfd"))

    snap = bridge.gpu_snapshot()
    assert snap["available"] is False
    assert snap["card"] is None
    assert snap["busy_percent"] is None, "absent must be null, never 0"
    assert snap["vram_total_bytes"] is None
    assert snap["reason"]


def test_unreadable_attribute_is_null_not_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A card present but missing gpu_busy_percent reports null for it.

    Partial sysfs is normal across driver versions; the card is still
    available and its other counters still mean something.
    """
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, {
        "card1": {"mem_info_vram_total": 17095983104,
                  "mem_info_vram_used": 1000},
    })
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(tmp_path / "nokfd"))

    snap = bridge.gpu_snapshot()
    assert snap["available"] is True
    assert snap["busy_percent"] is None
    assert snap["vram_used_bytes"] == 1000


# ─── process attribution ────────────────────────────────────────────────

def _make_kfd(root: Path, pids: list[str]) -> Path:
    kfd = root / "kfd"
    for pid in pids:
        (kfd / pid).mkdir(parents=True, exist_ok=True)
    return kfd


def _make_proc(root: Path, procs: dict[str, dict]) -> Path:
    proc = root / "proc"
    for pid, attrs in procs.items():
        d = proc / pid
        d.mkdir(parents=True, exist_ok=True)
        (d / "comm").write_text(attrs.get("comm", "") + "\n")
        (d / "cmdline").write_text(attrs.get("cmdline", ""))
        (d / "cgroup").write_text(attrs.get("cgroup", ""))
    return proc


def test_attributes_gpu_processes_to_their_container(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The whole point: name WHAT is using the GPU, not just how much."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    kfd = _make_kfd(tmp_path, ["2325005"])
    proc = _make_proc(tmp_path, {
        "2325005": {
            "comm": "llama-server",
            "cmdline": "/app/llama-server\x00-ngl\x00999\x00--metrics\x00",
            "cgroup": "0::/system.slice/docker-"
                      "3f9a2b1c4d5e6f708192a3b4c5d6e7f8"
                      "091a2b3c4d5e6f708192a3b4c5d6e7f8.scope\n",
        },
    })
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(kfd))
    monkeypatch.setattr(bridge, "_PROC", str(proc))

    snap = bridge.gpu_snapshot()
    assert len(snap["processes"]) == 1
    p = snap["processes"][0]
    assert p["pid"] == 2325005
    assert p["comm"] == "llama-server"
    assert "--metrics" in p["cmdline"], "NULs must be rendered as spaces"
    assert p["container_id"] == "3f9a2b1c4d5e"


def test_process_without_a_container_reports_null_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A host process holding the GPU is legitimate — don't invent an id."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    kfd = _make_kfd(tmp_path, ["4242"])
    proc = _make_proc(tmp_path, {
        "4242": {"comm": "rocm-smi", "cmdline": "rocm-smi\x00",
                 "cgroup": "0::/user.slice/user-1000.slice\n"},
    })
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(kfd))
    monkeypatch.setattr(bridge, "_PROC", str(proc))

    p = bridge.gpu_snapshot()["processes"][0]
    assert p["comm"] == "rocm-smi"
    assert p["container_id"] is None


def test_dead_pid_between_listing_and_read_is_dropped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A process can exit between the kfd listing and the /proc read.

    That race is ordinary, not an error — the entry is skipped rather than
    surfacing a half-null row or blowing up the whole snapshot.
    """
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    kfd = _make_kfd(tmp_path, ["999999"])          # listed in kfd...
    proc = _make_proc(tmp_path, {})                 # ...but gone from /proc
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(kfd))
    monkeypatch.setattr(bridge, "_PROC", str(proc))

    snap = bridge.gpu_snapshot()
    assert snap["processes"] == []
    assert snap["available"] is True, "a dead pid must not sink the snapshot"


def test_non_numeric_kfd_entries_are_ignored(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """/sys/class/kfd/kfd/proc holds pid-named dirs; anything else is noise."""
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    kfd = _make_kfd(tmp_path, ["notapid"])
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(kfd))
    monkeypatch.setattr(bridge, "_PROC", str(tmp_path / "proc"))

    assert bridge.gpu_snapshot()["processes"] == []


# ─── route wiring ───────────────────────────────────────────────────────

class _FakeRequest:
    """Minimal stand-in so we can drive Handler.do_GET without a socket."""

    def __init__(self, headers: dict):
        self._headers = headers
        self.sent: list = []

    def makefile(self, *a, **k):  # pragma: no cover - BaseHTTPRequestHandler
        raise AssertionError("no socket I/O in these tests")


def _drive_get(bridge, path: str, headers: dict, tmp_path: Path):
    """Call Handler.do_GET for `path`, capturing the (status, body) it sends."""
    handler = bridge.Handler.__new__(bridge.Handler)
    handler.path = path
    handler.headers = headers
    captured: dict = {}

    def _send(status, obj):
        captured["status"] = status
        captured["body"] = obj

    handler._send = _send
    handler.do_GET()
    return captured["status"], captured["body"]


def test_gpu_route_requires_auth(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """GPU telemetry names running processes and their command lines —
    box-internal detail, gated exactly like /host/topology and /drives."""
    bridge = _load_bridge(monkeypatch)
    status, body = _drive_get(bridge, "/gpu", {}, tmp_path)
    assert status == 401
    assert body == {"error": "unauthorized"}


def test_gpu_route_returns_snapshot_when_authed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = _load_bridge(monkeypatch)
    drm = _make_drm(tmp_path, _LAB_BOX)
    monkeypatch.setattr(bridge, "_SYS_DRM", str(drm))
    monkeypatch.setattr(bridge, "_SYS_KFD_PROC", str(tmp_path / "nokfd"))

    status, body = _drive_get(
        bridge, "/gpu", {"X-Droplet-Auth": "pytest-bridge-token"}, tmp_path)
    assert status == 200
    assert body["card"] == "card1"
    assert body["busy_percent"] == 97
