"""Shared pytest fixtures for services/routing.

Established by WARP-45. Reusable across upcoming tickets (WARP-40 rollback
polling, WARP-41 token binding) so each test can mock the OpenWrt SDK instead
of needing a real router.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# --- Pre-import env setup ---
# `main` reads OPENWRT_PASSWORD and ROUTING_SERVICE_TOKEN at module import time,
# so sane defaults have to be in os.environ *before* we import main below.
# Tests that need different values monkeypatch the module attributes directly
# (module globals are looked up at call time inside require_bearer, so patches
# take effect without reloading).
os.environ.setdefault("OPENWRT_PASSWORD", "pytest-fake-pw")
os.environ.setdefault("ROUTING_SERVICE_TOKEN", "pytest-fake-token")

# Make `import main` work when pytest is invoked from the repo root.
_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
# WARP-1061 — the samplers (scheduler.py, egress_meter.py, dns_block_meter.py)
# import `_shared.internal_tls` at module level. In-container the helper is
# COPY'd to /app/_shared (sibling of the source); in the repo it lives at
# services/_shared, so add services/ to the path (voice-io precedent).
_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from droplet_openwrt_sdk import ConnectionLost  # noqa: E402
from reconnect import ReconnectCoordinator  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_reconnect_coordinator(monkeypatch: pytest.MonkeyPatch) -> None:
    """WARP-1510 safety net.

    `get_router()` now makes a cooldown-guarded on-demand reconnect attempt
    whenever `router_instance` is None. Every test written before this
    ticket sets that up directly (`monkeypatch.setattr(main,
    "router_instance", None)`, in this file's `disconnected_client` or
    inline in test_aps.py / test_vpn.py / test_topology.py /
    test_system_firmware_routes.py) and asserts a fast 503 without
    expecting any real network I/O. Without this fixture those tests would
    each try to dial the real `DropletRouter(host=OPENWRT_HOST, ...)` —
    unreachable from a test box — and hang.

    Runs for every test automatically:

      1. Stubs `main.DropletRouter` to fail instantly (no real socket
         calls), so any reconnect attempt a test doesn't care about stays
         fast and disconnected — same observable 503 as before this
         ticket.
      2. Swaps in a brand-new `ReconnectCoordinator` so cooldown/backoff
         state can never leak between tests (the real one is a
         process-wide singleton on `main`).

    Tests that want to exercise a *successful* reconnect (test_reconnect.py)
    override `main.DropletRouter` and/or `main.reconnect_coordinator`
    themselves, after this fixture has already run.
    """

    def _fails_fast(*_args, **_kwargs):
        raise ConnectionLost("test double: no real OpenWrt router in the test suite")

    monkeypatch.setattr(main, "DropletRouter", _fails_fast)
    # WARP-1673: the failure-kind classifier is process-global on main, same as
    # `router_instance` — reset it so an auth-failure test can never leak the
    # typed 502 into a neighbour expecting the plain 503.
    monkeypatch.setattr(main, "_last_connect_failure", None)
    monkeypatch.setattr(
        main,
        "reconnect_coordinator",
        ReconnectCoordinator(
            connect_fn=main._connect_to_openwrt,
            on_connected=main._set_router_instance,
            is_connected=main._router_is_connected,
        ),
    )


@pytest.fixture
def mock_router() -> MagicMock:
    """A MagicMock DropletRouter — connected and authenticated, zero real I/O.

    Set this into `main.router_instance` via the `connected_client` fixture, or
    patch it into other code paths as needed. Tests that want the "router not
    connected" state just don't use it.
    """
    router = MagicMock(name="DropletRouter")
    router.system.board_info.return_value = {
        "kernel": "6.6.0-test",
        "hostname": "test-router",
        "system": "OpenWrt SNAPSHOT",
        "model": "test",
        "release": {"distribution": "OpenWrt", "version": "SNAPSHOT"},
    }
    return router


@pytest.fixture
def connected_client(monkeypatch: pytest.MonkeyPatch, mock_router: MagicMock) -> TestClient:
    """TestClient with `main.router_instance` populated — routes returning 503
    because the router is unreachable will instead reach the mock."""
    monkeypatch.setattr(main, "router_instance", mock_router)
    return TestClient(main.app)


@pytest.fixture
def disconnected_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient with `main.router_instance = None`. Routes that depend on
    `get_router()` will return 503; useful for auth-only tests where we don't
    need real router behaviour."""
    monkeypatch.setattr(main, "router_instance", None)
    return TestClient(main.app)


@pytest.fixture
def set_token(monkeypatch: pytest.MonkeyPatch):
    """Override `main.ROUTING_SERVICE_TOKEN` for one test.

    require_bearer() looks up the module global at call time, so patching here
    works without reloading the module.
    """

    def _setter(value: str) -> None:
        monkeypatch.setattr(main, "ROUTING_SERVICE_TOKEN", value)

    return _setter
