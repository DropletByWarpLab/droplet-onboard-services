"""WARP-1720: umdns emits duplicate JSON keys; the default decoder ate them.

ubus serialises blobmsg straight to JSON, and blobmsg allows a field name to
repeat — `umdns browse` emits every TXT record (and every ipv6 address) as
its own `"txt":` / `"ipv6":` key inside ONE object. Python's default
`json.loads` keeps only the LAST duplicate, so `entry["txt"]` arrived as the
bare string `"version=25.12.3"`, `_parse_droplet_ap_txt` returned None, and
`browse_discovered()` returned `[]` forever with no error anywhere. Verified
live 2026-08-04: a healthy, announcing AP and an ApDevice table with zero
rows.

The payload below is VERBATIM from `ubus call umdns browse` on the lab edge
router (only the neighbour-laptop record trimmed). If umdns changes shape,
change this fixture from a fresh capture, not from imagination.
"""

from __future__ import annotations

import json

from droplet_openwrt_sdk import ApApi, _pairs_keep_duplicates


# Verbatim capture, 2026-08-04, droplet-edge (Pi 5, OpenWrt): note the SIX
# repeated "txt" keys and the repeated "ipv6" key — legal blobmsg, hostile
# JSON. Kept as a raw string because the duplicate keys are the entire point:
# building this via a Python dict literal would silently collapse them and
# test nothing.
UMDNS_BROWSE_RAW = """
{
    "_droplet-ap._tcp": {
        "droplet-ap": {
            "iface": "br-lan",
            "host": "droplet-ap.local",
            "domain": "local",
            "port": 80,
            "ttl": 4500,
            "last_update": "2026-08-04T22:08:06Z",
            "priority": 2660,
            "weight": 29295,
            "txt": "role=ap",
            "txt": "mac=80:ea:0b:39:ae:23",
            "txt": "model=Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3",
            "txt": "serial=",
            "txt": "version=25.12.3",
            "ipv4": "192.168.9.180",
            "ipv6": "fe80::82ea:bff:fe39:ae23"
        }
    },
    "_droplet-switch._tcp": {
        "droplet-switch": {
            "iface": "br-lan",
            "host": "droplet-switch.local",
            "port": 80,
            "txt": "role=switch",
            "txt": "mac=70:49:a2:77:64:1a",
            "txt": "model=Zyxel GS1900-10HP A1 Switch",
            "txt": "version=25.12.5",
            "txt": "poe_ports=8",
            "txt": "poe_budget=77",
            "ipv4": "192.168.9.2"
        }
    }
}
"""


def _decode(raw: str):
    return json.loads(raw, object_pairs_hook=_pairs_keep_duplicates)


class TestPairsKeepDuplicates:
    def test_repeated_keys_become_a_list(self) -> None:
        entry = _decode(UMDNS_BROWSE_RAW)["_droplet-ap._tcp"]["droplet-ap"]
        assert entry["txt"] == [
            "role=ap",
            "mac=80:ea:0b:39:ae:23",
            "model=Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3",
            "serial=",
            "version=25.12.3",
        ]

    def test_unique_keys_keep_default_shape(self) -> None:
        entry = _decode(UMDNS_BROWSE_RAW)["_droplet-ap._tcp"]["droplet-ap"]
        # No duplicates -> scalar, exactly as the default decoder would.
        assert entry["port"] == 80
        assert entry["ipv4"] == "192.168.9.180"
        assert entry["host"] == "droplet-ap.local"

    def test_default_decoder_really_does_lose_the_mac(self) -> None:
        # Documents WHY the hook exists. If this ever fails, Python changed
        # duplicate-key semantics and the hook should be re-evaluated.
        entry = json.loads(UMDNS_BROWSE_RAW)["_droplet-ap._tcp"]["droplet-ap"]
        assert entry["txt"] == "version=25.12.3"

    def test_three_deep_nesting_applies_hook_throughout(self) -> None:
        decoded = _decode(UMDNS_BROWSE_RAW)
        switch = decoded["_droplet-switch._tcp"]["droplet-switch"]
        assert "mac=70:49:a2:77:64:1a" in switch["txt"]


class TestParseDropletApTxt:
    def test_verbatim_capture_yields_the_ap(self) -> None:
        entry = _decode(UMDNS_BROWSE_RAW)["_droplet-ap._tcp"]["droplet-ap"]
        parsed = ApApi._parse_droplet_ap_txt(entry)
        assert parsed is not None
        assert parsed["mac"] == "80:ea:0b:39:ae:23"
        assert parsed["version"] == "25.12.3"
        assert parsed["model"].startswith("Qualcomm")
        # serial= is empty on this hardware revision: present in TXT but
        # blank, so it must be OMITTED rather than recorded as "".
        assert "serial" not in parsed

    def test_single_txt_record_bare_string(self) -> None:
        # One TXT record never repeats, so even with the hook it decodes to
        # a bare string. Must parse, not return None.
        parsed = ApApi._parse_droplet_ap_txt({"txt": "mac=AA:BB:CC:DD:EE:FF"})
        assert parsed is not None
        assert parsed["mac"] == "AA:BB:CC:DD:EE:FF"

    def test_no_mac_still_rejected(self) -> None:
        assert ApApi._parse_droplet_ap_txt({"txt": "role=ap"}) is None
        assert ApApi._parse_droplet_ap_txt({"txt": ["role=ap", "version=1"]}) is None

    def test_non_txt_shapes_still_rejected(self) -> None:
        assert ApApi._parse_droplet_ap_txt({}) is None
        assert ApApi._parse_droplet_ap_txt({"txt": 7}) is None
        assert ApApi._parse_droplet_ap_txt({"txt": None}) is None


class _StubRouter:
    """Just enough router for ApApi: _call returns the decoded browse.

    Also answers `umdns update` — WARP-1760 made every browse path send a
    query first, because `browse` alone reads a cache nothing refreshes and a
    rebooted device would otherwise never reappear. That ordering has its own
    coverage in test_umdns_query.py; here we only need the call not to blow up.
    """

    def __init__(self, browse_result):
        self._browse = browse_result

    def _call(self, obj: str, method: str, args=None):
        if (obj, method) == ("umdns", "update"):
            return {}
        assert (obj, method) == ("umdns", "browse")
        return self._browse


class TestBrowseDiscoveredEndToEnd:
    def test_verbatim_capture_discovers_the_ap(self) -> None:
        api = ApApi(_StubRouter(_decode(UMDNS_BROWSE_RAW)))
        records = api.browse_discovered()
        assert len(records) == 1  # switch announces a different service type
        ap = records[0]
        assert ap["mac"] == "80:ea:0b:39:ae:23"
        assert ap["last_ip"] == "192.168.9.180"
        assert ap["hostname"] == "droplet-ap"

    def test_repeated_ipv4_takes_first_address(self) -> None:
        raw = """
        {
            "_droplet-ap._tcp": {
                "droplet-ap": {
                    "txt": "mac=AA:BB:CC:DD:EE:FF",
                    "ipv4": "192.168.9.181",
                    "ipv4": "192.168.9.182"
                }
            }
        }
        """
        api = ApApi(_StubRouter(_decode(raw)))
        records = api.browse_discovered()
        assert len(records) == 1
        assert records[0]["last_ip"] == "192.168.9.181"
