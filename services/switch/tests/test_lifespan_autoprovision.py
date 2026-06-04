"""Tests for the lifespan auto-provision behaviour (main.py).

Contract (ADR-018 item 9):
  * Gated by env SWITCH_AUTOPROVISION (default "0"/off).
  * Only runs if the driver connected (driver_instance not None).
  * Runs as a NON-BLOCKING background task with a hard timeout — never blocks
    boot, no exception escapes (switch-absent / errors = logged no-op).

These drive the seams the lifespan uses (`autoprovision_enabled`,
`run_provisioner_safe`) so the gating + non-blocking + swallow-all behaviour is
verified without racing the real ASGI lifespan. All against the fake driver.
"""

from __future__ import annotations

import asyncio
import importlib

import pytest

from tests.fakes import FakeSwitchDriver

pytestmark = pytest.mark.asyncio


def _main(monkeypatch, **env):
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    import main as _m

    importlib.reload(_m)
    return _m


async def test_autoprovision_disabled_by_default(monkeypatch):
    main = _main(monkeypatch, SWITCH_AUTOPROVISION=None)
    assert main.autoprovision_enabled() is False


@pytest.mark.parametrize("val,expected", [("1", True), ("true", True), ("TRUE", True), ("0", False), ("no", False), ("", False)])
async def test_autoprovision_env_parsing(monkeypatch, val, expected):
    main = _main(monkeypatch, SWITCH_AUTOPROVISION=val)
    assert main.autoprovision_enabled() is expected


async def test_run_provisioner_safe_swallows_exceptions(monkeypatch):
    # A driver whose read explodes must NOT raise out of the safe wrapper —
    # boot must never be blocked by a provisioning failure.
    main = _main(monkeypatch)

    class BoomDriver(FakeSwitchDriver):
        async def get_ports(self):
            raise RuntimeError("catastrophic switch fault")

    main.driver_instance = BoomDriver()
    # Must not raise.
    await main.run_provisioner_safe()


async def test_run_provisioner_safe_noop_when_driver_absent(monkeypatch):
    main = _main(monkeypatch)
    main.driver_instance = None
    # Must not raise; switch-absent is a no-op.
    await main.run_provisioner_safe()


async def test_run_provisioner_safe_applies_when_connected(monkeypatch):
    main = _main(monkeypatch, SWITCH_PROTECTED_PORT="9", SWITCH_VLAN_PROFILE="flat-lan")
    driver = FakeSwitchDriver(port_vlans={1: 100}, vlans={1, 100})
    main.driver_instance = driver

    await main.run_provisioner_safe()

    # The stranded port was moved back to VLAN 1.
    assert driver.port_vlans[1] == 1


async def test_run_provisioner_safe_honours_hard_timeout(monkeypatch):
    # If a reconcile hangs, the safe wrapper must bail at the hard timeout
    # rather than wedge boot forever.
    main = _main(monkeypatch, SWITCH_PROVISION_TIMEOUT="0.05")

    class HangDriver(FakeSwitchDriver):
        async def get_ports(self):
            await asyncio.sleep(5)  # longer than the hard timeout
            return await super().get_ports()

    main.driver_instance = HangDriver()
    # Returns promptly (well under the 5s sleep) and does not raise.
    await asyncio.wait_for(main.run_provisioner_safe(), timeout=2.0)
