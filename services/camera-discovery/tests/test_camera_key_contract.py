"""WARP-3508 — accept/reject must find a camera whatever case its MAC is spelled in.

Live symptom: the dashboard's X and Add on a discovered camera answered 404. The
orchestrator forwarded the candidate id's UPPER-case MAC (``mac:E4:30:22:50:2A:FD``)
verbatim, while ``pending_cameras`` is keyed by the LOWER-case MAC —
``scan_and_discover`` lower-cases every lease — and ``accept_camera`` /
``reject_camera`` did an exact ``get`` / ``pop``. Reproduced against a real box:
the same reject spelled lower-case answered 200.

The contract, pinned from both sides:

* orchestrator -> sends the MAC lower-case
  (apps/orchestrator/src/services/camera-candidates.service.test.ts,
  "mutateLiveCandidate — what camera-discovery is sent", and
  apps/orchestrator/src/routes/cameras.discovered-mac-case.test.ts);
* camera-discovery (this file) -> does not depend on that. Any case works, the key
  is normalised before it touches any state, and an identifier that cannot be a
  key is a 400 rather than a silent 404.

The keys are not only MACs. A camera with no DHCP lease is filed under a synthetic
key — ``ip:<addr>`` (found by the subnet sweep) or ``onvif_<addr_with_underscores>``
(found by ONVIF) — and the orchestrator upper-cases those too, so they have to
round-trip as well.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

SECRET = "pytest-fake-secret"
MAC = "e4:30:22:50:2a:fd"
AUTH = {"Authorization": f"Bearer {SECRET}"}

# (key as camera-discovery files it, key as a caller might spell it)
SPELLINGS = [
    (MAC, "E4:30:22:50:2A:FD"),
    (MAC, "e4:30:22:50:2A:fd"),
    ("ip:192.168.9.77", "IP:192.168.9.77"),
    ("onvif_192_168_9_77", "ONVIF_192_168_9_77"),
]


class _FakeRequest:
    """Minimal stand-in — _require_auth only reads headers.get('Authorization')."""

    def __init__(self, token: str = SECRET):
        self.headers = {"Authorization": f"Bearer {token}"}


def _seed(main, key: str) -> None:
    main.known_cameras.clear()
    main.pending_cameras.clear()
    main.rejected_macs.clear()
    main.pending_cameras[key] = {
        "mac": key,
        "ip": "192.168.9.219",
        "rtsp_url": "rtsp://192.168.9.219:554/stream1",
        "name": "xnv_c8083r_e43022502afd",
        "status": "needs_setup",
    }


@pytest.fixture
def main(monkeypatch):
    import main as m

    # Empty state, no reload (a reload rebuilds two HTTP clients — seconds on Windows).
    for state in (m.known_cameras, m.pending_cameras, m.rejected_macs, m.accepting_macs):
        state.clear()

    async def verify(url, timeout=4.0):
        return True

    async def add(name, url):
        return True

    monkeypatch.setattr(m, "verify_stream", verify)
    monkeypatch.setattr(m.frigate, "add_camera", add)
    monkeypatch.setattr(m, "publish_discovery", lambda *_a, **_k: None)
    return m


class TestAnyCaseIsAccepted:
    @pytest.mark.parametrize("stored,spelled", SPELLINGS)
    @pytest.mark.asyncio
    async def test_accept_finds_the_camera(self, main, stored, spelled):
        _seed(main, stored)

        result = await main.accept_camera(spelled, _FakeRequest())

        assert result["status"] == "accepted"
        # Filed under the canonical key — never under the spelling the caller used.
        assert set(main.known_cameras) == {stored}
        assert main.pending_cameras == {}

    @pytest.mark.parametrize("stored,spelled", SPELLINGS)
    @pytest.mark.asyncio
    async def test_reject_finds_the_camera(self, main, stored, spelled):
        _seed(main, stored)

        result = await main.reject_camera(spelled, _FakeRequest())

        assert result["status"] == "rejected"
        assert result["mac"] == stored
        assert main.rejected_macs == {stored}
        assert main.pending_cameras == {}

    @pytest.mark.asyncio
    async def test_surrounding_whitespace_is_ignored(self, main):
        _seed(main, MAC)
        result = await main.reject_camera(" E4:30:22:50:2A:FD ", _FakeRequest())
        assert result["status"] == "rejected"

    @pytest.mark.asyncio
    async def test_an_unknown_but_well_formed_camera_is_still_404(self, main):
        _seed(main, MAC)
        for handler in (main.accept_camera, main.reject_camera):
            with pytest.raises(HTTPException) as excinfo:
                await handler("AA:BB:CC:DD:EE:FF", _FakeRequest())
            assert excinfo.value.status_code == 404
        assert main.rejected_macs == set()


class TestInFlightGuardIgnoresCase:
    @pytest.mark.asyncio
    async def test_reject_in_another_spelling_is_refused_while_accept_is_in_flight(
        self, main, monkeypatch
    ):
        """PYNET-017: a MAC is never both accepted and rejected. The in-flight claim
        must be taken on the CANONICAL key — claimed as typed, an accept for
        ``E4:...`` would not stop a reject for ``e4:...`` and the camera could end
        up both live and dismissed."""
        _seed(main, MAC)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocking_verify(url, timeout=4.0):
            entered.set()
            await release.wait()
            return True

        monkeypatch.setattr(main, "verify_stream", blocking_verify)

        accept = asyncio.create_task(main.accept_camera("E4:30:22:50:2A:FD", _FakeRequest()))
        await asyncio.wait_for(entered.wait(), timeout=2.0)

        with pytest.raises(HTTPException) as excinfo:
            await main.reject_camera(MAC, _FakeRequest())
        assert excinfo.value.status_code == 409
        assert main.rejected_macs == set()

        release.set()
        assert (await asyncio.wait_for(accept, timeout=2.0))["status"] == "accepted"
        assert main.accepting_macs == set()


class TestMalformedIdentifier:
    @pytest.mark.parametrize(
        "bad",
        [
            "not-a-mac",
            "e4:30:22:50:2a",  # too short
            "e4:30:22:50:2a:fd:00",  # too long
            "zz:zz:zz:zz:zz:zz",  # not hex
            "../../etc/passwd",
            "ip:999",  # not an address
            "onvif_1_2",
            "a" * 300,
            "",
        ],
    )
    @pytest.mark.asyncio
    async def test_is_a_400_not_a_silent_404(self, main, bad):
        for handler in (main.accept_camera, main.reject_camera):
            with pytest.raises(HTTPException) as excinfo:
                await handler(bad, _FakeRequest())
            assert excinfo.value.status_code == 400
        assert main.rejected_macs == set()

    @pytest.mark.asyncio
    async def test_auth_is_checked_before_the_identifier(self, main):
        """An unauthenticated caller learns nothing about what is a valid key."""
        with pytest.raises(HTTPException) as excinfo:
            await main.reject_camera("not-a-mac", _FakeRequest(token="wrong"))
        assert excinfo.value.status_code == 403


class TestEveryMacRouteNormalises:
    def test_no_mac_route_can_forget_to_normalise_its_key(self, main):
        """The 404 came from one handler doing an exact lookup on whatever it was
        handed. A route added later (WARP-3505's credentials endpoint is one) must not
        be able to repeat that: any ``{mac}`` route has to go through ``_camera_key``."""
        import inspect

        mac_routes = [r for r in main.app.routes if "{mac}" in getattr(r, "path", "")]
        paths = {r.path for r in mac_routes}
        assert {"/cameras/discovered/{mac}/accept", "/cameras/discovered/{mac}/reject"} <= paths

        for route in mac_routes:
            assert "_camera_key(" in inspect.getsource(route.endpoint), (
                f"{route.path} does not normalise its {{mac}} key: it will answer 404 for any "
                "letter case the caller did not guess (WARP-3508)"
            )


class TestOverHttp:
    """The same contract through the real router: the path the orchestrator dials."""

    @pytest.fixture
    def client(self, main):
        testclient = pytest.importorskip("fastapi.testclient")
        return testclient.TestClient(main.app)

    @pytest.mark.parametrize(
        "path_mac",
        [
            "e4%3A30%3A22%3A50%3A2a%3Afd",  # what the orchestrator now sends
            "E4%3A30%3A22%3A50%3A2A%3AFD",  # what it sent before the fix
            "e4:30:22:50:2a:fd",
        ],
    )
    def test_reject(self, main, client, path_mac):
        _seed(main, MAC)
        resp = client.post(f"/cameras/discovered/{path_mac}/reject", headers=AUTH)
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"
        assert main.rejected_macs == {MAC}

    def test_accept_with_the_upper_case_mac_the_orchestrator_used_to_send(self, main, client):
        _seed(main, MAC)
        resp = client.post("/cameras/discovered/E4%3A30%3A22%3A50%3A2A%3AFD/accept", headers=AUTH)
        assert resp.status_code == 200
        assert resp.json()["status"] == "accepted"
        assert set(main.known_cameras) == {MAC}

    def test_synthetic_key_in_upper_case(self, main, client):
        _seed(main, "ip:192.168.9.77")
        resp = client.post("/cameras/discovered/IP%3A192.168.9.77/reject", headers=AUTH)
        assert resp.status_code == 200

    def test_malformed_identifier_is_a_400(self, main, client):
        resp = client.post("/cameras/discovered/not-a-mac/reject", headers=AUTH)
        assert resp.status_code == 400

    def test_unknown_camera_is_a_404(self, main, client):
        resp = client.post("/cameras/discovered/AA%3ABB%3ACC%3ADD%3AEE%3AFF/reject", headers=AUTH)
        assert resp.status_code == 404
