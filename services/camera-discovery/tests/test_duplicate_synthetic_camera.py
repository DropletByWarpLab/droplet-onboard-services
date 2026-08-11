"""One physical camera must never be adopted twice under two identities.

Observed on the appliance: 192.168.9.219 (a Hanwha XNV-C8083R) existed TWICE in
the orchestrator DB —

    xnv_c8083r_e43022502afd | 192.168.9.219 | e4:30:22:50:2a:fd  (08-10 19:57)
    camera_192_168_9_219    | 192.168.9.219 | ip:192.168.9.219   (08-11 01:03)

Mechanism: the subnet sweep mints a synthetic ``ip:<addr>`` key for any swept
host that is not in the DHCP lease list, so static-IP cameras still get adopted.
``_reconcile_synthetic_macs`` then repairs those keys once a lease appears —
but only in the direction *synthetic first, real MAC later*.

The reverse also happens: a camera adopted under its real MAC, whose lease then
stops being visible. Losing sight of the lease table is routine — the appliance
moving between its wired and Wi-Fi legs is enough, since the camera segment sits
behind the edge router. The sweep still sees the host, mints ``ip:<addr>``, and
the candidate flows through as a brand-new camera.

The fix is to exclude IPs already adopted, whatever key they were adopted under.
"""

from __future__ import annotations

import importlib

import pytest


def _fresh_main(monkeypatch):
    monkeypatch.setenv("CAMERA_SUBNET", "192.168.9.0/24")
    import main

    return importlib.reload(main)


def _sweep_synthetics(main, swept, leases):
    """Call the PRODUCTION builder.

    Deliberately not a local reimplementation of the filter: a test carrying its
    own copy of the logic passes even when the fix is reverted, which is the
    class of blind spot this whole change exists to close.
    """
    return main._synthetic_lease_records(swept, leases)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    main = _fresh_main(monkeypatch)
    main.known_cameras.clear()
    main.pending_cameras.clear()
    yield main
    main.known_cameras.clear()
    main.pending_cameras.clear()


def test_no_synthetic_for_an_already_adopted_camera(_clean):
    """The regression: lease gone, camera already known under its real MAC."""
    main = _clean
    main.known_cameras["e4:30:22:50:2a:fd"] = {
        "ip": "192.168.9.219",
        "name": "xnv_c8083r_e43022502afd",
        "status": "active",
    }

    # The sweep still sees the host; DHCP no longer reports it.
    synthetic = _sweep_synthetics(main, swept=["192.168.9.219"], leases=[])

    assert synthetic == [], (
        "minted a synthetic ip: key for a camera already adopted under a real "
        "MAC — this is what produced two rows for one physical camera"
    )


def test_no_synthetic_for_a_pending_camera(_clean):
    """A camera awaiting operator approval must not be duplicated either."""
    main = _clean
    main.pending_cameras["aa:bb:cc:dd:ee:ff"] = {
        "ip": "192.168.9.220",
        "name": "pending_cam",
        "status": "pending",
    }

    synthetic = _sweep_synthetics(main, swept=["192.168.9.220"], leases=[])
    assert synthetic == []


def test_still_adopts_a_genuinely_new_static_ip_camera(_clean):
    """The guard must not break the case the sweep exists for."""
    main = _clean
    main.known_cameras["e4:30:22:50:2a:fd"] = {"ip": "192.168.9.219", "name": "known"}

    synthetic = _sweep_synthetics(
        main, swept=["192.168.9.219", "192.168.9.240"], leases=[]
    )

    assert [s["ipaddr"] for s in synthetic] == ["192.168.9.240"]
    assert synthetic[0]["macaddr"] == "ip:192.168.9.240"


def test_dhcp_lease_still_wins_over_the_sweep(_clean):
    """Unchanged behaviour: a host with a lease is never synthesised."""
    main = _clean
    leases = [{"ipaddr": "192.168.9.219", "macaddr": "e4:30:22:50:2a:fd"}]

    synthetic = _sweep_synthetics(main, swept=["192.168.9.219"], leases=leases)
    assert synthetic == []


def test_reconciler_still_upgrades_a_synthetic_key(_clean):
    """The original direction (synthetic → real MAC) must keep working."""
    main = _clean
    main.known_cameras["ip:192.168.9.230"] = {
        "ip": "192.168.9.230",
        "mac": "ip:192.168.9.230",
        "name": "camera_192_168_9_230",
    }

    main._reconcile_synthetic_macs(
        [{"ipaddr": "192.168.9.230", "macaddr": "AA:BB:CC:11:22:33"}]
    )

    assert "ip:192.168.9.230" not in main.known_cameras
    assert "aa:bb:cc:11:22:33" in main.known_cameras
    assert main.known_cameras["aa:bb:cc:11:22:33"]["ip"] == "192.168.9.230"


def test_reconciler_drops_a_synthetic_duplicate_of_a_real_mac(_clean):
    """If both keys already exist, the synthetic one is dropped, not merged."""
    main = _clean
    main.known_cameras["aa:bb:cc:11:22:33"] = {
        "ip": "192.168.9.230",
        "name": "real",
    }
    main.known_cameras["ip:192.168.9.230"] = {
        "ip": "192.168.9.230",
        "mac": "ip:192.168.9.230",
        "name": "dupe",
    }

    main._reconcile_synthetic_macs(
        [{"ipaddr": "192.168.9.230", "macaddr": "AA:BB:CC:11:22:33"}]
    )

    assert "ip:192.168.9.230" not in main.known_cameras
    assert main.known_cameras["aa:bb:cc:11:22:33"]["name"] == "real"
