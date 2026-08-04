"""Unit tests for the bring-up provisioner (ADR-018 action item 9).

Every test runs against the in-memory FakeSwitchDriver — NO test ever touches
live switch hardware.

Coverage map (mirrors the ticket's required cases):
  - flat-lan no-ops a camera port already on VLAN 1
  - flat-lan moves a stranded access port back to untagged VLAN 1 (the AP fix)
  - flat-lan NEVER creates VLAN 100 / VLAN 50
  - protected (uplink) port is never moved off its trunk
  - idempotent: a second reconcile against the now-desired state writes nothing
  - segmented is gated OFF (refuses, stays flat-lan) when cameras.present != True
  - segmented applies isolation only when cameras.present === True
  - switch-absent (driver None) is a no-op
  - backup_config is taken before the first write; never on a no-op
  - read-back-verify surfaces a mismatch as an error
  - a 404/empty VLAN read is tolerated (log + no-op), never a crash
"""

from __future__ import annotations

import pytest

from drivers.base import SwitchAPIError
from provisioner import ProvisionConfig, reconcile_switch
from tests.fakes import FakeSwitchDriver, FakeRoutingClient

pytestmark = pytest.mark.asyncio


# --- flat-lan ---------------------------------------------------------------


async def test_flat_lan_noops_camera_already_on_vlan1():
    # All access ports (incl. the camera on port 1) already untagged on VLAN 1.
    driver = FakeSwitchDriver(port_vlans={p: 1 for p in range(1, 9)})
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9, camera_ports=[1, 2])

    result = await reconcile_switch(driver, cfg)

    assert result["status"] == "noop"
    assert result["profile_applied"] == "flat-lan"
    assert result["ports_changed"] == []
    assert driver.membership_writes == []
    assert driver.backup_calls == 0  # no write => no backup


async def test_flat_lan_moves_stranded_port_back_to_vlan1():
    # Port 4 is stranded on VLAN 100 (the symptom: a plugged AP on an isolated
    # VLAN, invisible). flat-lan must move ONLY port 4 back to untagged VLAN 1.
    driver = FakeSwitchDriver(
        port_vlans={1: 1, 2: 1, 3: 1, 4: 100, 5: 1, 6: 1, 7: 1, 8: 1},
        vlans={1, 100},
    )
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(driver, cfg)

    assert result["status"] == "applied"
    assert result["ports_changed"] == [4]
    assert driver.port_vlans[4] == 1
    # other ports untouched
    assert all(driver.port_vlans[p] == 1 for p in range(1, 9))


async def test_flat_lan_never_creates_segmented_vlans():
    driver = FakeSwitchDriver(
        port_vlans={1: 100, 2: 50, 3: 1},
        vlans={1, 50, 100},
        trunk_ports={9, 10},
    )
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    await reconcile_switch(driver, cfg)

    # flat-lan only moves access ports back to VLAN 1; it must never mint a
    # camera/AP VLAN.
    assert driver.created_vlans == []
    assert driver.port_vlans[1] == 1
    assert driver.port_vlans[2] == 1


async def test_protected_port_never_moved():
    # Even if the uplink/protected port somehow reads as a non-LAN VLAN, the
    # provisioner must never reassign it (that would sever the box's uplink).
    driver = FakeSwitchDriver(
        port_vlans={1: 1, 2: 1},
        trunk_ports={9},  # port 9 is the trunk/uplink
        vlans={1},
    )
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(driver, cfg)

    assert 9 not in result["ports_changed"]
    for vlan_id, membership in driver.membership_writes:
        assert all(entry["port"] != 9 or entry["tagged"] for entry in membership)


async def test_flat_lan_is_idempotent():
    driver = FakeSwitchDriver(
        port_vlans={1: 1, 2: 1, 3: 100, 4: 1},
        vlans={1, 100},
    )
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    first = await reconcile_switch(driver, cfg)
    assert first["status"] == "applied"
    assert first["ports_changed"] == [3]

    writes_after_first = len(driver.membership_writes)
    second = await reconcile_switch(driver, cfg)

    assert second["status"] == "noop"
    assert second["ports_changed"] == []
    assert len(driver.membership_writes) == writes_after_first  # no new writes


async def test_flat_lan_backup_taken_before_first_write():
    driver = FakeSwitchDriver(port_vlans={1: 100}, vlans={1, 100})
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    await reconcile_switch(driver, cfg)

    assert driver.backup_calls == 1
    # backup must precede the membership write in time-order
    assert driver.write_order.index("backup") < driver.write_order.index("set_membership:1")


# --- segmented (double-gated) -----------------------------------------------


async def test_segmented_refuses_when_cameras_not_present():
    # SWITCH_VLAN_PROFILE=segmented but the routing cross-check says the camera
    # VLAN routing does NOT exist (item 9 depends on item 3). The provisioner
    # must REFUSE to isolate, behave flat-lan, and surface the misconfig.
    driver = FakeSwitchDriver(port_vlans={1: 1, 2: 1}, vlans={1})
    routing = FakeRoutingClient(cameras_present=False)
    cfg = ProvisionConfig(
        profile="segmented", protected_port=9, camera_ports=[1], ap_ports=[2]
    )

    result = await reconcile_switch(driver, cfg, routing_client=routing)

    assert result["status"] == "refused"
    assert result["profile_applied"] == "flat-lan"  # stayed flat-lan
    assert result["skipped_reason"]
    assert "camera" in result["skipped_reason"].lower()
    assert driver.created_vlans == []  # never isolated


async def test_segmented_refuses_when_routing_unreachable():
    driver = FakeSwitchDriver(port_vlans={1: 1}, vlans={1})
    routing = FakeRoutingClient(raise_exc=RuntimeError("routing unreachable"))
    cfg = ProvisionConfig(profile="segmented", protected_port=9, camera_ports=[1])

    result = await reconcile_switch(driver, cfg, routing_client=routing)

    # Can't confirm the camera VLAN exists => refuse to isolate (fail safe).
    assert result["status"] == "refused"
    assert result["profile_applied"] == "flat-lan"
    assert driver.created_vlans == []


async def test_segmented_applies_isolation_when_cameras_present():
    driver = FakeSwitchDriver(
        port_vlans={1: 1, 2: 1, 3: 1}, vlans={1}, trunk_ports={9, 10}
    )
    routing = FakeRoutingClient(cameras_present=True)
    cfg = ProvisionConfig(
        profile="segmented",
        protected_port=9,
        camera_ports=[1, 2],
        ap_ports=[3],
    )

    result = await reconcile_switch(driver, cfg, routing_client=routing)

    assert result["status"] == "applied"
    assert result["profile_applied"] == "segmented"
    # camera VLAN (100) and AP VLAN (50) created, cameras moved onto VLAN 100
    assert 100 in driver.vlans
    assert 50 in driver.vlans
    assert driver.port_vlans[1] == 100
    assert driver.port_vlans[2] == 100
    assert driver.port_vlans[3] == 50


# --- switch absent / fault tolerance ----------------------------------------


async def test_switch_absent_is_noop():
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(None, cfg)

    assert result["status"] == "skipped"
    assert result["skipped_reason"]
    assert "switch" in result["skipped_reason"].lower()


async def test_vlan_read_404_is_tolerated():
    # v1.04.0079 firmware: /stat/vlan returns 404 (driver-fix note). The
    # provisioner must log + no-op, never crash.
    driver = FakeSwitchDriver(port_vlans={1: 100}, vlans={1, 100})
    driver.raise_on_vlan_read = SwitchAPIError(404, "Not Found")
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(driver, cfg)

    assert result["status"] == "skipped"
    assert result["skipped_reason"]
    assert driver.membership_writes == []  # no blind writes on an unreadable switch


async def test_membership_read_404_is_tolerated():
    driver = FakeSwitchDriver(port_vlans={1: 100}, vlans={1, 100})
    driver.raise_on_membership_read = SwitchAPIError(404, "Not Found")
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(driver, cfg)

    assert result["status"] == "skipped"
    assert driver.membership_writes == []


async def test_read_back_verify_mismatch_is_surfaced():
    # Simulate a switch whose write silently doesn't take: set_vlan_membership
    # records the write but the PVID map doesn't change, so the read-back
    # disagrees with the desired state. The provisioner must report an error.
    class StickyDriver(FakeSwitchDriver):
        async def set_vlan_membership(self, vlan_id, membership):
            # record the attempt but DON'T apply it (write didn't take)
            self.membership_writes.append((vlan_id, membership))
            self.write_order.append(f"set_membership:{vlan_id}")

    driver = StickyDriver(port_vlans={1: 100}, vlans={1, 100})
    cfg = ProvisionConfig(profile="flat-lan", protected_port=9)

    result = await reconcile_switch(driver, cfg)

    assert result["status"] == "error"
    assert result["skipped_reason"]
    assert "verif" in result["skipped_reason"].lower()
