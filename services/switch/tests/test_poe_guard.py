"""WARP-1734: cutting PoE to a device the switch can see is a hard refusal.

ADR-035 §7. De-powering a fabric member is the ONE action in this rack with
no remote recovery: the device cannot roll itself back, cannot confirm, and
cannot be reached to undo the change. The switch already knows what is on
each port — verified live on the lab unit, lan2 carries the AP's MAC and
draws 6.4 W — so the control plane can and must refuse rather than warn.

Guard shape under test:
  * disable + device present            -> PoweredMemberError (409 upstream)
  * disable + device present + force    -> proceeds
  * disable + nothing learned on port   -> proceeds (nothing to darken)
  * disable + FDB unavailable/malformed -> REFUSED (audit 2026-08-06: fail
    closed — if we can't verify the port is safe to cut, don't cut it; `force`
    is the override, so an older image without the plugin isn't bricked). This
    reverses the WARP-1734 fail-open default.
  * ENABLE is never guarded             -> restoring power is always safe
"""

from __future__ import annotations

import pytest

from drivers.base import PoweredMemberError
from drivers.openwrt import OpenWrtSwitchDriver

AP_MAC = "80:ea:0b:39:ae:23"


def _driver(fdb_result, **kw):
    """Driver whose _ubus answers bridge.fdb with `fdb_result` (or raises it)
    and accepts the poe write path. plan_only keeps writes side-effect free —
    the guard runs BEFORE the plan_only short-circuit, which is the point.
    """
    d = OpenWrtSwitchDriver(host="192.0.2.1", password="x", **kw)

    async def fake_ubus(obj, method, args=None):
        if (obj, method) == ("bridge", "fdb"):
            if isinstance(fdb_result, Exception):
                raise fdb_result
            return fdb_result
        return {}

    d._ubus = fake_ubus  # type: ignore[assignment]
    return d


ON_LAN2 = {"entries": [
    {"mac": AP_MAC, "port": "lan2", "vlan": 1},
    {"mac": "9c:6b:00:d0:4d:ff", "port": "lan8", "vlan": 1},
]}


class TestGuardRefuses:
    @pytest.mark.asyncio
    async def test_disable_on_a_port_with_a_device_is_refused(self):
        d = _driver(ON_LAN2)
        with pytest.raises(PoweredMemberError) as ei:
            await d.set_port_poe(2, False)
        # The message must NAME what it protects — an operator who cannot see
        # which device is at risk will just re-run with force.
        assert AP_MAC in str(ei.value)
        assert "force" in str(ei.value).lower()

    @pytest.mark.asyncio
    async def test_force_overrides(self):
        d = _driver(ON_LAN2)
        result = await d.set_port_poe(2, False, force=True)
        assert result is not None

    @pytest.mark.asyncio
    async def test_empty_port_is_not_guarded(self):
        d = _driver(ON_LAN2)
        result = await d.set_port_poe(5, False)  # nothing learned on lan5
        assert result is not None


class TestGuardFailsClosed:
    """Unknown topology must FAIL CLOSED (audit 2026-08-06).

    This REVERSES the WARP-1734 fail-open default. Rationale: de-powering a
    device has no remote recovery, so if the switch cannot tell us what a port
    feeds we must not cut it. `force=true` remains the operator override, so an
    older image without the bridge.fdb plugin is not bricked — it just requires
    an explicit override, which is the safe direction for a shipping product.
    """

    @pytest.mark.asyncio
    async def test_fdb_unavailable_is_refused(self):
        from drivers.base import SwitchAPIError
        d = _driver(SwitchAPIError(code=404, message="Object not found"))
        with pytest.raises(PoweredMemberError) as ei:
            await d.set_port_poe(2, False)
        assert "force" in str(ei.value).lower()

    @pytest.mark.asyncio
    async def test_fdb_unavailable_force_overrides(self):
        from drivers.base import SwitchAPIError
        d = _driver(SwitchAPIError(code=404, message="Object not found"))
        result = await d.set_port_poe(2, False, force=True)
        assert result is not None

    @pytest.mark.asyncio
    async def test_permission_denied_is_refused(self):
        from drivers.base import SwitchAPIError
        d = _driver(SwitchAPIError(code=6, message="Permission denied"))
        with pytest.raises(PoweredMemberError):
            await d.set_port_poe(2, False)

    @pytest.mark.asyncio
    async def test_malformed_fdb_is_refused(self):
        d = _driver({"entries": "not-a-list"})
        with pytest.raises(PoweredMemberError):
            await d.set_port_poe(2, False)


class TestEnableNeverGuarded:
    @pytest.mark.asyncio
    async def test_enable_on_a_powered_port_proceeds(self):
        d = _driver(ON_LAN2)
        result = await d.set_port_poe(2, True)
        assert result is not None


class TestGetFdb:
    @pytest.mark.asyncio
    async def test_parses_and_lowercases(self):
        d = _driver({"entries": [{"mac": "80:EA:0B:39:AE:23", "port": "lan2", "vlan": 1}]})
        assert await d.get_fdb() == [
            {"mac": AP_MAC, "port": "lan2", "vlan": 1},
        ]

    @pytest.mark.asyncio
    async def test_drops_entries_missing_mac_or_port(self):
        d = _driver({"entries": [
            {"port": "lan2"},
            {"mac": AP_MAC},
            {"mac": AP_MAC, "port": "lan2"},
        ]})
        assert len(await d.get_fdb()) == 1

    @pytest.mark.asyncio
    async def test_port_powers_matches_lanN(self):
        d = _driver(ON_LAN2)
        assert await d.port_powers(2) == [AP_MAC]
        assert await d.port_powers(8) == ["9c:6b:00:d0:4d:ff"]
        assert await d.port_powers(3) == []
