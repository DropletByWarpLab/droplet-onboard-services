"""WARP-1760: discovery must ASK, not just read the cache.

`umdns browse` returns umdns's cache. Nothing in the control plane ever sent
a query, so the box only learned about a device whose unsolicited
announcement happened to land while umdns was listening. Observed live
2026-08-05: after the AP rebooted, `/fabric/members` returned 2 of 3 members
for as long as anyone cared to wait — the AP was advertising correctly (its
own `umdns announcements` proved it) and the router's cache simply did not
have it. A single `ubus call umdns update` brought it straight back.

The contract under test:
  * every browse path issues `umdns update` FIRST
  * it is fire-and-forget — a failing query must never cost us the browse,
    because a stale-but-present cache beats no discovery at all
  * the browse still happens, and its result is still returned
"""

from __future__ import annotations

import pytest

from droplet_openwrt_sdk import ApApi, FabricApi, UbusError, ConnectionLost


class _RecordingRouter:
    """Records the call order so the test can assert query-before-browse."""

    def __init__(self, browse_result=None, update_raises=None):
        self.calls: list[tuple] = []
        self._browse = browse_result if browse_result is not None else {}
        self._update_raises = update_raises

    def _call(self, obj, method, args=None):
        self.calls.append((obj, method))
        if (obj, method) == ("umdns", "update"):
            if self._update_raises is not None:
                raise self._update_raises
            return {}
        if (obj, method) == ("umdns", "browse"):
            return self._browse
        return {}


AP_RECORD = {
    "_droplet-ap._tcp": {
        "droplet-ap": {
            "txt": ["role=ap", "mac=80:ea:0b:39:ae:23"],
            "ipv4": "192.168.9.180",
        }
    }
}


class TestQueryBeforeBrowse:
    def test_ap_discovery_queries_first(self):
        r = _RecordingRouter(AP_RECORD)
        ApApi(r).browse_discovered()
        assert r.calls[0] == ("umdns", "update"), r.calls
        assert ("umdns", "browse") in r.calls

    def test_fabric_members_queries_first(self):
        r = _RecordingRouter(AP_RECORD)
        FabricApi(r).browse_members()
        assert r.calls[0] == ("umdns", "update"), r.calls
        assert ("umdns", "browse") in r.calls


class TestQueryIsFireAndForget:
    """A failing query must never cost us the browse."""

    @pytest.mark.parametrize(
        "boom",
        [
            UbusError(4),                      # object not found
            UbusError(6),                      # permission denied
            ConnectionLost("transport gone"),  # transport fault
        ],
    )
    def test_browse_still_runs_and_returns(self, boom):
        r = _RecordingRouter(AP_RECORD, update_raises=boom)
        records = ApApi(r).browse_discovered()
        assert ("umdns", "browse") in r.calls
        assert len(records) == 1
        assert records[0]["mac"] == "80:ea:0b:39:ae:23"

    def test_fabric_browse_still_runs_when_query_fails(self):
        r = _RecordingRouter(AP_RECORD, update_raises=UbusError(6))
        members = FabricApi(r).browse_members()
        assert ("umdns", "browse") in r.calls
        assert [m["role"] for m in members] == ["ap"]
