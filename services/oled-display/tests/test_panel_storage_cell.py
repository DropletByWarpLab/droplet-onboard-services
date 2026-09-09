"""The rack panel's STORAGE cell, and the gauge that used to impersonate it.

WARP-2668 (WARP-2098 LEG 5). Two halves of one defect:

  * `layout_wide._cell_netstore` read `v["storage"]`, which nothing outside
    these tests ever set — a fully-built meter and byte row rendering an em
    dash on every box ever shipped;
  * the one storage-shaped number the panel *did* show is
    `psutil.disk_usage("/")`, the install filesystem, and it was labelled
    "DISK" two cells away from that blank meter.

So the assertions that matter here are the negative ones. It is easy to make
the cell show *a* number; the whole point of the ticket is that it must show
the RIGHT one, and must show nothing at all rather than borrow the boot disk.

Runs in CI: .github/workflows/oled-display-panel-tests.yml runs the whole
tests/ directory (only test_storage_pool_script.py is excluded).
"""

from __future__ import annotations

import json

import pytest
import PIL.ImageDraw as _id

import display as display_module
import layout_wide as lw

PANEL_W, PANEL_H = 1424, 280
TB = float(1024 ** 4)


@pytest.fixture
def wide(monkeypatch, sim_display):
    """A sim display whose geometry is the rack bar."""
    monkeypatch.setattr(display_module, "WIDTH", PANEL_W)
    monkeypatch.setattr(display_module, "HEIGHT", PANEL_H)
    return sim_display


@pytest.fixture
def populated(wide):
    wide._v3.update({
        "cpu": 34, "mem": 61, "disk": 44, "temp": 52, "gpu": 12,
        "ip": "192.168.1.250", "hostname": "droplet-sys",
        "uptime": "6d 4h", "version": "v2.6.1",
        "sparks_cpu": [20 + (i % 17) for i in range(48)],
        "sparks_mem": [60 + (i % 5) for i in range(48)],
        "sparks_disk": [40 + i // 6 for i in range(48)],
        "wan_online": True, "wan_latency_ms": 14, "tls_days": 61,
        "wifi": {"ssid": "Droplet-AI", "band": "5 GHz", "channel": 36,
                 "clients": 4},
        "cameras": {"online": 4, "total": 4},
        "services": {"up": 27, "total": 27, "degraded": []},
    })
    return wide


def _drawn(disp) -> list:
    """Every string the wide render puts on the glass."""
    out: list = []
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, text, *a, **k: (
            out.append(str(text)), real(self, xy, text, *a, **k))[1]
        lw.render_status(disp)
    finally:
        _id.ImageDraw.text = real
    return out


def _eyebrows(disp, monkeypatch) -> list:
    """Every eyebrow the wide render lays down.

    Not `_drawn` — `_eyebrow` renders with letter tracking, which draws one
    glyph per `ImageDraw.text` call, so a label search over the glyph stream
    finds "SYSTEM" spelled as six separate entries and matches nothing.
    """
    out: list = []
    real = lw._eyebrow
    monkeypatch.setattr(lw, "_eyebrow", lambda draw, text, *a, **k: (
        out.append(str(text)), real(draw, text, *a, **k))[1])
    lw.render_status(disp)
    return out


def _totals(size_bytes, used_bytes, **extra) -> dict:
    """The orchestrator's GET /api/storage body, trimmed to what we read."""
    return {"totals": {"size_bytes": size_bytes, "used_bytes": used_bytes,
                       "free_bytes": size_bytes - used_bytes,
                       "drive_count": 1, "source": "data_drives", **extra}}


# --- the cell is fed at all ------------------------------------------------

def test_the_seeded_vitals_dict_carries_the_key(sim_display):
    """The defect in one line: the cell read `storage` off a dict that never
    had it. Seeded EMPTY — `{}` is the em dash, `{"used_tb": 0, ...}` would be
    a claim about capacity nobody has measured."""
    assert sim_display._v3["storage"] == {}


def test_totals_reach_the_cell_as_binary_tb(sim_display):
    sim_display.update_storage(_totals(4 * TB, int(1.5 * TB)))
    assert sim_display._v3["storage"] == pytest.approx(
        {"used_tb": 1.5, "total_tb": 4.0})


def test_the_cell_renders_the_data_drive_figure(populated):
    populated.update_storage(_totals(int(3.6 * TB), int(1.4 * TB)))
    assert any("1.4 / 3.6 TB" in t for t in _drawn(populated))


def test_a_storage_frame_routes_through_the_mirror(sim_display):
    """`_pyportal_send` is what fills `_v3` on every backend — a mode missing
    from `_mirror_to_v3` renders forever empty while the renderer works
    perfectly (the WARP-1640 failure mode, restated in _DATA_BACKENDS)."""
    sim_display._pyportal_send("storage", _totals(2 * TB, 1 * TB))
    assert sim_display._v3["storage"]["total_tb"] == pytest.approx(2.0)


# --- ...and goes back to the em dash rather than lying ---------------------

@pytest.mark.parametrize("body, why", [
    ({"totals": None}, "no data drives / bridge unreachable"),
    ({}, "an orchestrator that predates the totals key"),
    ({"totals": []}, "a non-dict totals"),
    ({"totals": {"size_bytes": 0, "used_bytes": 0}}, "a zeroed total"),
    ({"totals": {"size_bytes": -1, "used_bytes": 0}}, "a negative size"),
    ({"totals": {"size_bytes": None, "used_bytes": 1}}, "a null size"),
    ({"totals": {"size_bytes": 4 * TB, "used_bytes": None}}, "a null used"),
    ({"totals": {"size_bytes": "4000000000000", "used_bytes": 1}}, "a string"),
])
def test_every_unusable_answer_clears_the_cell(sim_display, body, why):
    sim_display.update_storage(_totals(4 * TB, 1 * TB))
    sim_display.update_storage(body)
    assert sim_display._v3["storage"] == {}, why


def test_a_cleared_cell_renders_an_em_dash_not_a_zeroed_meter(populated):
    """`0.0 / 0.0 TB` reads as a box with no room. The cell only guards its
    text row on `total_tb is None`, so a zeroed total would print exactly
    that — this is why update_storage refuses a zero size."""
    populated.update_storage({"totals": {"size_bytes": 0, "used_bytes": 0}})
    drawn = _drawn(populated)
    assert not any("TB" in t for t in drawn), "printed a capacity it never read"
    assert "—" in drawn


def test_the_cell_never_borrows_the_boot_disk(populated):
    """The one substitution that must never happen. `disk` is right there,
    always populated, and is `psutil.disk_usage("/")` — the INSTALL disk.
    Printing it under STORAGE is the whole of WARP-2098."""
    populated._v3["disk"] = 97
    populated.update_storage({"totals": None})
    drawn = _drawn(populated)
    assert not any("TB" in t for t in drawn)
    # 97% may legitimately appear once, as the SYSTEM gauge. It must not
    # appear as a capacity, and the storage meter must stay unfilled.
    assert drawn.count("97%") <= 1


def test_losing_the_last_drive_clears_a_previously_good_figure(sim_display):
    """update_storage replaces wholesale for the same reason update_services
    does: a merge would pin the last good capacity on the glass for a box that
    no longer has the drive."""
    sim_display.update_storage(_totals(4 * TB, 1 * TB))
    sim_display.update_storage({"totals": None})
    assert sim_display._v3["storage"] == {}


def test_used_and_total_are_set_together_or_not_at_all(sim_display):
    """The cell formats `used` with `:.1f` after testing only `cap`, so a
    half-filled dict raises mid-render rather than degrading."""
    for body in ({"totals": None}, _totals(4 * TB, 1 * TB), {"totals": {}}):
        sim_display.update_storage(body)
        store = sim_display._v3["storage"]
        assert ("used_tb" in store) == ("total_tb" in store)


# --- the transport ---------------------------------------------------------

class _FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capture_urlopen(monkeypatch, payload=None, raises=None):
    seen = {}

    def fake(req, timeout=None, context=None):
        seen["url"] = req.full_url
        seen["headers"] = dict(req.headers)
        seen["timeout"] = timeout
        seen["context"] = context
        if raises is not None:
            raise raises
        return _FakeResponse(payload)

    monkeypatch.setattr(display_module.urllib.request, "urlopen", fake)
    return seen


def test_fetch_storage_asks_the_orchestrator_with_the_service_token(
        sim_display, monkeypatch):
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    seen = _capture_urlopen(monkeypatch, _totals(4 * TB, 1 * TB))
    out = sim_display.fetch_storage()

    assert out == {"totals": _totals(4 * TB, 1 * TB)["totals"]}
    assert seen["url"] == display_module.PANEL_ORCHESTRATOR_URL + "/api/storage"
    # urllib title-cases header names on the way in.
    assert seen["headers"]["Authorization"] == "Bearer tok-display"
    # The gateway redirects :80 -> :443 onto a self-signed cert; without the
    # unverified loopback context every read dies on verification, silently.
    assert seen["context"] is display_module._GATEWAY_SSL_CTX


def test_fetch_storage_forwards_a_null_total_rather_than_swallowing_it(
        sim_display, monkeypatch):
    """`{"totals": None}` is an ANSWER — "there is no figure" — and has to be
    pushed so the cell clears. Only "I could not ask" returns None."""
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, {"totals": None, "used": 0, "total": 0})
    assert sim_display.fetch_storage() == {"totals": None}


@pytest.mark.parametrize("payload", [{"totals": None}, ["not", "a", "dict"]])
def test_fetch_storage_reads_only_totals(sim_display, monkeypatch, payload):
    """The four scalars beside it are the same numbers; `totals` is the one
    that says which disks they cover, so it is the only key we trust."""
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, payload)
    out = sim_display.fetch_storage()
    assert out in ({"totals": None}, None)


def test_the_bearer_survives_the_gateways_redirect(sim_display, monkeypatch):
    """The panel reaches the orchestrator over nginx :80, which answers
    `301 -> https://$host$request_uri`. urllib follows that itself, and if it
    dropped the Authorization header on the way the panel would 401 on every
    poll and the cell would stay blank — the exact symptom this ticket exists
    to remove, reappearing for a different reason.

    Real loopback server rather than a urlopen stub: a stub cannot answer the
    question, because the redirect is handled inside the thing being stubbed.
    """
    import json as _json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen = []

    class _Gateway(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("Authorization"))
            if self.path == "/api/storage":
                self.send_response(301)
                self.send_header(
                    "Location", "http://127.0.0.1:%d/redirected" % port)
                self.end_headers()
                return
            body = _json.dumps(_totals(4 * TB, 1 * TB)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), _Gateway)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("SERVICE_SECRET", "tok-display")
        monkeypatch.setattr(display_module, "PANEL_ORCHESTRATOR_URL",
                            "http://127.0.0.1:%d" % port)
        out = sim_display.fetch_storage()
    finally:
        srv.shutdown()

    assert out["totals"]["size_bytes"] == 4 * TB
    assert len(seen) == 2, "the redirect was not followed"
    assert seen == ["Bearer tok-display"] * 2, "bearer dropped on the redirect"


def test_fetch_storage_returns_none_when_the_gateway_is_down(
        sim_display, monkeypatch):
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, raises=OSError("connection refused"))
    assert sim_display.fetch_storage() is None


def test_fetch_storage_returns_none_without_a_token(sim_display, monkeypatch):
    """Fail closed and quiet: an unauthenticated read would 401 every poll."""
    monkeypatch.delenv("SERVICE_SECRET", raising=False)
    monkeypatch.delenv("BRIDGE_AUTH_TOKEN", raising=False)
    called = _capture_urlopen(monkeypatch, _totals(4 * TB, 1 * TB))
    assert sim_display.fetch_storage() is None
    assert not called, "opened a connection with no credential"


def test_a_dropped_poll_leaves_the_last_good_figure_alone(
        sim_display, monkeypatch):
    """Same rule as fetch_services: one unreachable poll must not make the
    panel forget what it knew. The pump only pushes a non-None fetch."""
    sim_display.update_storage(_totals(4 * TB, 1 * TB))
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, raises=OSError("boom"))

    store = sim_display.fetch_storage()
    if store is not None:                    # mirrors the cycle-loop guard
        sim_display._pyportal_send("storage", store)

    assert sim_display._v3["storage"]["total_tb"] == pytest.approx(4.0)


def test_the_storage_pump_is_gated_on_a_wide_panel():
    """The STORAGE cell lives in layout_wide's C4 and nowhere on the 480x320
    face, so a PyPortal must not be sent `storage` frames it cannot draw —
    same gate, same reason, as the WARP-1800 join pump beside it."""
    import inspect
    src = inspect.getsource(display_module.TFTDisplay._cycle_loop)
    pump = src.split("last_storage_push) > STORAGE_REFRESH_SECONDS")[0]
    guard = pump.rsplit("if (", 1)[-1]
    assert "_is_wide_panel()" in guard


# --- the relabelled gauge --------------------------------------------------

def test_the_health_row_names_the_gauge_system_not_disk(populated,
                                                        monkeypatch):
    """It is psutil.disk_usage("/") — the install filesystem. "DISK" beside a
    STORAGE cell reads as the box's storage, which is the wrong disk."""
    labels = _eyebrows(populated, monkeypatch)
    assert "SYSTEM" in labels
    assert "DISK" not in labels
    # The cell it was being confused with is still there, and still separate.
    assert "STORAGE" in labels


def test_the_trend_block_agrees_with_the_gauge_above_it(populated,
                                                        monkeypatch):
    """Band D draws the same series again; two eyebrows for one number must
    not disagree about what it measures."""
    monkeypatch.setattr(display_module, "HEIGHT", 400)
    labels = _eyebrows(populated, monkeypatch)
    assert "TRENDS" in labels, "band D did not draw — the test proves nothing"
    assert labels.count("SYSTEM") >= 2
    assert "DISK" not in labels


@pytest.mark.parametrize("w, h", [(1424, 280), (1280, 400), (1024, 280)])
def test_the_longer_eyebrow_still_fits_its_column(monkeypatch, sim_display,
                                                  w, h):
    """"SYSTEM" is 60% wider than "DISK" was, in a row of four columns whose
    width is the health cell divided by four. The narrowest supported panel is
    where that stops being free, and an eyebrow spilling into TEMP is not
    something band containment catches — both labels are inside the band."""
    from PIL import Image, ImageDraw

    monkeypatch.setattr(display_module, "WIDTH", w)
    monkeypatch.setattr(display_module, "HEIGHT", h)
    _, cell_w = lw.geom().cells["health"]
    col = cell_w / 4

    draw = ImageDraw.Draw(Image.new("RGB", (w, h)))
    font = display_module._get_font(9, weight="bold")
    for label in ("MEM", "SYSTEM", "TEMP", "GPU"):
        # _eyebrow draws at tracking=1.6, which the width helper does not know
        # about — one gap per pair of glyphs.
        width = (display_module._v3_text_width(draw, label, font)
                 + 1.6 * (len(label) - 1))
        assert width < col, f"{label} ({width:.0f}px) overflows a {col:.0f}px column"


def test_the_relabel_did_not_move_the_series(populated):
    """The buffer keeps its `sparks_disk` name — that is what update_stats
    feeds. Only the eyebrow changed; renaming the key would silently empty the
    trend."""
    populated._v3["disk"] = 44
    assert any("44%" in t for t in _drawn(populated))
