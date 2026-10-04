"""WARP-3508 — discovery must leave alone a camera Frigate already has.

Live repro: 192.168.9.219 was added by hand, so Frigate pulls from it and the
orchestrator has a Camera row for it. Camera-discovery never saw that add, so it
kept the device in ``pending_cameras`` as ``needs_setup`` — and every 30 s sweep
re-probed it: ONVIF as admin/blank, then the whole default-credential ladder.
Hanwha cameras lock the admin account after ~5 failed logins (HTTP 490), so a
camera the operator had ALREADY set up was being hammered into lockout by the
very service that was supposed to help adopt it.

The fix: Frigate is the source of truth for "this host is a camera". Every
``cameras.<name>.ffmpeg.inputs[].path`` host is a *managed* IP; the sweep skips
managed IPs entirely (no probe, no credentials, no publish), and the picture is
refreshed at startup, before an operator-triggered /scan, and every
``RECONCILE_EVERY_SWEEPS`` scheduled sweeps.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

import rtsp_prober
from frigate_client import FrigateClient, camera_input_hosts

MANAGED_IP = "192.168.100.50"
OTHER_IP = "192.168.100.51"


def _config(*paths: str) -> dict:
    return {
        "cameras": {
            f"cam_{i}": {"ffmpeg": {"inputs": [{"path": path, "roles": ["detect", "record"]}]}}
            for i, path in enumerate(paths)
        }
    }


def _main():
    """The service module with empty in-memory state (no reload — it rebuilds two
    HTTP clients, which costs seconds on Windows)."""
    import main

    for state in (main.known_cameras, main.pending_cameras, main.rejected_macs, main.accepting_macs, main.managed_ips):
        state.clear()
    return main


class _FakeRequest:
    headers = {"Authorization": "Bearer pytest-fake-secret"}


# --- Reading Frigate's config -------------------------------------------------


class TestCameraInputHosts:
    def test_collects_the_host_of_every_input(self):
        hosts = camera_input_hosts(
            _config(
                "rtsp://admin:T3stCamPw%21@192.168.9.219:554/profile2/media.smp",
                "rtsp://192.168.9.50/stream1",
                "rtsps://10.0.0.7:322/live",
                "http://192.168.9.60:8080/video",
            )
        )
        assert hosts == {"192.168.9.219", "192.168.9.50", "10.0.0.7", "192.168.9.60"}

    def test_reads_every_input_of_a_camera_with_several(self):
        hosts = camera_input_hosts(
            {
                "cameras": {
                    "patio": {
                        "ffmpeg": {
                            "inputs": [
                                {"path": "rtsp://192.168.9.60/main"},
                                {"path": "rtsp://192.168.9.60/sub"},
                                {"path": "rtsp://192.168.9.61/main"},
                            ]
                        }
                    }
                }
            }
        )
        assert hosts == {"192.168.9.60", "192.168.9.61"}

    def test_copes_with_an_unencoded_at_sign_and_an_unexpanded_placeholder(self):
        assert camera_input_hosts(_config("rtsp://admin:p@ss@192.168.9.219/s")) == {"192.168.9.219"}
        assert camera_input_hosts(_config("rtsp://admin:{FRIGATE_RTSP_PASSWORD}@192.168.9.219/s")) == {
            "192.168.9.219"
        }

    def test_only_ip_addresses_count(self):
        # A host name can never equal a candidate's IP; keeping it would only be noise.
        assert camera_input_hosts(_config("rtsp://cam.local/stream", "rtsp://frigate-cam:554/x")) == set()

    def test_skips_anything_that_is_not_a_url_with_a_host_and_never_raises(self):
        assert camera_input_hosts(_config("/dev/video0", "ffmpeg:rtsp://10.0.0.5/s#video=copy", "rtsp://[::1/x")) == set()
        for odd in (None, {}, {"cameras": None}, {"cameras": {"a": None}}, {"cameras": {"a": {}}}):
            assert camera_input_hosts(odd) == set()
        assert camera_input_hosts({"cameras": {"a": {"ffmpeg": {"inputs": "x"}}}}) == set()
        assert camera_input_hosts({"cameras": {"a": {"ffmpeg": {"inputs": [None, {}, {"path": 7}]}}}}) == set()

    @pytest.mark.asyncio
    async def test_the_client_reads_the_running_config(self):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            return httpx.Response(200, json=_config("rtsp://192.168.9.219/s"))

        client = FrigateClient("http://frigate:5000")
        client._client = httpx.AsyncClient(
            base_url="http://frigate:5000", transport=httpx.MockTransport(handler)
        )
        try:
            assert await client.get_camera_input_hosts() == {"192.168.9.219"}
        finally:
            await client.close()
        assert seen == ["/api/config"]


# --- Keeping discovery's picture of Frigate current --------------------------


class TestRefreshManagedIps:
    @pytest.mark.asyncio
    async def test_the_managed_set_is_the_hosts_frigate_pulls_from(self, monkeypatch):
        main = _main()

        async def config():
            return _config(f"rtsp://admin:pw@{MANAGED_IP}:554/stream1")

        monkeypatch.setattr(main.frigate, "get_config", config)

        await main._refresh_managed_ips()

        assert main.managed_ips == {MANAGED_IP}

    @pytest.mark.asyncio
    async def test_a_camera_removed_from_frigate_becomes_discoverable_again(self, monkeypatch):
        main = _main()
        main.managed_ips.add(MANAGED_IP)

        async def config():
            return _config(f"rtsp://{OTHER_IP}/stream1")

        monkeypatch.setattr(main.frigate, "get_config", config)

        await main._refresh_managed_ips()

        assert main.managed_ips == {OTHER_IP}

    @pytest.mark.asyncio
    async def test_a_pending_record_on_a_managed_ip_is_dropped(self, monkeypatch):
        """The stale "Needs sign-in" record: nothing would ever clear it, since the
        sweep no longer probes (and so never re-publishes) a managed IP."""
        main = _main()
        main.pending_cameras["aa:bb:cc:dd:ee:01"] = {"ip": MANAGED_IP, "status": "needs_setup"}
        main.pending_cameras["aa:bb:cc:dd:ee:02"] = {"ip": OTHER_IP, "status": "needs_setup"}

        async def config():
            return _config(f"rtsp://{MANAGED_IP}/stream1")

        monkeypatch.setattr(main.frigate, "get_config", config)

        await main._refresh_managed_ips()

        assert set(main.pending_cameras) == {"aa:bb:cc:dd:ee:02"}

    @pytest.mark.asyncio
    async def test_a_failed_read_changes_nothing_and_never_raises(self, monkeypatch):
        main = _main()
        main.managed_ips.add(MANAGED_IP)
        main.pending_cameras["aa:bb:cc:dd:ee:02"] = {"ip": OTHER_IP}

        async def down():
            raise httpx.ConnectError("frigate is restarting")

        monkeypatch.setattr(main.frigate, "get_config", down)

        await main._refresh_managed_ips()  # must not raise

        # Frigate being briefly down must not make a managed camera discoverable again.
        assert main.managed_ips == {MANAGED_IP}
        assert set(main.pending_cameras) == {"aa:bb:cc:dd:ee:02"}


class TestReconcileWithFrigate:
    @pytest.mark.asyncio
    async def test_it_still_drops_known_cameras_frigate_no_longer_has(self, monkeypatch):
        main = _main()
        main.known_cameras["aa:bb:cc:dd:ee:01"] = {"name": "gone", "ip": "192.168.100.60"}
        main.known_cameras["aa:bb:cc:dd:ee:02"] = {"name": "kept", "ip": "192.168.100.61"}

        async def stats():
            return {"kept": {"camera_fps": 5}}

        async def config():
            return _config("rtsp://192.168.100.61/s")

        monkeypatch.setattr(main.frigate, "get_cameras", stats)
        monkeypatch.setattr(main.frigate, "get_config", config)

        await main._reconcile_with_frigate()

        assert set(main.known_cameras) == {"aa:bb:cc:dd:ee:02"}
        assert main.managed_ips == {"192.168.100.61"}

    @pytest.mark.asyncio
    async def test_the_two_halves_fail_independently(self, monkeypatch):
        main = _main()
        main.known_cameras["aa:bb:cc:dd:ee:01"] = {"name": "gone", "ip": "192.168.100.60"}

        async def stats_down():
            raise httpx.ConnectError("stats down")

        async def config():
            return _config(f"rtsp://{MANAGED_IP}/s")

        monkeypatch.setattr(main.frigate, "get_cameras", stats_down)
        monkeypatch.setattr(main.frigate, "get_config", config)
        await main._reconcile_with_frigate()
        assert main.managed_ips == {MANAGED_IP}  # config half still ran
        assert "aa:bb:cc:dd:ee:01" in main.known_cameras  # stats half did not guess

        async def stats():
            return {}

        async def config_down():
            raise httpx.ConnectError("config down")

        monkeypatch.setattr(main.frigate, "get_cameras", stats)
        monkeypatch.setattr(main.frigate, "get_config", config_down)
        await main._reconcile_with_frigate()
        assert main.managed_ips == {MANAGED_IP}  # unchanged, not cleared
        assert main.known_cameras == {}  # stats half still ran


# --- The sweep ----------------------------------------------------------------


class _Probes:
    """Spies for everything in a sweep that talks to a device."""

    def __init__(self):
        self.onvif: list[str] = []
        self.port_scans: list[str] = []
        self.ladder: list[str] = []
        self.published: list[dict] = []


def _stub_sweep(monkeypatch, main, *, leases, onvif_devices=()):
    probes = _Probes()

    async def fake_leases():
        return list(leases)

    async def fake_ws_discovery():
        return list(onvif_devices)

    async def fake_onvif(ip):
        probes.onvif.append(ip)

    async def fake_scan_ports(ip, ports=None, timeout=2.0):
        probes.port_scans.append(ip)
        return []

    async def fake_ladder(ip, port):
        probes.ladder.append(ip)

    async def fake_verify(url, timeout=4.0):
        return False  # nothing in these tests may open a real socket

    monkeypatch.setattr(main, "verify_stream", fake_verify)
    monkeypatch.setattr(main, "fetch_dhcp_leases", fake_leases)
    monkeypatch.setattr(main, "discover_cameras", fake_ws_discovery)
    monkeypatch.setattr(main, "probe_onvif_device", fake_onvif)
    # probe_camera stays REAL: the point is that it is never reached for a managed IP.
    monkeypatch.setattr(rtsp_prober, "scan_ports", fake_scan_ports)
    monkeypatch.setattr(rtsp_prober, "probe_rtsp_with_credentials", fake_ladder)
    monkeypatch.setattr(main, "_camera_network", None)
    monkeypatch.setattr(main, "_is_camera_hostname", lambda hostname: True)
    monkeypatch.setattr(main, "publish_discovery", lambda event: probes.published.append(event))
    return probes


def _lease(ip: str, mac: str) -> dict:
    return {"ipaddr": ip, "macaddr": mac, "hostname": "xnv-c8083r", "source": "dhcp"}


class TestSweepSkipsManagedIps:
    @pytest.mark.asyncio
    async def test_a_managed_ip_is_not_probed_not_logged_into_and_not_published(self, monkeypatch):
        main = _main()
        main.managed_ips.add(MANAGED_IP)
        probes = _stub_sweep(monkeypatch, main, leases=[_lease(MANAGED_IP, "aa:bb:cc:dd:ee:01")])

        await main.scan_and_discover()

        assert probes.onvif == [], "ONVIF admin/blank login attempted on a camera Frigate already has"
        assert probes.port_scans == []
        assert probes.ladder == [], "default-credential ladder ran against a managed camera"
        assert probes.published == []
        assert main.pending_cameras == {}

    @pytest.mark.asyncio
    async def test_an_unmanaged_ip_is_still_probed_and_surfaced(self, monkeypatch):
        main = _main()
        main.managed_ips.add(MANAGED_IP)
        probes = _stub_sweep(
            monkeypatch,
            main,
            leases=[_lease(MANAGED_IP, "aa:bb:cc:dd:ee:01"), _lease(OTHER_IP, "aa:bb:cc:dd:ee:02")],
        )

        await main.scan_and_discover()

        assert probes.onvif == [OTHER_IP]
        assert probes.port_scans == [OTHER_IP]
        assert set(main.pending_cameras) == {"aa:bb:cc:dd:ee:02"}

    @pytest.mark.asyncio
    async def test_a_managed_onvif_device_is_skipped_too(self, monkeypatch):
        main = _main()
        main.managed_ips.add(MANAGED_IP)
        probes = _stub_sweep(
            monkeypatch,
            main,
            leases=[],
            onvif_devices=[
                {
                    "ip": MANAGED_IP,
                    "manufacturer": "Hanwha",
                    "rtsp_url": f"rtsp://{MANAGED_IP}:554/profile2/media.smp",
                    "detection_method": "onvif",
                }
            ],
        )

        await main.scan_and_discover()

        assert probes.published == []
        assert main.pending_cameras == {}

    @pytest.mark.asyncio
    async def test_a_camera_removed_from_frigate_is_probed_again(self, monkeypatch):
        main = _main()
        probes = _stub_sweep(monkeypatch, main, leases=[_lease(MANAGED_IP, "aa:bb:cc:dd:ee:01")])

        await main.scan_and_discover()

        assert probes.port_scans == [MANAGED_IP]


# --- When the picture is refreshed -------------------------------------------


class TestWhenItIsRefreshed:
    @pytest.mark.asyncio
    async def test_an_operator_triggered_scan_reconciles_first(self, monkeypatch):
        """So the sweep the operator asked for already knows what Frigate has —
        the docstring has always promised a reconcile on /scan."""
        main = _main()
        calls: list[str] = []

        async def reconcile():
            calls.append("reconcile")

        async def scan():
            calls.append("scan")

        monkeypatch.setattr(main, "_reconcile_with_frigate", reconcile)
        monkeypatch.setattr(main, "scan_and_discover", scan)

        result = await main.trigger_scan(_FakeRequest())

        assert calls == ["reconcile", "scan"]
        assert result["status"] == "scan_complete"

    @pytest.mark.asyncio
    async def test_a_hung_frigate_cannot_stall_an_operator_triggered_scan(self, monkeypatch):
        """Frigate restarts after every adoption and can hold a connection open for the
        whole httpx timeout (15 s per request). The orchestrator gives the entire /scan
        call 30 s, so waiting on Frigate unbounded would turn "a camera was just added"
        into a "scan_unavailable" the operator reads as "discovery is not running"."""
        main = _main()
        assert main.RECONCILE_TIMEOUT_SECONDS <= 10  # leaves most of the 30 s for the scan itself
        monkeypatch.setattr(main, "RECONCILE_TIMEOUT_SECONDS", 0.05)
        scanned: list[str] = []

        async def never_answers():
            await asyncio.Event().wait()

        async def scan():
            scanned.append("scan")

        monkeypatch.setattr(main, "_reconcile_with_frigate", never_answers)
        monkeypatch.setattr(main, "scan_and_discover", scan)

        result = await asyncio.wait_for(main.trigger_scan(_FakeRequest()), timeout=3)

        assert scanned == ["scan"]
        assert result["status"] == "scan_complete"

    @pytest.mark.asyncio
    async def test_scheduled_sweeps_refresh_every_nth_sweep_before_scanning(self, monkeypatch):
        main = _main()
        monkeypatch.setattr(main, "_sweeps_since_refresh", 0)
        every = main.RECONCILE_EVERY_SWEEPS
        calls: list[str] = []

        async def refresh():
            calls.append("refresh")

        async def scan():
            calls.append("scan")

        monkeypatch.setattr(main, "_refresh_managed_ips", refresh)
        monkeypatch.setattr(main, "scan_and_discover", scan)

        for _ in range(every * 3):
            await main.run_scan()

        assert calls.count("refresh") == 3
        assert calls.count("scan") == every * 3
        # Each refresh lands on the Nth sweep and ahead of that sweep's own scan.
        refresh_positions = [i for i, call in enumerate(calls) if call == "refresh"]
        assert all(calls[i + 1] == "scan" for i in refresh_positions)
        assert calls[:every - 1] == ["scan"] * (every - 1)
        assert calls[every - 1] == "refresh"

    @pytest.mark.asyncio
    async def test_a_failing_refresh_does_not_cost_the_sweep(self, monkeypatch):
        main = _main()
        monkeypatch.setattr(main, "_sweeps_since_refresh", main.RECONCILE_EVERY_SWEEPS - 1)
        scanned: list[str] = []

        async def refresh():
            raise RuntimeError("unexpected")

        async def scan():
            scanned.append("scan")

        monkeypatch.setattr(main, "_refresh_managed_ips", refresh)
        monkeypatch.setattr(main, "scan_and_discover", scan)

        await main.run_scan()  # run_scan swallows scan errors; a refresh error must not skip the scan

        assert scanned == ["scan"]

    @pytest.mark.asyncio
    async def test_startup_reconciles_once_frigate_is_ready(self, monkeypatch):
        """The managed set exists before the first sweep runs."""
        main = _main()
        order: list[str] = []

        class _SchedulerStub:
            def start(self) -> None:
                order.append("scheduler")

        async def healthy() -> bool:
            return True

        async def reconcile() -> None:
            order.append("reconcile")

        async def converged() -> bool:
            return False

        monkeypatch.setattr(main, "mqtt_client", None)
        monkeypatch.setattr(main, "_scan_scheduler", None)
        monkeypatch.setattr(main, "_connect_mqtt", lambda: None)
        monkeypatch.setattr(main.frigate, "health_check", healthy)
        monkeypatch.setattr(main, "_reconcile_with_frigate", reconcile)
        monkeypatch.setattr(main.frigate, "ensure_birdseye", converged)
        monkeypatch.setattr(main, "build_scan_scheduler", lambda: _SchedulerStub())

        await main.startup()

        assert order == ["reconcile", "scheduler"]
