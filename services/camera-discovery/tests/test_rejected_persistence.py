"""WARP-3508 — a dismissed camera stays dismissed across a restart.

``rejected_macs`` was a bare in-memory set, so every container restart — and every
update, which recreates the container — resurrected each camera the operator had
dismissed as a brand-new "Needs sign-in" card.

The list is now written to a small JSON file under ``CAMERA_DISCOVERY_STATE_DIR``
(a named volume in compose) and read back at startup. ``known_cameras`` is
deliberately NOT persisted: its records embed ``user:pass@`` stream URLs, so it
would put camera credentials in a file, and a restart re-derives what Frigate
already manages from Frigate itself (see test_managed_hosts.py).

The conftest gives every test its own state dir.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

SECRET = "pytest-fake-secret"
MAC = "e4:30:22:50:2a:fd"


class _FakeRequest:
    def __init__(self, token: str = SECRET):
        self.headers = {"Authorization": f"Bearer {token}"}


def _fresh_main():
    """The service module with empty in-memory state — what a restart gives.

    Not ``importlib.reload``: that rebuilds two HTTP clients (seconds on Windows)
    and these tests "restart" a lot. A restart loses exactly the module's state
    and keeps the state volume, which is what this reproduces.
    """
    import main

    for state in (main.known_cameras, main.pending_cameras, main.rejected_macs, main.accepting_macs):
        state.clear()
    return main


def _state_file() -> Path:
    return Path(os.environ["CAMERA_DISCOVERY_STATE_DIR"]) / "rejected-macs.json"


def _seed_pending(main, mac: str = MAC) -> None:
    main.known_cameras.clear()
    main.pending_cameras.clear()
    main.rejected_macs.clear()
    main.pending_cameras[mac] = {
        "mac": mac,
        "ip": "192.168.100.50",
        "rtsp_url": "rtsp://192.168.100.50:554/stream1",
        "name": "cam",
        "status": "needs_setup",
    }


class TestRejectWritesTheList:
    @pytest.mark.asyncio
    async def test_reject_persists_the_mac(self):
        main = _fresh_main()
        _seed_pending(main)

        result = await main.reject_camera(MAC, _FakeRequest())

        assert result["status"] == "rejected"
        assert result["persisted"] is True
        assert json.loads(_state_file().read_text(encoding="utf-8")) == {"rejected_macs": [MAC]}

    @pytest.mark.asyncio
    async def test_every_rejection_is_kept_not_just_the_last(self):
        main = _fresh_main()
        _seed_pending(main, "aa:bb:cc:dd:ee:01")
        main.pending_cameras["aa:bb:cc:dd:ee:02"] = {"ip": "192.168.100.51", "name": "b"}

        await main.reject_camera("aa:bb:cc:dd:ee:01", _FakeRequest())
        await main.reject_camera("aa:bb:cc:dd:ee:02", _FakeRequest())

        saved = json.loads(_state_file().read_text(encoding="utf-8"))["rejected_macs"]
        assert saved == ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"]

    @pytest.mark.asyncio
    async def test_a_refused_rejection_writes_nothing(self):
        """The cap is full (PYNET-015): the camera stays pending and nothing is
        saved — the file must not claim a rejection the service refused."""
        main = _fresh_main()
        _seed_pending(main)
        main.rejected_macs.update(f"aa:bb:cc:00:{i // 256:02x}:{i % 256:02x}" for i in range(main.MAX_REJECTED_MACS))

        with pytest.raises(HTTPException) as excinfo:
            await main.reject_camera(MAC, _FakeRequest())

        assert excinfo.value.status_code == 507
        assert not _state_file().exists()
        assert MAC in main.pending_cameras


class TestSurvivesARestart:
    @pytest.mark.asyncio
    async def test_the_saved_list_comes_back(self):
        main = _fresh_main()
        _seed_pending(main)
        await main.reject_camera(MAC, _FakeRequest())

        # A restart: a new process, empty memory, same volume.
        main = _fresh_main()
        assert main.rejected_macs == set()
        main._load_rejected_macs()

        assert main.rejected_macs == {MAC}

    @pytest.mark.asyncio
    async def test_a_rejected_camera_is_not_rediscovered_after_a_restart(self, monkeypatch):
        main = _fresh_main()
        _seed_pending(main)
        await main.reject_camera(MAC, _FakeRequest())

        main = _fresh_main()
        main._load_rejected_macs()

        probed: list[str] = []

        async def leases():
            # The lease table spells the MAC however the router does.
            return [{"ipaddr": "192.168.100.50", "macaddr": MAC.upper(), "hostname": "cam", "source": "dhcp"}]

        async def no_onvif_scan():
            return []

        async def no_onvif(ip):
            probed.append(ip)

        async def probe(ip):
            probed.append(ip)
            return {"ip": ip, "port": 554, "rtsp_url": f"rtsp://{ip}:554/stream1", "detection_method": "rtsp_port_open"}

        monkeypatch.setattr(main, "fetch_dhcp_leases", leases)
        monkeypatch.setattr(main, "discover_cameras", no_onvif_scan)
        monkeypatch.setattr(main, "probe_onvif_device", no_onvif)
        monkeypatch.setattr(main, "probe_camera", probe)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)
        main.known_cameras.clear()
        main.pending_cameras.clear()

        await main.scan_and_discover()

        assert probed == [], "a dismissed camera was probed again after a restart"
        assert main.pending_cameras == {}

    @pytest.mark.asyncio
    async def test_startup_restores_the_list(self, monkeypatch):
        """The loader existing but never being called would ship the bug anyway —
        pin the startup hook (same shape as test_birdseye_convergence)."""
        main = _fresh_main()
        state = _state_file()
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"rejected_macs": [MAC]}), encoding="utf-8")

        class _SchedulerStub:
            def start(self) -> None:
                pass

        async def healthy() -> bool:
            return True

        async def nothing() -> None:
            return None

        async def converged() -> bool:
            return False

        monkeypatch.setattr(main, "mqtt_client", None)
        monkeypatch.setattr(main, "_scan_scheduler", None)
        monkeypatch.setattr(main, "_connect_mqtt", lambda: None)
        monkeypatch.setattr(main.frigate, "health_check", healthy)
        monkeypatch.setattr(main, "_reconcile_with_frigate", nothing)
        monkeypatch.setattr(main.frigate, "ensure_birdseye", converged)
        monkeypatch.setattr(main, "build_scan_scheduler", lambda: _SchedulerStub())

        await main.startup()

        assert main.rejected_macs == {MAC}


class TestLoadIsTolerant:
    """A bad file must never keep the service from starting."""

    def test_no_file_is_an_empty_list(self):
        main = _fresh_main()
        main._load_rejected_macs()
        assert main.rejected_macs == set()

    @pytest.mark.parametrize(
        "content",
        [
            "{ not json",
            "",
            json.dumps(["e4:30:22:50:2a:fd"]),  # right data, wrong shape
            json.dumps({"rejected_macs": "e4:30:22:50:2a:fd"}),
            json.dumps({"something_else": []}),
            json.dumps(None),
        ],
    )
    def test_an_unreadable_file_is_ignored(self, content):
        main = _fresh_main()
        _state_file().parent.mkdir(parents=True)
        _state_file().write_text(content, encoding="utf-8")

        main._load_rejected_macs()

        assert main.rejected_macs == set()

    def test_entries_that_are_not_keys_are_dropped(self):
        main = _fresh_main()
        _state_file().parent.mkdir(parents=True)
        _state_file().write_text(
            json.dumps(
                {
                    "rejected_macs": [
                        MAC,
                        "E4:30:22:50:2A:AA",  # a hand edit in upper case is still honoured
                        "ip:192.168.9.77",
                        42,
                        None,
                        "../../etc/passwd",
                        "",
                    ]
                }
            ),
            encoding="utf-8",
        )

        main._load_rejected_macs()

        assert main.rejected_macs == {MAC, "e4:30:22:50:2a:aa", "ip:192.168.9.77"}

    def test_the_cap_still_holds_when_loading(self):
        main = _fresh_main()
        entries = [f"aa:bb:cc:00:{i // 256:02x}:{i % 256:02x}" for i in range(main.MAX_REJECTED_MACS + 25)]
        _state_file().parent.mkdir(parents=True)
        _state_file().write_text(json.dumps({"rejected_macs": entries}), encoding="utf-8")

        main._load_rejected_macs()

        assert len(main.rejected_macs) == main.MAX_REJECTED_MACS


class TestWriteIsSafe:
    @pytest.mark.asyncio
    async def test_the_write_is_atomic_tmp_then_rename_in_the_same_directory(self, monkeypatch):
        main = _fresh_main()
        _seed_pending(main)
        renames: list[tuple[Path, Path]] = []
        real_replace = os.replace

        def spying_replace(src, dst):
            renames.append((Path(src), Path(dst)))
            # At the moment of the rename the destination is either absent or whole —
            # the tmp file is where the new content lives.
            assert json.loads(Path(src).read_text(encoding="utf-8")) == {"rejected_macs": [MAC]}
            return real_replace(src, dst)

        monkeypatch.setattr(main.os, "replace", spying_replace)

        await main.reject_camera(MAC, _FakeRequest())

        assert len(renames) == 1
        src, dst = renames[0]
        assert dst == _state_file()
        assert src != dst
        assert src.parent == dst.parent  # same filesystem, so the rename is atomic
        assert not src.exists()  # nothing left behind

    @pytest.mark.asyncio
    async def test_a_failed_write_leaves_the_previous_file_intact(self, monkeypatch):
        main = _fresh_main()
        _seed_pending(main)
        _state_file().parent.mkdir(parents=True)
        previous = json.dumps({"rejected_macs": ["aa:bb:cc:dd:ee:99"]})
        _state_file().write_text(previous, encoding="utf-8")

        def failing_replace(src, dst):
            raise OSError("disk went away")

        monkeypatch.setattr(main.os, "replace", failing_replace)

        result = await main.reject_camera(MAC, _FakeRequest())

        assert result["persisted"] is False
        assert _state_file().read_text(encoding="utf-8") == previous
        leftovers = [p.name for p in _state_file().parent.iterdir() if p.name != _state_file().name]
        assert leftovers == [], "a failed write left a temp file behind"

    @pytest.mark.asyncio
    async def test_an_unwritable_state_dir_does_not_break_rejecting(self, monkeypatch, tmp_path):
        """Persisting is best-effort (same contract as switch/provision_state.py):
        the rejection still holds for this run, the failure is loud in the log and
        visible to the caller, and the operator is not blocked from dismissing."""
        blocker = tmp_path / "a-file-not-a-directory"
        blocker.write_text("x", encoding="utf-8")
        monkeypatch.setenv("CAMERA_DISCOVERY_STATE_DIR", str(blocker / "state"))
        main = _fresh_main()
        _seed_pending(main)

        result = await main.reject_camera(MAC, _FakeRequest())

        assert result["status"] == "rejected"
        assert result["persisted"] is False
        assert main.rejected_macs == {MAC}
        assert MAC not in main.pending_cameras

    @pytest.mark.asyncio
    async def test_no_state_file_is_written_for_a_known_camera_list(self):
        """known_cameras records embed user:pass@ stream URLs — they must not reach disk."""
        main = _fresh_main()
        _seed_pending(main)
        main.known_cameras["aa:bb:cc:dd:ee:77"] = {
            "ip": "192.168.100.77",
            "rtsp_url": "rtsp://admin:hunter2@192.168.100.77:554/stream1",
        }

        await main.reject_camera(MAC, _FakeRequest())

        written = "".join(p.read_text(encoding="utf-8") for p in _state_file().parent.iterdir())
        assert "hunter2" not in written
        assert "rtsp" not in written
