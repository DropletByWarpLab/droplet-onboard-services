"""The rack panel's Security chip — WARP-2981 (ADR-059 P6, §3.8).

"Rack panel: a single count cell at most, showing *Security: 1 open*. Never
images, never names. The panel faces the room, and anyone standing in front of
the rack can read it." So what matters here is mostly what the chip must NOT
do: show a number it was not given, keep a number nobody is refreshing, carry
a name through, draw over the badge or the date, or move the pill.

  * display.update_security — P6-3's body → `_v3["security"]`, from literals;
  * display.fetch_security  — the orchestrator read (fetch_storage's transport);
  * layout_wide.security_chip — the pure four-state switch;
  * the render — band A, beside the pill, only where it fits.

Runs in CI: .github/workflows/oled-display-panel-tests.yml runs tests/.
"""

from __future__ import annotations

import inspect
import json
import re
import time
import urllib.error

import pytest
import PIL.ImageDraw as _id

import display as display_module
import layout_wide as lw

NOW = 1_790_000_000.0
STALE = lw.SECURITY_CHIP_STALE_READS * display_module.STORAGE_REFRESH_SECONDS
WORST = "SECURITY: 99+ OPEN · MAY BE BEHIND"
CHIP_TEXT = re.compile(r"^SECURITY: (—|\d{1,2} OPEN|99\+ OPEN)( · MAY BE BEHIND)?$")


def _on(open_=2, alerts=1, up=True, **extra) -> dict:
    """P6-3's body when Security is on."""
    return {"security": "on", "open": open_, "alerts": alerts, "upToDate": up, **extra}


def _panel(monkeypatch, w, h):
    monkeypatch.setattr(display_module, "WIDTH", w)
    monkeypatch.setattr(display_module, "HEIGHT", h)


@pytest.fixture
def wide(monkeypatch, sim_display):
    _panel(monkeypatch, 1424, 280)
    return sim_display


@pytest.fixture
def populated(wide):
    wide._v3.update({
        "cpu": 34, "mem": 61, "disk": 44, "temp": 52, "gpu": 12,
        "ip": "192.168.1.250", "hostname": "droplet-sys",
        "uptime": "6d 4h", "version": "v2.6.1",
        "wan_online": True, "wan_latency_ms": 14, "tls_days": 61,
        "cameras": {"online": 4, "total": 4},
        "services": {"up": 27, "total": 27, "status": "ok", "degraded": []},
    })
    return wide


def _chips(monkeypatch) -> list:
    """(x, text) for every Security chip `_chip` is asked to draw."""
    seen: list = []
    real = lw._chip
    monkeypatch.setattr(lw, "_chip", lambda draw, x, y, text, ink, fill: (
        seen.append((x, text)) if str(text).startswith("SECURITY") else None,
        real(draw, x, y, text, ink, fill))[1])
    return seen


# --- T-Y1: a panel that has not heard yet draws nothing --------------------

def test_the_seed_is_an_explicit_never_asked_state(sim_display):
    """Not `{}`: "never asked" (no chip) and "asked, unusable" (`—`) render
    differently, so they must not share a shape (no NULL-as-state)."""
    assert sim_display._v3["security"] == {"state": "unasked"}


def test_a_panel_that_never_asked_draws_no_chip(populated, monkeypatch):
    chips = _chips(monkeypatch)
    lw.render_status(populated)
    assert chips == []


# --- T-Y2: update_security --------------------------------------------------

def test_off_and_on_are_stored_with_when(sim_display):
    sim_display.update_security({"security": "off"}, now_ts=NOW)
    assert sim_display._v3["security"] == {"state": "off", "at": NOW}
    sim_display.update_security(_on(3, 1, True), now_ts=NOW + 1)
    assert sim_display._v3["security"] == {"state": "on", "open": 3, "alerts": 1, "upToDate": True, "at": NOW + 1}


@pytest.mark.parametrize("body, why", [
    (_on(True, 0), "a bool is not a count"),
    (_on(-1, 0), "a negative count"),
    (_on(-1, -1), "negative counts (alerts <= open would let them through)"),
    (_on(2, -1), "a negative alert count"),
    (_on("3", 0), "a string"),
    (_on(None, 0), "a null count"),
    ({"security": "on", "alerts": 0, "upToDate": True}, "no count at all"),
    (_on(3, None), "a null alert count"),
    ({"security": "on", "open": 3, "upToDate": True}, "no alert count (an older orchestrator shape)"),
    (_on(2, 3), "more alerts than open incidents"),
    (_on(2, False), "a bool alert count"),
    ({"security": "on", "open": 2, "alerts": 0}, "no upToDate"),
    (_on(2, 0, "yes"), "a non-bool upToDate"),
    (_on(2, 0, 1), "a number as upToDate"),
    ({"security": "maybe"}, "a state nobody sends"),
    ({"open": 2, "alerts": 0, "upToDate": True}, "no state"),
    (["on", 2], "a non-dict"),
])
def test_every_unusable_answer_is_unknown_never_a_number(sim_display, body, why):
    sim_display.update_security(_on(5, 1), now_ts=NOW)
    sim_display.update_security(body, now_ts=NOW)
    assert sim_display._v3["security"] == {"state": "unknown", "at": NOW}, why


def test_it_replaces_wholesale(sim_display):
    """A merge would keep `open` from the last good answer beside an `off`."""
    sim_display.update_security(_on(5, 1), now_ts=NOW)
    sim_display.update_security({"security": "off"}, now_ts=NOW)
    assert "open" not in sim_display._v3["security"]


# --- T-Y3: the mirror -------------------------------------------------------

def test_a_security_body_routes_through_the_mirror(sim_display):
    sim_display._mirror_to_v3("security", _on(4, 0))
    assert sim_display._v3["security"]["open"] == 4


def test_an_empty_body_is_ignored_by_the_mirror(sim_display):
    """The mirror's existing rule for every mode: falsy data is skipped."""
    sim_display._mirror_to_v3("security", {})
    assert sim_display._v3["security"] == {"state": "unasked"}


# --- T-Y4: fetch_security ---------------------------------------------------

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


def test_fetch_security_asks_p6_3_with_the_panels_token(sim_display, monkeypatch):
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    seen = _capture_urlopen(monkeypatch, _on(2, 1))
    assert sim_display.fetch_security() == _on(2, 1)
    assert seen["url"] == display_module.PANEL_ORCHESTRATOR_URL + "/api/panel/security"
    assert seen["headers"]["Authorization"] == "Bearer tok-display"
    assert seen["context"] is display_module._GATEWAY_SSL_CTX
    # It shares the render loop's storage cadence: a hung gateway stalls the
    # loop for the sum of the reads' timeouts, so this one stays short.
    assert seen["timeout"] == 3.0


@pytest.mark.parametrize("raises", [
    OSError("connection refused"),
    urllib.error.HTTPError("http://x/api/panel/security", 503, "Service Unavailable", {}, None),
])
def test_fetch_security_returns_none_when_it_could_not_ask(sim_display, monkeypatch, raises):
    """A 503 (Droplet can't read its incidents) is "could not ask" too: the
    chip keeps its last answer until that is too old, then reads `—`."""
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, raises=raises)
    assert sim_display.fetch_security() is None


def test_fetch_security_returns_none_for_a_non_dict_body(sim_display, monkeypatch):
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, ["on", 2])
    assert sim_display.fetch_security() is None


def test_fetch_security_opens_no_connection_without_a_token(sim_display, monkeypatch):
    monkeypatch.delenv("SERVICE_SECRET", raising=False)
    monkeypatch.delenv("BRIDGE_AUTH_TOKEN", raising=False)
    called = _capture_urlopen(monkeypatch, _on())
    assert sim_display.fetch_security() is None
    assert not called, "opened a connection with no credential"


@pytest.mark.parametrize("code", [401, 403])
def test_a_rejected_token_names_the_fix(sim_display, monkeypatch, caplog, code):
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, raises=urllib.error.HTTPError(
        "http://x/api/panel/security", code, "no", {}, None))
    with caplog.at_level("WARNING", logger=display_module.logger.name):
        assert sim_display.fetch_security() is None
    assert any("--sync-secrets" in r.getMessage() for r in caplog.records)


def test_the_bearer_survives_the_gateways_redirect(sim_display, monkeypatch):
    """nginx :80 answers `301 -> https://…`; urllib follows it itself, so only
    a real server can show the Authorization header survives (the storage
    read's own test, for this route)."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen = []

    class _Gateway(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("Authorization"))
            if self.path == "/api/panel/security":
                self.send_response(301)
                self.send_header("Location", "http://127.0.0.1:%d/redirected" % port)
                self.end_headers()
                return
            body = json.dumps(_on(1, 1)).encode()
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
        monkeypatch.setattr(display_module, "PANEL_ORCHESTRATOR_URL", "http://127.0.0.1:%d" % port)
        out = sim_display.fetch_security()
    finally:
        srv.shutdown()
    assert out == _on(1, 1)
    assert seen == ["Bearer tok-display"] * 2, "bearer dropped on the redirect"


# --- T-Y5: security_chip ----------------------------------------------------

def _stored(**kw) -> dict:
    return {"state": "on", "open": 2, "alerts": 1, "upToDate": True, "at": NOW, **kw}


@pytest.mark.parametrize("sec, now, expected", [
    ({"state": "unasked"}, NOW, None),
    ({"state": "off", "at": NOW}, NOW, None),
    ({"state": "off", "at": NOW - 600}, NOW, None),                           # off, 10 min old: still nothing
    ({"state": "unknown", "at": NOW}, NOW, ("SECURITY: —", "muted")),
    ({"state": "surprise"}, NOW, ("SECURITY: —", "muted")),                    # a state it was not written for
    (None, NOW, ("SECURITY: —", "muted")),
    (_stored(), NOW + STALE + 1, ("SECURITY: —", "muted")),                    # nobody is refreshing it
    (_stored(), NOW + STALE, ("SECURITY: 2 OPEN", "warn")),                    # exactly at the edge: still current
    (_stored(), NOW - 5, ("SECURITY: —", "muted")),                            # learned "in the future"
    (_stored(open=0, alerts=0), NOW, ("SECURITY: 0 OPEN", "muted")),
    (_stored(open=2, alerts=1), NOW, ("SECURITY: 2 OPEN", "warn")),
    (_stored(open=3, alerts=0), NOW, ("SECURITY: 3 OPEN", "muted")),           # notices alone never light it
    (_stored(open=99, alerts=0), NOW, ("SECURITY: 99 OPEN", "muted")),
    (_stored(open=150, alerts=2), NOW, ("SECURITY: 99+ OPEN", "warn")),
    (_stored(open=0, alerts=0, upToDate=False), NOW, ("SECURITY: 0 OPEN · MAY BE BEHIND", "warn")),
    (_stored(open=150, alerts=0, upToDate=False), NOW, (WORST, "warn")),
])
def test_the_chip_truth_table(sec, now, expected):
    assert lw.security_chip(sec, now, STALE) == expected


def test_the_stale_edge_follows_the_storage_cadence():
    """Fed on the storage pump, so 'three missed reads' is three of those."""
    assert STALE == 3 * display_module.STORAGE_REFRESH_SECONDS == 180


# --- T-Y6 / T-Y7: geometry ---------------------------------------------------

def _band_a(disp, monkeypatch):
    """Render once; return (pill_right, chip, clear_of) — the chip's (x, text),
    and the left edge of what it must stay clear of: the badge, else the date."""
    d = display_module
    rrects, texts, ellipses, chips = [], [], [], _chips(monkeypatch)
    real_rrect, real_text = d._rrect, d._v3_text
    monkeypatch.setattr(d, "_rrect", lambda draw, x, y, w, h, r, **k: (rrects.append((x, y, w, h)), real_rrect(draw, x, y, w, h, r, **k))[1])
    monkeypatch.setattr(d, "_v3_text", lambda draw, text, x, y, **k: (texts.append((draw, text, x, k)), real_text(draw, text, x, y, **k))[1])
    real_ellipse = _id.ImageDraw.ellipse
    monkeypatch.setattr(_id.ImageDraw, "ellipse", lambda self, xy, *a, **k: (ellipses.append(xy), real_ellipse(self, xy, *a, **k))[1])
    lw.render_status(disp)
    g = lw.geom()
    pill = next(r for r in rrects if r[1] == g.top + 12 and r[3] == 22)
    date = next(t for t in texts if re.fullmatch(r"[A-Z]{3} \d{2} [A-Z]{3}", str(t[1])) and t[3].get("anchor") == "ra")
    date_left = date[2] - d._v3_text_width(date[0], date[1], date[3]["font"], date[3]["tracking"])
    badge = [e for e in ellipses if e[1] < g.band_a_rule]
    return pill[0] + pill[2], (chips[0] if chips else None), (badge[0][0] if badge else date_left)


@pytest.mark.parametrize("w, h", [(1424, 280), (1280, 400)])
@pytest.mark.parametrize("pill", ["degraded", "alert"])
def test_the_worst_chip_fits_beside_the_widest_pill(monkeypatch, sim_display, w, h, pill):
    """DEGRADED is the widest pill; an open panel alert puts the badge up (and
    the pill to ALERT). Either way the longest chip text sits 12 px clear of
    both sides, on both shipped panels."""
    lw._GEOM_CACHE.clear()
    _panel(monkeypatch, w, h)
    if pill == "degraded":
        sim_display._v3["services"] = {"up": 26, "total": 27, "status": "degraded", "degraded": [{"name": "ollama", "core": False}]}
    else:
        sim_display.push_alert({"title": "Fan"})
    sim_display.update_security(_on(150, 0, False))
    assert lw.security_chip(sim_display._v3["security"], time.time(), STALE)[0] == WORST
    pill_right, chip, clear_of = _band_a(sim_display, monkeypatch)
    assert chip is not None, "the worst chip was not drawn on a shipped panel"
    x, text = chip
    assert text == WORST
    assert x >= pill_right + 12
    assert x + lw._chip_width(_id.Draw(display_module.Image.new("RGB", (1, 1))), text) <= clear_of - 12
    lw._GEOM_CACHE.clear()


@pytest.mark.parametrize("pill", ["degraded", "alert"])
def test_across_widths_the_chip_is_either_clear_or_not_drawn(monkeypatch, sim_display, pill):
    """Between the shipped panels and the narrowest wide one there are widths
    where the worst chip fits before the date but not before the badge, or
    lands inside the date's 12 px of air: it must not be drawn there. The
    sweep must see both outcomes, or it proves nothing."""
    if pill == "degraded":
        sim_display._v3["services"] = {"up": 26, "total": 27, "status": "degraded", "degraded": [{"name": "ollama", "core": False}]}
    else:
        sim_display.push_alert({"title": "Fan"})
    sim_display.update_security(_on(150, 0, False))
    lw._SECURITY_CHIP_WARNED.add((0, 0))  # keep the journal quiet; the warn-once rule is pinned below
    measure = _id.Draw(display_module.Image.new("RGB", (1, 1)))
    drawn = skipped = 0
    for w in range(1150, 1330, 3):
        lw._GEOM_CACHE.clear()
        _panel(monkeypatch, w, 280)
        with monkeypatch.context() as m:
            pill_right, chip, clear_of = _band_a(sim_display, m)
        if chip is None:
            skipped += 1
            continue
        drawn += 1
        x, text = chip
        assert x >= pill_right + 12, w
        assert x + lw._chip_width(measure, text) <= clear_of - 12, f"{w}px: the chip runs into the {'badge' if pill == 'alert' else 'date'}"
    assert drawn and skipped, (drawn, skipped)
    lw._GEOM_CACHE.clear()
    lw._SECURITY_CHIP_WARNED.clear()


def test_below_the_shipped_widths_it_is_not_drawn_and_says_so_once(monkeypatch, sim_display, caplog):
    lw._GEOM_CACHE.clear()
    lw._SECURITY_CHIP_WARNED.clear()
    _panel(monkeypatch, 1024, 280)
    sim_display.update_security(_on(0, 0))
    chips = _chips(monkeypatch)
    with caplog.at_level("WARNING", logger="droplet.tft.wide"):
        lw.render_status(sim_display)
        lw.render_status(sim_display)
    assert chips == []
    warnings = [r for r in caplog.records if "Security chip" in r.getMessage()]
    assert len(warnings) == 1, "a per-render warning would flood the journal"
    lw._GEOM_CACHE.clear()
    lw._SECURITY_CHIP_WARNED.clear()


def test_a_shipped_panel_never_warns(monkeypatch, populated, caplog):
    lw._SECURITY_CHIP_WARNED.clear()
    populated.update_security(_on(150, 0, False))
    with caplog.at_level("WARNING", logger="droplet.tft.wide"):
        lw.render_status(populated)
    assert not [r for r in caplog.records if "Security chip" in r.getMessage()]


# --- T-Y8: never a name -------------------------------------------------------

def test_nothing_but_the_count_reaches_the_glass(populated, monkeypatch):
    populated.update_security(_on(3, 1, True, names=["Back door"], areas=["Stock room"], latest=[{"id": "x"}]))
    assert set(populated._v3["security"]) == {"state", "open", "alerts", "upToDate", "at"}
    chips = _chips(monkeypatch)
    drawn: list = []
    real = _id.ImageDraw.text
    monkeypatch.setattr(_id.ImageDraw, "text", lambda self, xy, t, *a, **k: (drawn.append(str(t)), real(self, xy, t, *a, **k))[1])
    lw.render_status(populated)
    assert [t for _, t in chips] == ["SECURITY: 3 OPEN"]
    assert all(CHIP_TEXT.match(t) for _, t in chips)
    joined = "".join(drawn)
    assert "Back door" not in joined and "Stock room" not in joined


@pytest.mark.parametrize("sec", [
    _stored(open=0, alerts=0), _stored(open=7, alerts=7), _stored(open=150, alerts=1),
    _stored(upToDate=False), {"state": "unknown", "at": NOW},
])
def test_every_chip_text_is_one_of_the_four_shapes(sec):
    text, _tone = lw.security_chip(sec, NOW, STALE)
    assert CHIP_TEXT.match(text), text


# --- T-Y9: the pill stays box health ------------------------------------------

def test_open_incidents_never_move_the_pill(populated, monkeypatch):
    populated.update_security(_on(5, 5, False))
    seen = {}
    real = lw._render_chrome
    monkeypatch.setattr(lw, "_render_chrome", lambda disp, draw, now, state: (
        seen.__setitem__("state", state), real(disp, draw, now, state))[1])
    lw.render_status(populated)
    assert seen["state"] == "live"


# --- T-Y10: the read rides the storage pump -----------------------------------

def test_the_read_rides_the_storage_pump_and_adds_no_cadence():
    """CLAUDE.md: no new timed cadence in a Python loop. The read is folded
    into the storage branch (the TLS read's precedent), behind its wide-panel
    gate, mirrored straight into _v3 (no firmware knows the mode), and kept
    out of both resync blocks."""
    src = inspect.getsource(display_module.TFTDisplay._cycle_loop)
    head, rest = src.split("last_storage_push) > STORAGE_REFRESH_SECONDS", 1)
    assert "_is_wide_panel()" in head.rsplit("if (", 1)[-1]
    branch = rest.split("last_storage_push = now", 1)[0]
    assert "self.fetch_security()" in branch
    assert '_mirror_to_v3("security"' in branch
    assert '_pyportal_send("security"' not in src
    assert src.count("fetch_security(") == 1, "a second caller is a second cadence"
    assert "last_security" not in src
    assert "SECURITY_REFRESH" not in inspect.getsource(display_module)


# --- T-Y11: a dropped poll -----------------------------------------------------

def test_a_dropped_poll_keeps_the_last_answer_until_it_is_too_old(sim_display, monkeypatch):
    sim_display.update_security(_on(2, 1), now_ts=NOW)
    monkeypatch.setenv("SERVICE_SECRET", "tok-display")
    _capture_urlopen(monkeypatch, raises=OSError("boom"))
    sec = sim_display.fetch_security()
    if sec is not None:                                  # mirrors the pump's guard
        sim_display._mirror_to_v3("security", sec)
    assert sim_display._v3["security"]["open"] == 2
    assert lw.security_chip(sim_display._v3["security"], NOW + 90, STALE) == ("SECURITY: 2 OPEN", "warn")
    assert lw.security_chip(sim_display._v3["security"], NOW + STALE + 1, STALE) == ("SECURITY: —", "muted")
