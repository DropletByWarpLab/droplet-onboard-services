"""WARP-2019 (scan-3): generic, read-only mDNS browse for arbitrary service types.

The routing service is the box's only working mDNS consumer, but every browse
path it owns is hard-filtered to `_droplet-*._tcp`. Scanner discovery needs
`_uscan._tcp` / `_uscans._tcp`, and the printer workstream will need
`_ipp._tcp`. This is one generic endpoint behind one allowlist.

The load-bearing correction this ticket exists to make: **`FabricApi._parse_member_txt`
and `ApApi._parse_droplet_ap_txt` cannot be reused.** Both drop any record
without a `mac=` TXT key, because the MAC is the orchestrator's primary key for
fabric devices (ADR-035 §2). An eSCL advert carries `rs=` / `ty=` / `uuid=` /
`pdl=` / `is=` / `duplex=` and **never** a `mac=`, so verbatim reuse returns
`None` for 100% of scanner records. `test_mac_less_record_is_kept` is the guard
against exactly that mistake.

The contract under test:
  * every browse issues `umdns update` FIRST (WARP-1760 — `browse` reads a
    cache nothing else refreshes, so a rebooted device never comes back)
  * mac-less records are kept; `uuid=` is the identity
  * the same three TXT shapes and three ipv4 shapes the WARP-1720 duplicate-key
    hook produces all parse
  * `?service=` is regex-validated AND allowlisted — this is not a
    general-purpose LAN scanner for any caller who reaches the port
  * umdns absent degrades to an empty list; auth/transport failures still bubble
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from droplet_openwrt_sdk import DiscoveryApi, UbusError

import main
from mock_router import MockRouter
from tests.test_umdns_query import _RecordingRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}

# A real-shaped eSCL advert (Mopria/AirScan). What matters here is what it does
# NOT carry: no `mac=`. `note=` is present but blank, which is how a scanner
# with no configured location string announces itself.
SCANNER_TXT = [
    "txtvers=1",
    "rs=eSCL",
    "ty=Brother MFC-L2750DW",
    "uuid=e3248000-80ce-11db-8000-aabbccddeeff",
    "pdl=application/pdf,image/jpeg",
    "is=platen,adf",
    "duplex=T",
    "note=",
]

SCANNER_ENTRY = {
    "iface": "br-lan",
    "host": "BRWAABBCCDDEEFF.local",
    "port": 80,
    "txt": SCANNER_TXT,
    "ipv4": "192.168.9.61",
}


def _browse(entry: dict | None = None, service: str = "_uscan._tcp") -> dict:
    """One umdns browse reply carrying a single record of `service`."""
    return {service: {"BRWAABBCCDDEEFF": SCANNER_ENTRY if entry is None else entry}}


class _BrowseRaises:
    """Router double whose `umdns browse` raises a chosen ubus status."""

    def __init__(self, code: int):
        self._code = code
        self.calls: list[tuple] = []

    def _call(self, obj, method, args=None):
        self.calls.append((obj, method))
        if (obj, method) == ("umdns", "browse"):
            raise UbusError(self._code)
        return {}


@pytest.fixture
def mock_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient backed by the in-memory MockRouter, so `/discovery/_test_seed`
    has something to seed and no real umdns call can leak into the suite."""
    monkeypatch.setattr(main, "router_instance", MockRouter())
    return TestClient(main.app)


class TestQueryBeforeBrowse:
    """WARP-1760 applies to every browse path, this one included."""

    def test_query_issued_before_browse(self):
        r = _RecordingRouter(_browse())
        DiscoveryApi(r).browse_service("_uscan._tcp")
        assert r.calls[0] == ("umdns", "update"), r.calls
        assert ("umdns", "browse") in r.calls


class TestMacLessRecords:
    """The whole point of a separate parser."""

    def test_mac_less_record_is_kept(self):
        records = DiscoveryApi(_RecordingRouter(_browse())).browse_service("_uscan._tcp")
        assert len(records) == 1, "an eSCL advert has no mac= and must not be dropped"
        record = records[0]
        assert "mac" not in record["txt"]
        assert record["uuid"] == "e3248000-80ce-11db-8000-aabbccddeeff"
        assert record["txt"]["rs"] == "eSCL"
        assert record["txt"]["ty"] == "Brother MFC-L2750DW"

    def test_record_carries_the_transport_facts(self):
        records = DiscoveryApi(_RecordingRouter(_browse())).browse_service("_uscan._tcp")
        record = records[0]
        assert record["service_type"] == "_uscan._tcp"
        assert record["hostname"] == "BRWAABBCCDDEEFF"
        assert record["port"] == 80
        assert record["last_ip"] == "192.168.9.61"

    def test_only_the_requested_service_type_is_returned(self):
        raw = _browse()
        raw["_droplet-ap._tcp"] = {"droplet-ap": {"txt": ["role=ap", "mac=80:ea:0b:39:ae:23"]}}
        records = DiscoveryApi(_RecordingRouter(raw)).browse_service("_uscan._tcp")
        assert [r["service_type"] for r in records] == ["_uscan._tcp"]


class TestShapeTolerance:
    """The WARP-1720 duplicate-key hook makes all three shapes reachable."""

    @pytest.mark.parametrize(
        "txt",
        [
            "uuid=e3248000-80ce-11db-8000-aabbccddeeff",           # single record → bare string
            ["uuid=e3248000-80ce-11db-8000-aabbccddeeff"],         # repeated field → list
            {"uuid": "e3248000-80ce-11db-8000-aabbccddeeff"},      # build-dependent dict
        ],
        ids=["bare-string", "list", "dict"],
    )
    def test_txt_three_shapes(self, txt):
        entry = {**SCANNER_ENTRY, "txt": txt}
        records = DiscoveryApi(_RecordingRouter(_browse(entry))).browse_service("_uscan._tcp")
        assert records[0]["txt"] == {"uuid": "e3248000-80ce-11db-8000-aabbccddeeff"}

    @pytest.mark.parametrize(
        "ipv4",
        [
            "192.168.9.61",
            {"address": "192.168.9.61"},
            {"ip": "192.168.9.61"},
            ["192.168.9.61", "192.168.9.62"],  # dual-stack repeat — first wins
        ],
        ids=["string", "address-dict", "ip-dict", "list"],
    )
    def test_ipv4_three_shapes(self, ipv4):
        entry = {**SCANNER_ENTRY, "ipv4": ipv4}
        records = DiscoveryApi(_RecordingRouter(_browse(entry))).browse_service("_uscan._tcp")
        assert records[0]["last_ip"] == "192.168.9.61"

    def test_blank_txt_value_omitted(self):
        records = DiscoveryApi(_RecordingRouter(_browse())).browse_service("_uscan._tcp")
        txt = records[0]["txt"]
        assert "note" not in txt, "a blank TXT value must be absent, never recorded as ''"
        assert "" not in txt.values()


class TestDegradation:
    @pytest.mark.parametrize("code", [4, 5], ids=["NOT_FOUND", "NO_DATA"])
    def test_umdns_absent_degrades_to_empty(self, code):
        assert DiscoveryApi(_BrowseRaises(code)).browse_service("_uscan._tcp") == []

    def test_unknown_service_type_is_empty_not_an_error(self):
        records = DiscoveryApi(_RecordingRouter(_browse())).browse_service("_ipp._tcp")
        assert records == []

    def test_auth_failure_still_bubbles(self):
        with pytest.raises(UbusError):
            DiscoveryApi(_BrowseRaises(6)).browse_service("_uscan._tcp")


class TestEndpointValidation:
    """`GET /discovery/mdns` is not a general-purpose LAN scanner."""

    @pytest.mark.parametrize(
        "service",
        [
            "_droplet-ap._tcp",   # well-formed but off the allowlist
            "../../etc",          # not a service type at all
            "_uscan._sctp",       # wrong transport
            "",                   # empty
            "_uscan._tcp; ls",    # command-shaped
        ],
    )
    def test_service_param_rejected_off_allowlist(self, mock_client, service):
        resp = mock_client.get("/discovery/mdns", params={"service": service}, headers=AUTH)
        assert resp.status_code == 400, resp.text

    def test_service_param_is_required(self, mock_client):
        assert mock_client.get("/discovery/mdns", headers=AUTH).status_code == 422

    @pytest.mark.parametrize(
        "service", ["_uscan._tcp", "_uscans._tcp", "_ipp._tcp", "_ipps._tcp"]
    )
    def test_allowlisted_types_accepted(self, mock_client, service):
        resp = mock_client.get("/discovery/mdns", params={"service": service}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"records": []}

    def test_requires_bearer(self, mock_client):
        resp = mock_client.get("/discovery/mdns", params={"service": "_uscan._tcp"})
        assert resp.status_code == 401


class TestMockSeam:
    """scan-4's poller has to be drivable without hardware."""

    def test_seeded_record_comes_back(self, mock_client):
        seed = {
            "service": "_uscan._tcp",
            "hostname": "BRWAABBCCDDEEFF",
            "port": 80,
            "last_ip": "192.168.9.61",
            "txt": {"rs": "eSCL", "ty": "Brother MFC-L2750DW", "uuid": "e3248000-80ce"},
        }
        assert mock_client.post("/discovery/_test_seed", json=seed, headers=AUTH).status_code == 200

        resp = mock_client.get(
            "/discovery/mdns", params={"service": "_uscan._tcp"}, headers=AUTH
        )
        assert resp.status_code == 200, resp.text
        records = resp.json()["records"]
        assert len(records) == 1
        assert records[0]["uuid"] == "e3248000-80ce"
        assert records[0]["last_ip"] == "192.168.9.61"
        assert records[0]["service_type"] == "_uscan._tcp"

    def test_seed_does_not_leak_across_service_types(self, mock_client):
        mock_client.post(
            "/discovery/_test_seed",
            json={"service": "_uscan._tcp", "hostname": "s1", "txt": {"uuid": "u1"}},
            headers=AUTH,
        )
        resp = mock_client.get(
            "/discovery/mdns", params={"service": "_ipp._tcp"}, headers=AUTH
        )
        assert resp.json() == {"records": []}

    def test_seed_rejects_off_allowlist_service(self, mock_client):
        resp = mock_client.post(
            "/discovery/_test_seed",
            json={"service": "_droplet-ap._tcp", "hostname": "x"},
            headers=AUTH,
        )
        assert resp.status_code == 400, resp.text
