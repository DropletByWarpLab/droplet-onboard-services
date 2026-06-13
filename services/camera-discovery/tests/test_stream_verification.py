"""Stream-verification gate — a port-open guess must never go stagnant.

Regression coverage for the camera-discovery bug where an unverified
``rtsp_port_open`` placeholder (the prober's "ports open, no stream confirmed"
guess) was pushed straight into Frigate as ``status: active`` and cached in
``known_cameras``. That left Frigate pulling a dead URL at 0 fps AND made the
candidate loop skip the camera forever, so a camera that came good later was
never re-probed.

These tests pin the fix:
  * ``verify_stream`` only returns True on a real DESCRIBE → 200.
  * The scan loop keeps an unverified guess in ``pending_cameras`` (re-probeable
    every scan), never in ``known_cameras``, and never calls Frigate for it.
  * A verified stream is still auto-added to Frigate as before.
"""

from __future__ import annotations

import importlib

import pytest


def _fresh_main():
    import main

    return importlib.reload(main)


class TestVerifyStream:
    @pytest.mark.asyncio
    async def test_rejects_non_rtsp_and_empty(self):
        import rtsp_prober

        assert await rtsp_prober.verify_stream("http://192.168.1.10/stream") is False
        assert await rtsp_prober.verify_stream("") is False
        assert await rtsp_prober.verify_stream("rtsp://") is False

    @pytest.mark.asyncio
    async def test_parses_creds_and_delegates_to_describe(self, monkeypatch):
        """A 200 from the underlying DESCRIBE → verified; the embedded
        user:pass and path are parsed and passed through."""
        import rtsp_prober

        seen = {}

        async def fake_once(ip, port, path, user, pw, timeout=3.0):
            seen.update(ip=ip, port=port, path=path, user=user, pw=pw)
            return True

        monkeypatch.setattr(rtsp_prober, "_try_credentials_once", fake_once)
        ok = await rtsp_prober.verify_stream(
            "rtsp://admin:p%40ss@192.168.20.10:554/live?ch=1"
        )
        assert ok is True
        assert seen["ip"] == "192.168.20.10"
        assert seen["port"] == 554
        assert seen["path"] == "/live?ch=1"
        assert seen["user"] == "admin"
        assert seen["pw"] == "p@ss"  # %40 → @ decoded

    @pytest.mark.asyncio
    async def test_dead_stream_is_not_verified(self, monkeypatch):
        import rtsp_prober

        async def fake_once(*a, **k):
            return False

        monkeypatch.setattr(rtsp_prober, "_try_credentials_once", fake_once)
        assert await rtsp_prober.verify_stream("rtsp://192.168.20.10:554/stream1") is False


class _FakeWriter:
    def write(self, _data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


class _FakeReader:
    def __init__(self, payload: bytes):
        self._payload = payload

    async def read(self, _n):
        return self._payload


class TestIsRtspServer:
    """A device is only a camera if it actually speaks RTSP — a bare open 554
    (TP-Link APs, DLNA boxes, …) is not enough."""

    def _patch_response(self, monkeypatch, payload: bytes):
        import rtsp_prober

        async def fake_open(ip, port, timeout):
            return _FakeReader(payload), _FakeWriter()

        monkeypatch.setattr(rtsp_prober, "_open_rtsp", fake_open)

    @pytest.mark.asyncio
    async def test_real_rtsp_200_is_a_server(self, monkeypatch):
        import rtsp_prober

        self._patch_response(
            monkeypatch,
            b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: DESCRIBE, SETUP, PLAY\r\n\r\n",
        )
        assert await rtsp_prober.is_rtsp_server("192.168.20.10") is True

    @pytest.mark.asyncio
    async def test_auth_challenge_401_is_a_server(self, monkeypatch):
        import rtsp_prober

        self._patch_response(
            monkeypatch,
            b'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n'
            b'WWW-Authenticate: Digest realm="x", nonce="y"\r\n\r\n',
        )
        assert await rtsp_prober.is_rtsp_server("192.168.20.10") is True

    @pytest.mark.asyncio
    async def test_tplink_ap_400_is_not_a_server(self, monkeypatch):
        """The exact shape the TP-Link AP at .176 returns — 400 Bad Request,
        CSeq not echoed. Must NOT be treated as a camera."""
        import rtsp_prober

        self._patch_response(
            monkeypatch,
            b"RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n\r\n",
        )
        assert await rtsp_prober.is_rtsp_server("192.168.20.176") is False

    @pytest.mark.asyncio
    async def test_http_responder_on_554_is_not_a_server(self, monkeypatch):
        import rtsp_prober

        self._patch_response(
            monkeypatch, b"HTTP/1.0 200 OK\r\nServer: lighttpd\r\n\r\n"
        )
        assert await rtsp_prober.is_rtsp_server("192.168.20.176") is False


class TestProbeCameraRejectsNonCameras:
    @pytest.mark.asyncio
    async def test_open_port_but_not_rtsp_returns_none(self, monkeypatch):
        """Ports open, no stream cracked, and the device fails the RTSP-server
        handshake → probe_camera returns None (not a camera)."""
        import rtsp_prober

        async def fake_scan(ip, ports=None, timeout=2.0):
            return [554]

        async def fake_stream(ip, port=554, timeout=3.0):
            return None

        async def fake_creds(ip, port):
            return None

        async def fake_is_server(ip, port=554, timeout=3.0):
            return False  # the AP case

        monkeypatch.setattr(rtsp_prober, "scan_ports", fake_scan)
        monkeypatch.setattr(rtsp_prober, "probe_rtsp_stream", fake_stream)
        monkeypatch.setattr(rtsp_prober, "probe_rtsp_with_credentials", fake_creds)
        monkeypatch.setattr(rtsp_prober, "is_rtsp_server", fake_is_server)
        assert await rtsp_prober.probe_camera("192.168.20.176") is None

    @pytest.mark.asyncio
    async def test_open_port_confirmed_rtsp_returns_placeholder(self, monkeypatch):
        import rtsp_prober

        async def fake_scan(ip, ports=None, timeout=2.0):
            return [554]

        async def fake_stream(ip, port=554, timeout=3.0):
            return None

        async def fake_creds(ip, port):
            return None

        async def fake_is_server(ip, port=554, timeout=3.0):
            return True  # a real but uncracked camera

        monkeypatch.setattr(rtsp_prober, "scan_ports", fake_scan)
        monkeypatch.setattr(rtsp_prober, "probe_rtsp_stream", fake_stream)
        monkeypatch.setattr(rtsp_prober, "probe_rtsp_with_credentials", fake_creds)
        monkeypatch.setattr(rtsp_prober, "is_rtsp_server", fake_is_server)
        result = await rtsp_prober.probe_camera("192.168.20.20")
        assert result is not None
        assert result["detection_method"] == "rtsp_port_open"


class TestScanLoopGate:
    """The scan loop must not promote an unverified guess to known/active."""

    async def _run_one_candidate(self, monkeypatch, main, *, detection_method,
                                 verified):
        """Drive scan_and_discover() with a single synthetic candidate and a
        stubbed prober/frigate/verifier, then return (known, pending, added)."""
        # One DHCP lease for a camera-subnet IP; no ONVIF, no sweep.
        async def fake_leases():
            return [{"ipaddr": "192.168.100.50", "macaddr": "aa:bb:cc:dd:ee:ff",
                     "hostname": "cam", "source": "dhcp"}]

        async def fake_onvif():
            return []

        async def fake_probe(ip):
            return {
                "ip": ip, "port": 554,
                "rtsp_url": f"rtsp://{ip}:554/stream1",
                "detection_method": detection_method,
            }

        async def fake_verify(url, timeout=4.0):
            return verified

        added = {"n": 0}

        async def fake_add(name, url):
            added["n"] += 1
            return True

        async def fake_probe_onvif(ip):
            return None

        monkeypatch.setattr(main, "fetch_dhcp_leases", fake_leases)
        monkeypatch.setattr(main, "discover_cameras", fake_onvif)
        monkeypatch.setattr(main, "probe_onvif_device", fake_probe_onvif)
        monkeypatch.setattr(main, "probe_camera", fake_probe)
        monkeypatch.setattr(main, "verify_stream", fake_verify)
        monkeypatch.setattr(main, "_is_camera_hostname", lambda h: False)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main.frigate, "add_camera", fake_add)
        # publish_discovery touches MQTT — neutralize it.
        monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)

        main.known_cameras.clear()
        main.pending_cameras.clear()
        await main.scan_and_discover()
        return main.known_cameras, main.pending_cameras, added["n"]

    @pytest.mark.asyncio
    async def test_port_open_guess_stays_pending_not_known(self, monkeypatch):
        main = _fresh_main()
        known, pending, added = await self._run_one_candidate(
            monkeypatch, main,
            detection_method="rtsp_port_open", verified=False,
        )
        # The guess is NEVER cached as known (which would make the candidate
        # loop skip it forever) and is NEVER pushed to Frigate.
        assert known == {}
        assert added == 0
        # It stays pending → surfaced for setup + re-probed every scan.
        assert len(pending) == 1
        rec = next(iter(pending.values()))
        assert rec["status"] == "needs_setup"

    @pytest.mark.asyncio
    async def test_verified_stream_is_auto_added(self, monkeypatch):
        main = _fresh_main()
        known, pending, added = await self._run_one_candidate(
            monkeypatch, main,
            detection_method="rtsp_default_credentials", verified=True,
        )
        assert added == 1
        assert len(known) == 1
        assert next(iter(known.values()))["status"] == "active"
        assert pending == {}

    @pytest.mark.asyncio
    async def test_port_open_guess_skips_verify_entirely(self, monkeypatch):
        """A rtsp_port_open result is known-unverifiable, so the loop must not
        even spend a DESCRIBE on it."""
        main = _fresh_main()
        calls = {"n": 0}

        async def counting_verify(url, timeout=4.0):
            calls["n"] += 1
            return False

        # Re-run with a verify that counts invocations.
        async def fake_leases():
            return [{"ipaddr": "192.168.100.51", "macaddr": "aa:bb:cc:dd:ee:01",
                     "hostname": "", "source": "dhcp"}]

        async def fake_onvif():
            return []

        async def fake_probe(ip):
            return {"ip": ip, "port": 554,
                    "rtsp_url": f"rtsp://{ip}:554/stream1",
                    "detection_method": "rtsp_port_open"}

        async def fake_probe_onvif_skip(ip):
            return None

        monkeypatch.setattr(main, "fetch_dhcp_leases", fake_leases)
        monkeypatch.setattr(main, "discover_cameras", fake_onvif)
        monkeypatch.setattr(main, "probe_onvif_device", fake_probe_onvif_skip)
        monkeypatch.setattr(main, "probe_camera", fake_probe)
        monkeypatch.setattr(main, "verify_stream", counting_verify)
        monkeypatch.setattr(main, "_is_camera_hostname", lambda h: False)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)
        main.known_cameras.clear()
        main.pending_cameras.clear()
        await main.scan_and_discover()
        assert calls["n"] == 0  # never verified a known-guess
