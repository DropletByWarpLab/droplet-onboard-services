"""WARP-1640 — how the framebuffer backend is wired into TFTDisplay.

The one that matters most here is `test_data_pumps_are_not_gated_on_pyportal`.
Panel data (`self._v3`) is populated ONLY via `_mirror_to_v3()` <-
`_pyportal_send()`, and every pump that calls it used to be gated on
`self._backend == "pyportal"`. Add a backend without flipping those and the
rack panel renders CPU 0% / MEM 0% / DISK 0% forever, while every renderer
works perfectly — it is faithfully drawing an empty dict. That failure is
invisible in code review and obvious only on the hardware, so it is pinned
here at the source level.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

import display as display_module
from display import TFTDisplay

_SRC = Path(display_module.__file__).read_text(encoding="utf-8")


# --- backend selection ------------------------------------------------------

def test_fb_is_never_reachable_from_auto():
    """A PyPortal plugged in later must not be able to steal the panel, so fb
    is explicit-only: the cycle loop's 5s promotion path only ever considers
    'auto'/'pyportal'."""
    assert 'if BACKEND in ("auto", "pyportal")' in _SRC
    assert 'BACKEND in ("auto", "pyportal", "fb")' not in _SRC
    assert 'if BACKEND == "fb":' in _SRC


def test_missing_framebuffer_degrades_to_sim(monkeypatch):
    """A box configured for the panel that has no /dev/fb0 must still serve
    /display/preview and accept the orchestrator's pushes."""
    monkeypatch.setattr(display_module, "BACKEND", "fb")
    monkeypatch.setattr("fb.FramebufferBackend.open", staticmethod(lambda *a, **k: None))
    d = TFTDisplay()
    assert d._backend == "sim"
    assert d._fb is None


def test_fb_backend_selected_when_panel_present(monkeypatch, fake_fb):
    monkeypatch.setattr(display_module, "BACKEND", "fb")
    monkeypatch.setattr("fb.FramebufferBackend.open",
                        staticmethod(lambda *a, **k: fake_fb))
    d = TFTDisplay()
    assert d._backend == "fb"
    assert d._fb is fake_fb


# --- the data gates ---------------------------------------------------------

def test_wants_data_covers_fb_and_pyportal(sim_display: TFTDisplay):
    for backend, expected in (("pyportal", True), ("fb", True),
                              ("sim", False)):
        sim_display._backend = backend
        assert sim_display._wants_data() is expected, backend


def test_data_pumps_are_not_gated_on_pyportal():
    """Every periodic pump must go through _wants_data(). If this fails, the
    panel will render zeros forever — see the module docstring."""
    pumps = ("last_stats_push", "last_wifi_push", "last_files_push",
             "last_cams_push", "_needs_resync")
    for line in _SRC.splitlines():
        stripped = line.strip()
        if not stripped.startswith("if "):
            continue
        if any(p in stripped for p in pumps) and "now -" in stripped or \
           (stripped.startswith("if ") and "_needs_resync" in stripped):
            assert '_backend == "pyportal"' not in stripped, stripped
            assert "_wants_data()" in stripped, stripped


def test_stats_reach_v3_without_a_serial_device(sim_display: TFTDisplay):
    """_pyportal_send mirrors BEFORE its connection check, so the pumps
    populate _v3 on a backend with no serial device attached at all."""
    sim_display._backend = "fb"
    sim_display._v3["cpu"] = None
    sim_display._pyportal_send("stats", {"cpu": 42, "mem": 7, "hostname": "x"})
    assert sim_display._v3["cpu"] == 42
    assert sim_display._v3["mem"] == 7


def test_push_full_state_populates_v3_on_fb(sim_display: TFTDisplay):
    sim_display._backend = "fb"
    sim_display._v3["cpu"] = None
    sim_display._push_full_state()
    assert sim_display._v3["cpu"] is not None, \
        "full-state resync must fill the panel's data on the fb backend"


# --- _push ------------------------------------------------------------------

def test_push_blits_to_the_panel(sim_display: TFTDisplay, fake_fb):
    sim_display._fb = fake_fb
    img = Image.new("RGB", (display_module.WIDTH, display_module.HEIGHT))
    sim_display._push(img)
    assert fake_fb.blits == [img]


def test_push_still_writes_the_preview_on_fb(sim_display: TFTDisplay, fake_fb):
    """/display/preview is how the panel is verified remotely — it must keep
    working when a real framebuffer is attached."""
    sim_display._fb = fake_fb
    img = Image.new("RGB", (display_module.WIDTH, display_module.HEIGHT), (9, 9, 9))
    sim_display._push(img)
    assert display_module.SIM_OUTPUT.exists()


def test_push_survives_a_failing_panel(sim_display: TFTDisplay):
    """A panel problem must not kill the render thread."""
    class Exploding:
        width = height = stride = 0
        path = "/dev/fb0"

        def blit(self, image, **kw):
            raise OSError("device gone")

    sim_display._fb = Exploding()
    sim_display._push(Image.new("RGB", (display_module.WIDTH,
                                        display_module.HEIGHT)))


# --- status -----------------------------------------------------------------

def test_status_reports_panel_geometry(sim_display: TFTDisplay, fake_fb):
    sim_display._fb = fake_fb
    sim_display._backend = "fb"
    st = sim_display.get_status()
    assert st["backend"] == "fb"
    assert st["simulated"] is False
    assert st["panel"]["stride"] == fake_fb.stride


def test_status_panel_is_none_without_a_framebuffer(sim_display: TFTDisplay):
    assert sim_display.get_status()["panel"] is None


# --- fixtures ---------------------------------------------------------------

@pytest.fixture
def fake_fb():
    class FakeFB:
        width, height, stride = 1424, 280, 5888
        path = "/dev/fb0"

        def __init__(self):
            self.blits = []

        def blit(self, image, **kw):
            self.blits.append(image)

    return FakeFB()
