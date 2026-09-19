"""The three renderers of the Droplet mark agree on one geometry (WARP-2853).

The canonical mark is the wide drop in a 512x512 viewBox (the same points
`apps/web-dashboard/src/components/DropletMark.tsx` and
`apps/web-dashboard/public/icon.svg` draw). Three things in this service
draw it, and each one used to carry its own copy of the mapping:

  * `display.py` — the shipped Linux panel renderer (PIL),
  * `pyportal/code.py` — the CircuitPython firmware (vectorio),
  * `preview.html` — the dev-facing canvas preview, whose whole job is to
    look like the other two. Both Python files cite it by name in comments.

Nothing pinned them together, so `preview.html` was left on the OLD 52x60
geometry by the first cut of WARP-2853 and silently stopped previewing the
firmware it advertises. These tests are that pin: the numbers live in
`display.py`, and the other two are checked against it.
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path

import pytest

_SERVICE_DIR = Path(__file__).resolve().parent.parent
_PYPORTAL_DIR = _SERVICE_DIR / "pyportal"
_TESTS_DIR = Path(__file__).resolve().parent
for _p in (str(_TESTS_DIR), str(_PYPORTAL_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import display as display_module  # noqa: E402

from _cpstubs import install as install_stubs  # noqa: E402


# Sizes every call site in this service actually asks for, plus the two the
# PyPortal nav bar uses (26) and the boot/standby screens use (116 / 78).
_SIZES = (20, 22, 26, 32, 52, 64, 78, 116)
_ORIGINS = ((0, 0), (3, 7), (10, 44), (131, 44))


@pytest.fixture
def firmware():
    """pyportal/code.py imported on stubbed CircuitPython.

    Mirrors the `fw` fixture in test_code_smoke.py: `code` is a stdlib module
    name, so it is popped from sys.modules on both sides of the import.
    """
    install_stubs()
    sys.modules.pop("code", None)
    code = importlib.import_module("code")
    importlib.reload(code)
    yield code
    sys.modules.pop("code", None)


# --- display.py is the source of truth --------------------------------------

def test_mark_bbox_is_the_outer_polygon_s_real_bounding_box():
    # Projecting against the 512x512 VIEWBOX would hand every caller ~28%
    # padding it did not ask for, so both renderers project against the
    # mark's own bounding box. If that box is not the polygon's true extent
    # the mark stops being centred in the size-box.
    xs = [p[0] for p in display_module._MARK_LEFT]
    ys = [p[1] for p in display_module._MARK_LEFT]
    expected = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
    assert display_module._MARK_BBOX == expected == (92, 72, 328, 368)


def test_the_highlight_facet_stays_inside_the_outer_facet():
    # A white-on-white facet is how this mark got broken the first time.
    bx, by, bw, bh = display_module._MARK_BBOX
    for px, py in display_module._MARK_RIGHT:
        assert bx <= px <= bx + bw
        assert by <= py <= by + bh


def test_drawn_height_is_the_named_ratio_of_the_size_box():
    # The baselines under the mark (wordmark, status line) are hand-set
    # against this number, so it has to be the one the projection uses.
    for size in _SIZES:
        assert display_module._mark_height(size) == int(size * 48 / 60)


def test_no_bare_height_ratio_literal_survives_in_display_py():
    # `_MARK_HEIGHT_RATIO` exists so the ratio is stated once. A second copy
    # spelled `48 / 60` is how render_boot/render_shutdown/render_standby
    # drift away from the mark they are positioning text under.
    src = (_SERVICE_DIR / "display.py").read_text(encoding="utf-8")
    stray = [
        line for line in src.splitlines()
        if re.search(r"48\s*/\s*60", line) and "_MARK_HEIGHT_RATIO =" not in line
    ]
    assert stray == [], f"bare 48/60 literal(s) left behind: {stray}"


def test_dead_viewbox_constant_is_gone():
    # Both draw functions project against _MARK_BBOX now; the viewBox tuple
    # they used to unpack is unreferenced.
    assert not hasattr(display_module, "_MARK_VIEWBOX")


# --- pyportal/code.py mirrors it --------------------------------------------

def _display_projection(size, x, y, points):
    """What `draw_droplet_mark` would put on the panel, point for point."""
    bx, by, bw, bh = display_module._MARK_BBOX
    scale = size * display_module._MARK_HEIGHT_RATIO / bh
    x_off = x + (size - int(bw * scale)) // 2
    return [(int(x_off + (px - bx) * scale), int(y + (py - by) * scale))
            for px, py in points]


def test_pyportal_carries_the_same_points_as_display(firmware):
    assert [tuple(p) for p in firmware._MARK_OUTER] == \
        [tuple(p) for p in display_module._MARK_LEFT]
    assert [tuple(p) for p in firmware._MARK_INNER] == \
        [tuple(p) for p in display_module._MARK_RIGHT]
    assert (firmware._MARK_BX, firmware._MARK_BY,
            firmware._MARK_BW, firmware._MARK_BH) == display_module._MARK_BBOX
    assert firmware._MARK_H_RATIO == display_module._MARK_HEIGHT_RATIO


def test_pyportal_projects_to_the_same_pixels_as_display(firmware):
    # One scale for both axes. Deriving the x scale from an already-truncated
    # height skews the drop ~4.6% at size=26 (the nav-bar icon), which is the
    # kind of thing that only shows up next to the real renderer.
    for size in _SIZES:
        for x, y in _ORIGINS:
            for points in (firmware._MARK_OUTER, firmware._MARK_INNER):
                assert firmware._mark_pts(points, size, x, y) == \
                    _display_projection(size, x, y, points), \
                    f"size={size} origin=({x},{y})"


def test_pyportal_baseline_helper_lands_on_the_drawn_bottom_edge(firmware):
    # render_boot/render_shutdown/render_standby put text at `my + _mark_h`.
    for size in _SIZES:
        for x, y in _ORIGINS:
            drawn = firmware._mark_pts(firmware._MARK_OUTER, size, x, y)
            assert max(py for _, py in drawn) == y + firmware._mark_h(size)


def test_pyportal_mark_is_centred_in_its_size_box(firmware):
    # Every one of the old hand-written copies sat (size - w) / 2 too far
    # left, so the mark visibly jumped sideways at the boot fill transition.
    for size in _SIZES:
        for x, y in _ORIGINS:
            drawn = firmware._mark_pts(firmware._MARK_OUTER, size, x, y)
            left = min(px for px, _ in drawn) - x
            right = (x + size) - max(px for px, _ in drawn)
            assert abs(left - right) <= 1, f"size={size}: {left} vs {right}"


# --- preview.html mirrors it too --------------------------------------------

def _preview_source() -> str:
    return (_SERVICE_DIR / "preview.html").read_text(encoding="utf-8")


def _preview_points(name: str) -> list[tuple[int, int]]:
    src = _preview_source()
    m = re.search(rf"const\s+{name}\s*=\s*(\[\[.*?\]\])\s*;", src, re.S)
    assert m, f"{name} not found in preview.html"
    return [(int(a), int(b))
            for a, b in re.findall(r"\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]", m.group(1))]


def test_preview_html_draws_the_same_polygons_as_the_firmware():
    # preview.html is the design reference display.py and code.py both cite
    # by name. If it drifts, it previews a mark the device does not draw.
    assert _preview_points("MARK_LEFT") == \
        [tuple(p) for p in display_module._MARK_LEFT]
    assert _preview_points("MARK_RIGHT") == \
        [tuple(p) for p in display_module._MARK_RIGHT]


def test_preview_html_projects_against_the_same_bounding_box():
    src = _preview_source()
    found = dict(re.findall(r"MARK_(BX|BY|BW|BH)\s*=\s*(\d+)", src))
    assert {k: int(v) for k, v in found.items()} == {
        "BX": display_module._MARK_BBOX[0], "BY": display_module._MARK_BBOX[1],
        "BW": display_module._MARK_BBOX[2], "BH": display_module._MARK_BBOX[3],
    }
    assert re.search(r"MARK_H_RATIO\s*=\s*48\s*/\s*60", src)


def test_preview_html_has_no_leftover_52x60_mapping():
    # The old mapping was `size / 60` with a `52`-wide viewBox; both numbers
    # are meaningless in the 512x512 space and must not linger.
    old = re.compile(
        r"vw\s*=\s*52|vh\s*=\s*60|size\s*/\s*60"
        r"|\b52\s*\*\s*s\b|\b48\s*\*\s*s\b|size\s*\*\s*48\s*/\s*60"
    )
    stray = [
        line for line in _preview_source().splitlines()
        if ("size" in line or "MARK" in line) and old.search(line)
    ]
    assert stray == [], f"old 52x60 mark mapping left in preview.html: {stray}"
