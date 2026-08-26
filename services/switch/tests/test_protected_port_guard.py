"""WARP-2165: the switch service must refuse to darken its own uplink.

`SWITCH_PROTECTED_PORT` names the port that carries the appliance's link to
the router. Until now it was consulted in exactly two places, and neither was
the write path: the provisioner's desired-state builder (`main.py`), and the
orchestrator's Tier-3 route guard (`apps/orchestrator/src/routes/switch.ts`).

That left the driver itself unguarded. Anything holding `SERVICE_TOKEN_SWITCH`
could reach `:8081` directly and cut the uplink — severing the box from the
router, and from itself. Harmless while writes were plan-only; it stopped
being harmless on 2026-08-24 when `SWITCH_LIVE_WRITES=1` was enabled on the
bench box.

Defense in depth: the layer that PERFORMS the write refuses it too, rather
than trusting that every caller went through the orchestrator.

Guard shape under test:
  * disable protected port            -> ProtectedPortError
  * disable protected port + force    -> STILL refused (unlike ADR-035 §7)
  * disable any other port            -> falls through to the normal path
  * ENABLE the protected port         -> always allowed (restoring is safe)
  * no protected port configured (0)  -> nothing is protected
"""

from __future__ import annotations

import pytest

from drivers.base import PoweredMemberError, ProtectedPortError
from drivers.openwrt import OpenWrtSwitchDriver

UPLINK = 8

# Nothing learned on the port, so the ADR-035 §7 powered-member guard would
# ALLOW the cut. Any refusal below therefore comes from the protected-port
# guard and not from its neighbour — the two must not be confused.
EMPTY_FDB = {"entries": []}


def _driver(protected_port=UPLINK, **kw):
    d = OpenWrtSwitchDriver(
        host="192.0.2.1", password="x", protected_port=protected_port, **kw
    )

    async def fake_ubus(obj, method, args=None):
        if (obj, method) == ("bridge", "fdb"):
            return EMPTY_FDB
        return {}

    d._ubus = fake_ubus  # type: ignore[assignment]
    return d


class TestPoeGuard:
    @pytest.mark.asyncio
    async def test_cutting_poe_on_the_uplink_is_refused(self):
        with pytest.raises(ProtectedPortError) as ei:
            await _driver().set_port_poe(UPLINK, False)
        # An operator reading only the error must learn WHICH port and WHY.
        assert str(UPLINK) in str(ei.value)
        assert "uplink" in str(ei.value).lower()

    @pytest.mark.asyncio
    async def test_force_does_not_override_it(self):
        """ADR-035 §7's powered-member refusal has a `force` escape hatch
        because the operator may legitimately want to darken an AP. This one
        does not: forcing it cuts the link the request itself arrived over,
        so there is no outcome in which honouring it was correct."""
        with pytest.raises(ProtectedPortError):
            await _driver().set_port_poe(UPLINK, False, force=True)

    @pytest.mark.asyncio
    async def test_other_ports_are_untouched_by_the_guard(self):
        # Port 2 is not protected and the FDB is empty, so this reaches the
        # normal (plan-only) write path and returns a plan.
        plan = await _driver().set_port_poe(2, False)
        assert plan is not None

    @pytest.mark.asyncio
    async def test_enabling_the_protected_port_is_always_allowed(self):
        """Restoring power can only ever help. A guard that blocked it would
        make the uplink unrecoverable through the product."""
        plan = await _driver().set_port_poe(UPLINK, True)
        assert plan is not None

    @pytest.mark.asyncio
    async def test_zero_means_nothing_is_protected(self):
        plan = await _driver(protected_port=0).set_port_poe(UPLINK, False)
        assert plan is not None


class TestPortAdminGuard:
    @pytest.mark.asyncio
    async def test_disabling_the_uplink_port_is_refused(self):
        """`set_port_enabled` currently raises 501 (WARP-1674, unimplemented).
        The guard must sit BEFORE that, so the refusal stays correct the day
        the write path lands rather than silently becoming an unguarded cut."""
        with pytest.raises(ProtectedPortError):
            await _driver().set_port_enabled(UPLINK, False)

    @pytest.mark.asyncio
    async def test_enabling_the_uplink_port_is_not_refused_by_this_guard(self):
        # Reaches the unimplemented-write error, NOT the protected-port one.
        with pytest.raises(Exception) as ei:
            await _driver().set_port_enabled(UPLINK, True)
        assert not isinstance(ei.value, ProtectedPortError)


class TestGuardIsDistinctFromItsNeighbour:
    @pytest.mark.asyncio
    async def test_an_unprotected_port_with_a_device_still_raises_the_other_error(self):
        """Regression fence: adding this guard must not swallow ADR-035 §7."""
        d = _driver(protected_port=UPLINK)

        async def fdb_with_device(obj, method, args=None):
            if (obj, method) == ("bridge", "fdb"):
                return {"entries": [{"mac": "80:ea:0b:39:b6:9c", "port": "lan1", "vlan": 1}]}
            return {}

        d._ubus = fdb_with_device  # type: ignore[assignment]
        with pytest.raises(PoweredMemberError):
            await d.set_port_poe(1, False)
