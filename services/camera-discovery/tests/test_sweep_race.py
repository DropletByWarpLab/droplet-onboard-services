"""WARP-3508 (F5) — a sweep must not write over a decision made while it was probing.

``scan_and_discover`` awaits for seconds per candidate (ONVIF, the RTSP probe, the
credential ladder, Frigate). The state it writes afterwards — ``pending_cameras[mac]
= ...; known_cameras.pop(mac)`` — was computed BEFORE those awaits. If an operator
accepts the camera in that window, the sweep resumes and undoes the accept: the
camera is pushed back to ``pending`` as "needs credentials" and dropped from
``known_cameras`` while it is already live in Frigate. Reproduced deterministically
by QA of the credentials work (WARP-3505).

The same window has three siblings, all fixed by one rule — before writing, re-check
whether anything decided this camera while we were away (``_already_decided``):

* a REJECT lands mid-probe: the sweep re-added it to pending and re-published it, so
  the dismissed camera reappeared (and the orchestrator re-created its DB row);
* a camera is ADDED BY HAND mid-probe (its IP becomes a managed host);
* two sweeps overlap (the scheduled one and an operator-triggered /scan), so one
  adds a camera to Frigate that the other already added.

And the sweep's own add to Frigate takes the same in-flight claim ``accept_camera``
takes (PYNET-017), or a reject during that add could leave a camera both live and
dismissed.

Every test holds a probe open with explicit events — no sleeps, no timing.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

MAC_A, IP_A = "aa:bb:cc:dd:ee:01", "192.168.100.50"
MAC_B, IP_B = "aa:bb:cc:dd:ee:02", "192.168.100.51"
SECRET = "pytest-fake-secret"
WAIT = 3.0  # seconds; only ever a hang guard, never the thing being tested


class _FakeRequest:
    def __init__(self, token: str = SECRET):
        self.headers = {"Authorization": f"Bearer {token}"}


def _main():
    """The service module with empty in-memory state (no reload — it rebuilds two
    HTTP clients, which costs seconds on Windows)."""
    import main

    for state in (
        main.known_cameras,
        main.pending_cameras,
        main.rejected_macs,
        main.accepting_macs,
        main.managed_ips,
    ):
        state.clear()
    return main


def _lease(mac: str, ip: str, hostname: str = "xnv-c8083r") -> dict:
    return {"ipaddr": ip, "macaddr": mac, "hostname": hostname, "source": "dhcp"}


def _pending(main, mac: str, ip: str) -> None:
    """What an earlier sweep left behind: a needs_setup record the operator can act on."""
    main.pending_cameras[mac] = {
        "mac": mac,
        "ip": ip,
        "name": f"cam_{ip.replace('.', '_')}",
        "rtsp_url": f"rtsp://{ip}:554/stream1",
        "status": "needs_setup",
        "detection_method": "rtsp_port_open",
    }


class _World:
    """One sweep's collaborators, with the first ONVIF probe (and optionally the
    sweep's own Frigate add) held open so the world can change under it."""

    def __init__(
        self,
        monkeypatch,
        main,
        leases,
        *,
        detection_method: str = "rtsp_port_open",
        is_camera_hostname: bool = True,
        hold_onvif: bool = True,
        hold_add: bool = False,
        probe_finds_camera: bool = True,
    ):
        self.main = main
        self.hold_add = hold_add
        self.hold_onvif = hold_onvif
        self.onvif_probed: list[str] = []
        self.camera_probed: list[str] = []
        self.adds: list[str] = []
        self.published: list[dict] = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.entered_add = asyncio.Event()
        self.release_add = asyncio.Event()

        async def fake_leases():
            return list(leases)

        async def fake_ws_discovery():
            return []

        async def fake_onvif(ip):
            self.onvif_probed.append(ip)
            if self.hold_onvif and not self.entered.is_set():
                self.entered.set()
                await self.release.wait()
            return None

        async def fake_probe_camera(ip):
            self.camera_probed.append(ip)
            if not probe_finds_camera:
                return None
            url = (
                f"rtsp://admin:pw@{ip}:554/stream1"
                if detection_method == "rtsp_default_credentials"
                else f"rtsp://{ip}:554/stream1"
            )
            return {"ip": ip, "port": 554, "rtsp_url": url, "detection_method": detection_method}

        async def fake_verify(url, timeout=4.0):
            return True

        async def fake_add(name, url):
            self.adds.append(name)
            if self.hold_add:
                self.entered_add.set()
                await self.release_add.wait()
            return True

        monkeypatch.setattr(main, "fetch_dhcp_leases", fake_leases)
        monkeypatch.setattr(main, "discover_cameras", fake_ws_discovery)
        monkeypatch.setattr(main, "probe_onvif_device", fake_onvif)
        monkeypatch.setattr(main, "probe_camera", fake_probe_camera)
        monkeypatch.setattr(main, "verify_stream", fake_verify)
        monkeypatch.setattr(main.frigate, "add_camera", fake_add)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main, "_is_camera_hostname", lambda hostname: is_camera_hostname)
        monkeypatch.setattr(main, "publish_discovery", lambda event: self.published.append(event))

    def start_sweep(self) -> asyncio.Task:
        return asyncio.create_task(self.main.scan_and_discover())

    async def until_probing(self) -> None:
        await asyncio.wait_for(self.entered.wait(), WAIT)

    async def finish(self, sweep: asyncio.Task) -> None:
        self.release.set()
        await asyncio.wait_for(sweep, WAIT)

    def events(self, name: str) -> list[dict]:
        return [e for e in self.published if e.get("event") == name]


class TestAnAcceptThatLandsMidProbe:
    @pytest.mark.asyncio
    async def test_is_not_undone_by_the_sweep(self, monkeypatch):
        """The F5 repro. Without the re-check the sweep resumes, writes the stale
        needs_setup record back into pending and pops the camera from known."""
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)])
        _pending(main, MAC_A, IP_A)

        sweep = world.start_sweep()
        await world.until_probing()
        accepted = await main.accept_camera(MAC_A, _FakeRequest())  # lands mid-probe
        assert accepted["status"] == "accepted"
        await world.finish(sweep)

        assert MAC_A in main.known_cameras, "the sweep un-knew a camera that is live in Frigate"
        assert main.known_cameras[MAC_A]["status"] == "active"
        assert MAC_A not in main.pending_cameras, "the camera reappeared as needs-credentials"
        assert world.events("camera_discovered") == [], "the sweep re-announced a camera that was just accepted"

    @pytest.mark.asyncio
    async def test_the_not_a_camera_path_does_not_unknow_it_either(self, monkeypatch):
        """The sweep's other write: a device that turns out not to be a camera has its
        pending AND known entries dropped. An accept that landed mid-probe must survive that."""
        main = _main()
        world = _World(
            monkeypatch, main, [_lease(MAC_A, IP_A, hostname="laptop")],
            is_camera_hostname=False, probe_finds_camera=False,
        )
        _pending(main, MAC_A, IP_A)

        sweep = world.start_sweep()
        await world.until_probing()
        await main.accept_camera(MAC_A, _FakeRequest())
        await world.finish(sweep)

        assert MAC_A in main.known_cameras

    @pytest.mark.asyncio
    async def test_a_verified_camera_is_not_added_to_frigate_a_second_time(self, monkeypatch):
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)], detection_method="rtsp_default_credentials")
        _pending(main, MAC_A, IP_A)

        sweep = world.start_sweep()
        await world.until_probing()
        await main.accept_camera(MAC_A, _FakeRequest())
        await world.finish(sweep)

        assert len(world.adds) == 1, "Frigate was told to add the same camera twice (two restarts)"
        assert MAC_A in main.known_cameras


class TestARejectThatLandsMidProbe:
    @pytest.mark.asyncio
    async def test_is_not_undone_by_the_sweep(self, monkeypatch):
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)])
        _pending(main, MAC_A, IP_A)

        sweep = world.start_sweep()
        await world.until_probing()
        await main.reject_camera(MAC_A, _FakeRequest())
        await world.finish(sweep)

        assert MAC_A in main.rejected_macs
        assert MAC_A not in main.pending_cameras, "the sweep resurrected a camera the operator just dismissed"
        # Publishing is what makes the orchestrator re-create the DB row the reject deleted.
        assert world.events("camera_discovered") == []

    @pytest.mark.asyncio
    async def test_a_camera_rejected_mid_probe_is_never_added_to_frigate(self, monkeypatch):
        """The invariant PYNET-017 protects for accept — a MAC is never both live and
        dismissed — has to hold for the sweep's auto-add too."""
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)], detection_method="rtsp_default_credentials")
        _pending(main, MAC_A, IP_A)

        sweep = world.start_sweep()
        await world.until_probing()
        await main.reject_camera(MAC_A, _FakeRequest())
        await world.finish(sweep)

        assert world.adds == []
        assert MAC_A not in main.known_cameras


class TestACameraAddedByHandMidProbe:
    @pytest.mark.asyncio
    async def test_is_not_surfaced_by_the_sweep(self, monkeypatch):
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)])

        sweep = world.start_sweep()
        await world.until_probing()
        main.managed_ips.add(IP_A)  # what a refresh does once Frigate has the camera
        await world.finish(sweep)

        assert main.pending_cameras == {}
        assert world.published == []
        assert world.adds == []


class TestTheSweepsOwnAddHoldsTheClaim:
    @pytest.mark.asyncio
    async def test_a_reject_during_the_sweeps_add_is_refused(self, monkeypatch):
        """PYNET-017 for the sweep: while it is committing a camera to Frigate the MAC is
        claimed, so a concurrent reject gets a 409 instead of leaving it live AND dismissed."""
        main = _main()
        world = _World(
            monkeypatch, main, [_lease(MAC_A, IP_A)],
            detection_method="rtsp_default_credentials", hold_onvif=False, hold_add=True,
        )

        sweep = world.start_sweep()
        await asyncio.wait_for(world.entered_add.wait(), WAIT)

        assert MAC_A in main.accepting_macs
        with pytest.raises(HTTPException) as excinfo:
            await main.reject_camera(MAC_A, _FakeRequest())
        assert excinfo.value.status_code == 409
        assert MAC_A not in main.rejected_macs

        world.release_add.set()
        await asyncio.wait_for(sweep, WAIT)

        assert MAC_A in main.known_cameras
        assert MAC_A not in main.rejected_macs
        assert main.accepting_macs == set(), "the sweep left its claim behind"

    @pytest.mark.asyncio
    async def test_the_claim_is_released_when_frigate_refuses(self, monkeypatch):
        main = _main()
        _World(  # wires the sweep's collaborators; the add is replaced just below
            monkeypatch, main, [_lease(MAC_A, IP_A)],
            detection_method="rtsp_default_credentials", hold_onvif=False,
        )

        async def refusing_add(name, url):
            raise RuntimeError("Frigate 502 Bad Gateway")

        monkeypatch.setattr(main.frigate, "add_camera", refusing_add)

        await main.scan_and_discover()

        assert main.accepting_macs == set()
        assert MAC_A not in main.known_cameras
        assert MAC_A in main.pending_cameras  # still re-probeable, as before


class TestOverlappingSweeps:
    @pytest.mark.asyncio
    async def test_one_camera_is_added_once(self, monkeypatch):
        """The scheduled sweep and an operator-triggered /scan can overlap (the
        scheduler's max_instances only stops the scheduled job overlapping ITSELF)."""
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)], detection_method="rtsp_default_credentials")

        first = world.start_sweep()
        await world.until_probing()  # first sweep is parked in its ONVIF probe
        await main.scan_and_discover()  # the second sweep runs to completion meanwhile
        assert world.adds == [main.known_cameras[MAC_A]["name"]]
        await world.finish(first)

        assert len(world.adds) == 1, "the overlapping sweep added the camera to Frigate again"
        assert len(world.events("camera_discovered")) == 1


class TestACandidateDecidedBeforeItsTurn:
    @pytest.mark.asyncio
    async def test_is_not_probed_at_all(self, monkeypatch):
        """Two candidates in one sweep; B is accepted while A is being probed. B must not
        then be probed — that is an ONVIF login and a credential ladder against a camera
        that is already live."""
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A), _lease(MAC_B, IP_B)])
        _pending(main, MAC_B, IP_B)

        sweep = world.start_sweep()
        await world.until_probing()  # parked on A
        await main.accept_camera(MAC_B, _FakeRequest())
        await world.finish(sweep)

        assert world.onvif_probed == [IP_A]
        assert world.camera_probed == [IP_A]
        assert MAC_B in main.known_cameras


class TestNothingDecidedChangesNothing:
    @pytest.mark.asyncio
    async def test_an_undisturbed_sweep_still_writes_and_publishes(self, monkeypatch):
        """Control: the guard must not swallow ordinary results."""
        main = _main()
        world = _World(monkeypatch, main, [_lease(MAC_A, IP_A)], hold_onvif=False)

        await main.scan_and_discover()

        assert set(main.pending_cameras) == {MAC_A}
        assert main.pending_cameras[MAC_A]["status"] == "needs_setup"
        assert len(world.events("camera_discovered")) == 1
