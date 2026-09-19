"""WARP-2890 — `VPNApi.reload_interface` must actually re-run the interface.

Measured on a live RB5009 (OpenWrt 25.12.5) on 2026-09-18, with a peer
committed in uci but absent from the kernel:

    ubus call network.interface.wg0 up      -> peer NOT back (no-op: already up)
    ubus call network reload                -> peer NOT back (peers are not diffed)
    ubus call network.interface.wg0 down
    ubus call network.interface.wg0 up      -> peer back

The pre-fix `reload_interface` issued only the first call, so every peer added
or revoked through the product on a live wg0 stayed config-only — the
routing handlers detected it (`peer_verified: false`,
`revocation_verified: false`) but the remediation they relied on never fired.

These tests pin the ubus sequence against a scripted router, at the SDK
level, so the mock router's "reload syncs kernel from config" model in
`mock_router.py` cannot mask a regression in the real call sequence.
"""
from __future__ import annotations

from collections import deque

import pytest

from droplet_openwrt_sdk import UbusError, VPNApi

IFACE = "network.interface.wg0"
SETTING_UP = {"up": False, "pending": True}
UP = {"up": True, "pending": False, "l3_device": "wg0"}


class _ScriptedRouter:
    """Records every ubus call; answers `status` reads from a script."""

    def __init__(self, statuses, fail=None):
        self.calls: list[tuple[str, str]] = []
        self._statuses = deque(statuses)
        self._fail = set(fail or ())

    def _call(self, obj, method, args=None):
        self.calls.append((obj, method))
        if method in self._fail:
            raise UbusError(f"{obj} {method} refused")
        if method == "status":
            if not self._statuses:
                return dict(UP)
            return dict(self._statuses.popleft())
        return {}


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """The poll loop sleeps between status reads; never do so in a test."""
    slept: list[float] = []
    monkeypatch.setattr("droplet_openwrt_sdk.time.sleep", lambda s: slept.append(s))
    return slept


class TestReloadInterfaceBouncesTheInterface:
    def test_down_then_up_before_any_status_read(self) -> None:
        # The regression the ticket is about: `up` alone is a no-op on a live
        # interface. The bounce must be down THEN up, and both must happen
        # before the settle wait starts reading status.
        router = _ScriptedRouter(statuses=[UP])
        assert VPNApi(router).reload_interface("wg0") is True
        assert router.calls[:2] == [(IFACE, "down"), (IFACE, "up")]
        assert router.calls[2:] == [(IFACE, "status")]

    def test_interface_name_is_honoured(self) -> None:
        router = _ScriptedRouter(statuses=[UP])
        VPNApi(router).reload_interface("wg1")
        assert router.calls[:2] == [
            ("network.interface.wg1", "down"),
            ("network.interface.wg1", "up"),
        ]

    def test_waits_while_netifd_is_still_setting_up(self, _no_real_sleep) -> None:
        # `up` returns before the proto handler has run `wg set`. Reading
        # live_peers in that window would report the peer missing, so the
        # reload must not return until netifd says up and not pending.
        router = _ScriptedRouter(statuses=[SETTING_UP, SETTING_UP, UP])
        assert VPNApi(router).reload_interface() is True
        assert router.calls.count((IFACE, "status")) == 3
        assert len(_no_real_sleep) == 2, "sleeps between polls, not after success"

    def test_stale_up_from_before_the_bounce_is_not_trusted_while_pending(self) -> None:
        # netifd can answer `up: true, pending: true` mid-transition; that is
        # not "came back up".
        router = _ScriptedRouter(statuses=[{"up": True, "pending": True}, UP])
        assert VPNApi(router).reload_interface() is True
        assert router.calls.count((IFACE, "status")) == 2


class TestReloadInterfaceFailsHonestly:
    def test_interface_that_never_comes_back_returns_false(self) -> None:
        router = _ScriptedRouter(statuses=[SETTING_UP] * 50)
        vpn = VPNApi(router)
        vpn.RELOAD_SETTLE_SECONDS = 0.0  # the window expires on the first miss
        assert vpn.reload_interface() is False
        assert router.calls[:2] == [(IFACE, "down"), (IFACE, "up")]

    def test_refused_down_still_attempts_up_and_reports_unconfirmed(self) -> None:
        # A transport error can land after netifd processed the `down`;
        # leaving the interface down would be worse than an unconfirmed
        # reload. So `up` is still sent, and the result is False (not proven).
        router = _ScriptedRouter(statuses=[UP], fail={"down"})
        assert VPNApi(router).reload_interface() is False
        assert (IFACE, "up") in router.calls
        assert (IFACE, "status") not in router.calls, "no settle wait on a failed bounce"

    def test_refused_up_reports_unconfirmed(self) -> None:
        router = _ScriptedRouter(statuses=[UP], fail={"up"})
        assert VPNApi(router).reload_interface() is False
        assert (IFACE, "status") not in router.calls

    def test_unreadable_status_reports_unconfirmed(self) -> None:
        router = _ScriptedRouter(statuses=[], fail={"status"})
        assert VPNApi(router).reload_interface() is False
        assert router.calls == [(IFACE, "down"), (IFACE, "up"), (IFACE, "status")]
