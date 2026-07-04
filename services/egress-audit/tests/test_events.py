"""WARP-268 — record serialization + anomaly gate dedup."""
from __future__ import annotations

import json

from events import Anomaly, AnomalyGate, EgressRecord


def _record(**kw):
    defaults = dict(event="flow_end", ts=1751600042.654321, service="ai-gateway",
                    src="172.18.0.7", dst="160.79.104.10", proto="tcp", port=443,
                    bytes_out=2412, bytes_in=9876, allowed=True,
                    policy="ai-gateway->api.anthropic.com:443/tcp",
                    dst_name="api.anthropic.com")
    defaults.update(kw)
    return EgressRecord(**defaults)


class TestEgressRecord:
    def test_json_line_has_all_ac_fields(self):
        doc = json.loads(_record().to_json_line())
        # AC: (source service, destination, port, bytes, timestamp, allowed-policy)
        assert doc["v"] == 1
        assert doc["service"] == "ai-gateway"
        assert doc["dst"] == "160.79.104.10" and doc["dst_name"] == "api.anthropic.com"
        assert doc["port"] == 443
        assert doc["bytes_out"] == 2412 and doc["bytes_in"] == 9876
        assert doc["ts"] == 1751600042.654321
        assert doc["allowed"] is True
        assert doc["policy"] == "ai-gateway->api.anthropic.com:443/tcp"

    def test_none_fields_omitted_but_false_kept(self):
        doc = json.loads(_record(bytes_out=None, bytes_in=None, allowed=False,
                                 policy=None, dst_name=None).to_json_line())
        assert "bytes_out" not in doc and "policy" not in doc
        assert doc["allowed"] is False

    def test_line_is_single_line_sorted_keys(self):
        line = _record().to_json_line()
        assert "\n" not in line
        keys = list(json.loads(line).keys())
        assert keys == sorted(keys)


class TestAnomalyPayload:
    def test_post_payload_shape(self):
        payload = Anomaly(kind="unlisted_destination", service="ai-gateway",
                          ts=1751600042.0, dst="104.18.6.192",
                          dst_name="tracker.example", port=443, proto="tcp").to_payload()
        assert payload == {
            "schemaVersion": 1,
            "kind": "unlisted_destination",
            "service": "ai-gateway",
            "firstSeen": "2025-07-04T03:34:02Z",
            "dst": "104.18.6.192",
            "dstName": "tracker.example",
            "port": 443,
            "protocol": "tcp",
        }

    def test_unusual_proto_normalized_to_other(self):
        payload = Anomaly(kind="unlisted_destination", service="openwrt",
                          ts=0.0, dst="1.2.3.4", proto="gre").to_payload()
        assert payload["protocol"] == "other"


class TestAnomalyGate:
    def test_dedups_within_cooldown_and_expires(self):
        now = [0.0]
        gate = AnomalyGate(clock=lambda: now[0], cooldown_sec=3600.0)
        a = Anomaly(kind="unlisted_destination", service="ai-gateway",
                    ts=0.0, dst="1.2.3.4", port=443, proto="tcp")
        assert gate.admit(a) is True
        assert gate.admit(a) is False
        now[0] = 3601.0
        assert gate.admit(a) is True

    def test_distinct_tuples_admitted_independently(self):
        gate = AnomalyGate(clock=lambda: 0.0)
        a = Anomaly(kind="unlisted_destination", service="ai-gateway",
                    ts=0.0, dst="1.2.3.4", port=443, proto="tcp")
        b = Anomaly(kind="unlisted_destination", service="orchestrator",
                    ts=0.0, dst="1.2.3.4", port=443, proto="tcp")
        assert gate.admit(a) and gate.admit(b)
