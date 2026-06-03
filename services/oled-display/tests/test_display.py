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
    # py-v3: the live UI is the combined System screen (bare "stats" wire frame
    # still navigates the firmware; the host preview lands on SYSTEM).
    assert sim_display._current_mode == TFTDisplay.SYSTEM


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
    assert sim_display._current_mode == TFTDisplay.SYSTEM


def _spy_pyportal_send(
    display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
) -> list[tuple[str, object]]:
    """Record every serial frame `_pyportal_send(mode, data)` would emit.

    The sim backend has `self._pyportal is None`, so `_pyportal_send` is a
    no-op on the wire — but the *call* is the navigation boundary. Capturing
    (mode, data) lets us assert what the firmware would receive.
    """
    sent: list[tuple[str, object]] = []
    real = display._pyportal_send

    def _record(mode: str, data: object = None):
        sent.append((mode, data))
        return real(mode, data)

    monkeypatch.setattr(display, "_pyportal_send", _record)
    return sent


def test_complete_boot_emits_bare_stats_nav_frame(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # B1 (WARP-624): the firmware only `set_screen("stats")` on a BARE
    # {"mode":"stats"} (code.py:1473). A data-laden stats push merely updates
    # state and re-renders *iff already on stats* (code.py:1497), so without a
    # bare nav frame the real PyPortal stays stuck on the boot splash forever
    # after the box becomes healthy. _complete_boot MUST emit a bare STATS
    # frame (no data) on the boot->stats transition.
    sent = _spy_pyportal_send(sim_display, monkeypatch)
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: True)
    sim_display._boot_started_at = 1000.0

    sim_display._readiness_tick(now=1003.0)

    assert sim_display._boot_complete is True
    # Host preview lands on the combined System screen (py-v3).
    assert sim_display._current_mode == TFTDisplay.SYSTEM
    # The WIRE frame stays a bare ("stats", None): the firmware aliases it to
    # the system screen, so the navigation contract is unchanged. data-laden
    # frames do NOT navigate the firmware, so they don't count.
    bare_stats = [m for (m, d) in sent if m == TFTDisplay.STATS and d is None]
    assert bare_stats, (
        f"expected a bare STATS nav frame on boot->stats; got {sent!r}"
    )


def test_complete_boot_emits_bare_stats_nav_frame_on_timeout(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # The timeout fallback path must navigate the firmware too — a degraded
    # stack still has to leave the boot splash, not just flip host-side state.
    sent = _spy_pyportal_send(sim_display, monkeypatch)
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: False)
    monkeypatch.setattr(display_module, "BOOT_MAX_SECONDS", 90)
    sim_display._boot_started_at = 1000.0

    sim_display._readiness_tick(now=1000.0 + 91)

    assert sim_display._boot_complete is True
    bare_stats = [m for (m, d) in sent if m == TFTDisplay.STATS and d is None]
    assert bare_stats, (
        f"expected a bare STATS nav frame on boot timeout; got {sent!r}"
    )


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


# --- Readiness probe survives the nginx http->https redirect (WARP-638) ------
#
# The 90s-every-boot timeout root cause: nginx :80 issues `301 -> https://$host`
# and the HTTPS vhost uses a self-signed cert. urllib follows the redirect to
# https://127.0.0.1/... and dies on certificate verification, so the probe
# returned False forever and the splash sat for the full BOOT_MAX_SECONDS on
# every (re)start. The probe must tolerate the self-signed loopback cert.

def test_check_readiness_passes_unverified_ssl_context(
    monkeypatch: pytest.MonkeyPatch,
):
    import ssl

    d = TFTDisplay()
    seen = {}

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _capture(req, *a, **k):
        seen["context"] = k.get("context")
        return _Resp()

    monkeypatch.setattr(display_module.urllib.request, "urlopen", _capture)
    assert d._check_readiness() is True
    ctx = seen.get("context")
    assert isinstance(ctx, ssl.SSLContext), (
        "readiness probe must pass an SSL context so the self-signed "
        "loopback HTTPS redirect doesn't fail cert verification")
    # Verification must be OFF — it's loopback to our own gateway's
    # self-signed cert, there is nothing to verify against.
    assert ctx.verify_mode == ssl.CERT_NONE
    assert ctx.check_hostname is False


def test_check_readiness_true_when_redirect_lands_on_2xx(
    monkeypatch: pytest.MonkeyPatch,
):
    # Simulate urllib having followed the 301 to HTTPS and returned a 2xx
    # (i.e. the cert no longer blocks it). Probe reads ready.
    d = TFTDisplay()

    class _Resp:
        status = 204  # any 2xx

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        display_module.urllib.request, "urlopen", lambda *a, **k: _Resp())
    assert d._check_readiness() is True


def test_check_readiness_false_on_ssl_error_is_swallowed(
    monkeypatch: pytest.MonkeyPatch,
):
    import ssl

    d = TFTDisplay()

    def _boom(*a, **k):
        raise ssl.SSLError("CERTIFICATE_VERIFY_FAILED")

    monkeypatch.setattr(display_module.urllib.request, "urlopen", _boom)
    # Even an SSL error must read as "not ready", never escape.
    assert d._check_readiness() is False


# --- Warm-start short-circuit (WARP-638) ------------------------------------
#
# On a warm start the whole stack is already up; the panel should surface the
# live UI within a few seconds instead of waiting on the probe / timeout. If
# the firmware link is live AND we've already received live stats, that IS
# readiness — complete boot without needing the HTTP probe to pass.

def test_readiness_tick_short_circuits_when_link_live_and_data_fresh(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # Pretend the firmware link is up and a stats frame has landed.
    monkeypatch.setattr(sim_display, "_backend", "pyportal")
    sim_display.update_stats({"cpu": 12, "now": "14:08"})
    # The HTTP probe would say "not ready" — but the warm-start path should
    # still surface the UI quickly and NOT depend on it.
    probed = {"n": 0}

    def _never_ready():
        probed["n"] += 1
        return False

    monkeypatch.setattr(sim_display, "_check_readiness", _never_ready)
    sim_display._boot_started_at = 1000.0
    # A few seconds in — well under BOOT_MAX_SECONDS.
    sim_display._readiness_tick(now=1004.0)
    assert sim_display._boot_complete is True
    assert sim_display._current_mode == TFTDisplay.SYSTEM


def test_readiness_tick_warm_start_does_not_apply_without_live_data(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # Cold boot: link not yet promoted + no stats. The short-circuit must NOT
    # fire — we still wait on the real readiness probe (which is False here).
    monkeypatch.setattr(sim_display, "_backend", "sim")
    monkeypatch.setattr(sim_display, "_check_readiness", lambda: False)
    sim_display._boot_started_at = 1000.0
    sim_display._readiness_tick(now=1004.0)
    assert sim_display._boot_complete is False
    assert sim_display._current_mode == TFTDisplay.BOOT


# --- Host reconnect-on-reset (WARP-638) -------------------------------------
#
# When the PyPortal is reset its USB CDC re-enumerates; the host's open fd goes
# stale (writes silently no-op, the path may vanish/reappear). The host must
# detect this, REOPEN the port, and resync full state — not keep writing to a
# dead fd while the device sits on its boot screen.

class _FakeSerial:
    """Minimal pyserial stand-in. `fail_write` flips writes to raise (the
    re-enumeration symptom); `closed` records that the stale fd was closed."""

    def __init__(self):
        self.written = []
        self.fail_write = False
        self.closed = False
        self.in_waiting = 0

    def write(self, data):
        if self.fail_write:
            raise OSError("device reports readiness... no — write failed")
        self.written.append(data)
        return len(data)

    def flush(self):
        if self.fail_write:
            raise OSError("flush on dead fd")

    def read(self, n):
        return b""

    def close(self):
        self.closed = True


def test_pyportal_send_reopens_on_write_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    # A write that raises (CDC re-enumerated) must drop the stale fd and
    # attempt a reconnect via _try_pyportal — not silently swallow forever.
    d = TFTDisplay()
    dead = _FakeSerial()
    dead.fail_write = True
    d._pyportal = dead
    d._pyportal_path = "/dev/ttyACM1"
    d._backend = "pyportal"

    reconnect = {"n": 0}

    def _fake_reconnect():
        reconnect["n"] += 1
        # Simulate a successful reopen onto a fresh, healthy fd.
        d._pyportal = _FakeSerial()
        d._pyportal_path = "/dev/ttyACM1"
        d._backend = "pyportal"
        d._needs_resync = True
        return True

    monkeypatch.setattr(d, "_try_pyportal", _fake_reconnect)
    d._pyportal_send("stats", {"cpu": 1})
    assert dead.closed is True, "stale fd must be closed on write failure"
    assert reconnect["n"] == 1, "must attempt exactly one reconnect"
    # Reconnect requests a full-state resync so the firmware refills.
    assert d._needs_resync is True


def test_check_pyportal_liveness_drops_fd_when_path_vanishes(
    monkeypatch: pytest.MonkeyPatch,
):
    # A reset can renumber ttyACM*; the old node disappears while our fd stays
    # silently open. The liveness check must notice the path is gone, close the
    # fd, and fall back so the promotion path re-probes whatever is now live.
    d = TFTDisplay()
    fd = _FakeSerial()
    d._pyportal = fd
    d._pyportal_path = "/dev/ttyACM1"
    d._backend = "pyportal"

    monkeypatch.setattr(display_module.os.path, "exists", lambda p: False)
    changed = d._check_pyportal_liveness(now=1000.0)
    assert changed is True, "liveness check should report a dropped link"
    assert fd.closed is True
    assert d._pyportal is None
    assert d._backend != "pyportal"


def test_check_pyportal_liveness_noop_when_path_present(
    monkeypatch: pytest.MonkeyPatch,
):
    d = TFTDisplay()
    fd = _FakeSerial()
    d._pyportal = fd
    d._pyportal_path = "/dev/ttyACM1"
    d._backend = "pyportal"
    monkeypatch.setattr(display_module.os.path, "exists", lambda p: True)
    # Within the throttle window the check is also a no-op; force it past.
    d._last_liveness_check = 0.0
    changed = d._check_pyportal_liveness(now=1000.0)
    assert changed is False
    assert fd.closed is False
    assert d._backend == "pyportal"


def test_check_pyportal_liveness_throttled(monkeypatch: pytest.MonkeyPatch):
    # Don't stat /dev on every ~80ms tick — gate it.
    d = TFTDisplay()
    fd = _FakeSerial()
    d._pyportal = fd
    d._pyportal_path = "/dev/ttyACM1"
    d._backend = "pyportal"
    calls = {"n": 0}

    def _exists(p):
        calls["n"] += 1
        return True

    monkeypatch.setattr(display_module.os.path, "exists", _exists)
    d._last_liveness_check = 999.5
    d._check_pyportal_liveness(now=1000.0)  # < interval after last check
    assert calls["n"] == 0, "liveness stat must be throttled"


def test_reconnect_triggers_full_state_resync_via_probe(
    monkeypatch: pytest.MonkeyPatch,
):
    # On a fresh probe (the reconnect path), _probe_pyportal must set
    # _needs_resync so the cycle loop pushes a full snapshot — otherwise the
    # firmware renders empty fields after a reset until the slowest periodic
    # push (30s).
    d = TFTDisplay()
    d._needs_resync = False

    class _OkSerial(_FakeSerial):
        def __init__(self):
            super().__init__()
            self._lines = [b"READY\n"]

        def reset_input_buffer(self):
            pass

        def readline(self):
            return self._lines.pop(0) if self._lines else b""

    import sys as _sys
    import types as _types
    fake_serial_mod = _types.ModuleType("serial")
    fake_serial_mod.Serial = lambda *a, **k: _OkSerial()
    monkeypatch.setitem(_sys.modules, "serial", fake_serial_mod)

    assert d._probe_pyportal("/dev/ttyACM1") is True
    assert d._needs_resync is True


# --- BOOT_MAX_SECONDS parsing (L1) ------------------------------------------

def test_env_positive_int_parses_valid_value():
    assert display_module._env_positive_int("X", 90, raw="120") == 120


def test_env_positive_int_falls_back_on_malformed_value():
    # L1 (WARP-624): a malformed BOOT_MAX_SECONDS must NOT raise at import and
    # kill the service — it degrades to the default.
    assert display_module._env_positive_int("X", 90, raw="ninety") == 90
    assert display_module._env_positive_int("X", 90, raw="") == 90
    assert display_module._env_positive_int("X", 90, raw="12.5") == 90


def test_env_positive_int_clamps_non_positive_to_default():
    # A zero/negative budget would make the boot timeout fire instantly (or
    # never make sense); clamp to the default so the fallback stays meaningful.
    assert display_module._env_positive_int("X", 90, raw="0") == 90
    assert display_module._env_positive_int("X", 90, raw="-5") == 90


def test_env_positive_int_uses_environ_when_no_raw(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SOME_BUDGET", "45")
    assert display_module._env_positive_int("SOME_BUDGET", 90) == 45
    monkeypatch.setenv("SOME_BUDGET", "garbage")
    assert display_module._env_positive_int("SOME_BUDGET", 90) == 90


def test_boot_max_seconds_is_a_positive_int():
    # The module-level constant must always be a usable positive int regardless
    # of how the env was set.
    assert isinstance(display_module.BOOT_MAX_SECONDS, int)
    assert display_module.BOOT_MAX_SECONDS > 0


# --- Claim screen (WARP-632 / ADR-017) -------------------------------------
#
# The orchestrator mints the claim code and pushes it via POST /display/claim;
# this service is a thin renderer. show_claim sets the `claim` mode, streams a
# `claim` frame to the firmware, and renders a sim preview so the dashboard
# preview works. render_claim draws the code prominently + the setup URL.

CLAIM_CODE = "DRPL-7K2Q-9F4M"
CLAIM_URL = "https://192.168.1.87/setup"


def test_claim_mode_constant_exists():
    # An explicit screen-id constant, mirroring BOOT/SHUTDOWN — never a bare
    # string literal sprinkled through the dispatch.
    assert TFTDisplay.CLAIM == "claim"


def test_render_claim_returns_full_frame(sim_display: TFTDisplay):
    img = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_claim_tolerates_empty_inputs(sim_display: TFTDisplay):
    # A defensive render: even with no code / no URL yet (host hasn't pushed),
    # we must still produce a valid frame rather than throw.
    img = sim_display.render_claim("", "")
    assert img.size == (WIDTH, HEIGHT)


def test_show_claim_sets_mode_and_writes_preview_frame(
    sim_display: TFTDisplay, tmp_path
):
    out = tmp_path / "claim.png"
    display_module.SIM_OUTPUT = out  # redirect preview for this assertion
    sim_display.show_claim(CLAIM_CODE, CLAIM_URL)
    assert sim_display._current_mode == TFTDisplay.CLAIM
    assert out.exists()
    with Image.open(out) as im:
        assert im.size == (WIDTH, HEIGHT)


def test_show_claim_sends_claim_frame_to_firmware(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # The render path to the PHYSICAL panel is the `claim` serial frame — NOT
    # the preview-only /display/custom image path. Assert show_claim emits a
    # ("claim", {code, setup_url}) frame the firmware can dispatch on.
    sent = _spy_pyportal_send(sim_display, monkeypatch)

    sim_display.show_claim(CLAIM_CODE, CLAIM_URL)

    claim_frames = [(m, d) for (m, d) in sent if m == "claim"]
    assert claim_frames, f"expected a claim frame; got {sent!r}"
    _, data = claim_frames[0]
    assert data == {"code": CLAIM_CODE, "setup_url": CLAIM_URL}


def test_show_claim_stores_state_for_rerender(sim_display: TFTDisplay):
    # The code + URL must be retained so a live re-render (cycle loop) of the
    # claim screen keeps showing them.
    sim_display.show_claim(CLAIM_CODE, CLAIM_URL)
    assert sim_display._claim_code == CLAIM_CODE
    assert sim_display._claim_setup_url == CLAIM_URL


def test_render_dispatch_routes_claim_mode(sim_display: TFTDisplay):
    # _render_current_locked must dispatch the claim mode to render_claim — not
    # fall through to render_home (the catch-all). We assert by driving a real
    # show_claim and confirming the mode sticks + a frame was produced.
    sim_display.show_claim(CLAIM_CODE, CLAIM_URL)
    # Re-render under the current mode; must not throw and must stay on claim.
    sim_display._render_current()
    assert sim_display._current_mode == TFTDisplay.CLAIM


def test_show_system_sets_mode(sim_display: TFTDisplay):
    # py-v3 claim-screen exit: show_system navigates the panel to the combined
    # System screen and renders a frame without error (sim backend).
    sim_display.show_system()
    assert sim_display._current_mode == TFTDisplay.SYSTEM


def test_show_system_sends_bare_system_nav(
    sim_display: TFTDisplay, monkeypatch: pytest.MonkeyPatch
):
    # The firmware leaves the modal claim screen only on a BARE mode nav (no
    # data). show_system must emit ("system", None) — a stats *data* frame would
    # NOT navigate the device off the claim screen.
    sent = _spy_pyportal_send(sim_display, monkeypatch)
    sim_display.show_system()
    system_frames = [(m, d) for (m, d) in sent if m == "system"]
    assert system_frames, f"expected a bare system nav; got {sent!r}"
    _, data = system_frames[0]
    assert data is None


def test_show_system_transitions_off_claim(sim_display: TFTDisplay):
    # The end-to-end bug this fixes: a box parked on the modal claim screen must
    # transition to the live System screen once claimed. Drive claim → system and
    # assert the panel actually left claim.
    sim_display.show_claim(CLAIM_CODE, CLAIM_URL)
    assert sim_display._current_mode == TFTDisplay.CLAIM
    sim_display.show_system()
    assert sim_display._current_mode == TFTDisplay.SYSTEM
