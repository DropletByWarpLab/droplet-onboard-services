"""TFTDisplay boot/shutdown behaviour (WARP-624).

All tests run on the sim backend (see conftest). The readiness transition
is driven through `_readiness_tick(now=...)` with an injected clock and a
monkeypatched `_check_readiness`, so nothing here sleeps or hits the network.
"""

from __future__ import annotations

import os

import pytest
from PIL import Image

import display as display_module
from display import TFTDisplay, WIDTH, HEIGHT


# --- Mode constants + initial state ----------------------------------------

def test_boot_and_shutdown_mode_constants_exist():
    assert TFTDisplay.BOOT == "boot"
    assert TFTDisplay.SHUTDOWN == "shutdown"


def test_initial_mode_is_boot(sim_display: TFTDisplay):
    # A cold construction must open on the boot screen, not HOME, so a
    # power-on reads "Starting Droplet" until readiness flips it.
    assert sim_display._current_mode == TFTDisplay.BOOT


def test_boot_complete_flag_starts_false(sim_display: TFTDisplay):
    # Explicit state flag — readiness is never derived from absence.
    assert sim_display._boot_complete is False


# --- Sim renderers ----------------------------------------------------------

def test_render_boot_returns_full_frame(sim_display: TFTDisplay):
    img = sim_display.render_boot("Starting services", detail="ollama", pct=40)
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_boot_indeterminate_when_pct_absent(sim_display: TFTDisplay):
    # No pct => indeterminate band; must still render a valid frame.
    img = sim_display.render_boot("Starting", detail="", pct=None)
    assert img.size == (WIDTH, HEIGHT)


def test_render_shutdown_returns_full_frame(sim_display: TFTDisplay):
    img = sim_display.render_shutdown(reason="system shutdown", phase="stopping")
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_shutdown_halted_phase(sim_display: TFTDisplay):
    img = sim_display.render_shutdown(reason="", phase="halted")
    assert img.size == (WIDTH, HEIGHT)


# --- show_boot / show_shutdown ---------------------------------------------

def test_show_boot_sets_mode_and_writes_frame(sim_display: TFTDisplay, tmp_path):
    out = tmp_path / "boot.png"
    display_module.SIM_OUTPUT = out  # redirect preview for this assertion
    sim_display.show_boot("Starting services", detail="ollama", pct=25)
    assert sim_display._current_mode == TFTDisplay.BOOT
    assert out.exists()
    with Image.open(out) as im:
        assert im.size == (WIDTH, HEIGHT)


def test_show_shutdown_sets_mode_and_writes_frame(sim_display: TFTDisplay, tmp_path):
    out = tmp_path / "shutdown.png"
    display_module.SIM_OUTPUT = out
    sim_display.show_shutdown(reason="system shutdown", phase="stopping")
    assert sim_display._current_mode == TFTDisplay.SHUTDOWN
    assert out.exists()
    with Image.open(out) as im:
        assert im.size == (WIDTH, HEIGHT)


def test_show_shutdown_stops_cycle(sim_display: TFTDisplay):
    # The cycle loop must not overwrite the shutdown frame during teardown.
    sim_display._cycle_running = True
    sim_display.show_shutdown(reason="system shutdown", phase="stopping")
    assert sim_display._cycle_running is False


# --- Readiness transition (boot -> live) ------------------------------------

def test_readiness_tick_flips_boot_when_ready(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: True)
    sim_display._boot_started_at = 1000.0
    # First gated tick after the 2s cadence; readiness satisfied -> transition.
    sim_display._readiness_tick(now=1003.0)
    assert sim_display._boot_complete is True
    assert sim_display._current_mode == TFTDisplay.STATS


def test_readiness_tick_times_out_to_live(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # Never ready, but past BOOT_MAX_SECONDS => surface the UI anyway so a
    # degraded stack still shows something.
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: False)
    monkeypatch.setattr(display_module, "BOOT_MAX_SECONDS", 90)
    sim_display._boot_started_at = 1000.0
    sim_display._readiness_tick(now=1000.0 + 91)
    assert sim_display._boot_complete is True
    assert sim_display._current_mode == TFTDisplay.STATS


def test_readiness_tick_stays_on_boot_before_ready_and_before_timeout(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: False)
    monkeypatch.setattr(display_module, "BOOT_MAX_SECONDS", 90)
    sim_display._boot_started_at = 1000.0
    sim_display._readiness_tick(now=1005.0)  # 5s elapsed, not ready, not timed out
    assert sim_display._boot_complete is False
    assert sim_display._current_mode == TFTDisplay.BOOT


def test_readiness_tick_is_gated_between_checks(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # Cheap: don't probe readiness on every ~80ms cycle tick. Two ticks
    # inside the 2s window must only call _check_readiness once.
    calls = {"n": 0}

    def _count():
        calls["n"] += 1
        return False

    monkeypatch.setattr(sim_display, "_check_readiness", _count)
    sim_display._boot_started_at = 1000.0
    sim_display._readiness_tick(now=1000.5)
    sim_display._readiness_tick(now=1001.0)  # < 2s after the first probe
    assert calls["n"] == 1


def test_readiness_tick_noop_after_complete(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # Once boot is done, the tick must never yank the user back or re-probe.
    sim_display._boot_complete = True
    sim_display._set_mode(TFTDisplay.DEVICES, pause_cycle=False)
    probed = {"n": 0}
    monkeypatch.setattr(
        sim_display, "_check_readiness", lambda: probed.__setitem__("n", probed["n"] + 1) or True
    )
    sim_display._readiness_tick(now=9999.0)
    assert probed["n"] == 0
    assert sim_display._current_mode == TFTDisplay.DEVICES


def test_check_readiness_true_on_2xx(monkeypatch: pytest.MonkeyPatch):
    # _check_readiness must return True only on a 2xx from the readiness URL,
    # and swallow connection errors as "not ready" (no exception escapes).
    d = TFTDisplay()

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(display_module.urllib.request, "urlopen", lambda *a, **k: _Resp())
    assert d._check_readiness() is True


def test_check_readiness_false_on_error(monkeypatch: pytest.MonkeyPatch):
    d = TFTDisplay()

    def _boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(display_module.urllib.request, "urlopen", _boom)
    assert d._check_readiness() is False


def test_readiness_url_defaults_to_loopback():
    # Host-specific defaults are banned; loopback (same-host orchestrator
    # behind the gateway) matches device-bridge.service's ORCHESTRATOR_URL.
    assert display_module.BOOT_READINESS_URL.startswith("http://127.0.0.1")
