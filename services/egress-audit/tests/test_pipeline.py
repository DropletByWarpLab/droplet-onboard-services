"""WARP-268 — end-to-end pipeline over recorded fixtures: conntrack lines +
DNS packets in, NDJSON records + deduped anomaly POSTs out."""
from __future__ import annotations

import json

from allowlist import load_allowlist
from attribution import Attributor
from collector import Pipeline
from conftest import FIXTURES
from dns_wire import DnsCache, parse_ip_udp
from events import AnomalyGate
from pcap_builder import dns_query, dns_response_a, ipv4_udp

NETWORK_JSON = (FIXTURES / "docker_network_inspect.json").read_text()
IP_ADDR_JSON = (FIXTURES / "ip_addr.json").read_text()
ALLOWLIST = load_allowlist((FIXTURES / "allowed-egress.sample.yaml").read_text())


class ListSink:
    def __init__(self): self.lines = []
    def write(self, line): self.lines.append(json.loads(line))


class FakeOrchestrator:
    def __init__(self): self.posted = []
    def post_anomaly(self, payload):
        self.posted.append(payload)
        return True


def _pipeline(allowlist=ALLOWLIST):
    sink, orch = ListSink(), FakeOrchestrator()
    pipe = Pipeline(
        attributor=Attributor(lambda: NETWORK_JSON, lambda: IP_ADDR_JSON,
                              clock=lambda: 0.0),
        allowlist_provider=lambda: allowlist,
        dns_cache=DnsCache(clock=lambda: 1751600000.0),
        gate=AnomalyGate(clock=lambda: 0.0),
        sink=sink,
        orchestrator=orch,
        clock=lambda: 1751600000.0,
    )
    return pipe, sink, orch


def _dns(pipe, src, dst, payload, sport=40000, dport=53):
    pipe.handle_dns_packet(
        1751600000.0, parse_ip_udp(ipv4_udp(src, dst, sport, dport, payload)))


class TestAllowedFlow:
    def test_flow_start_and_end_records_with_policy_and_bytes(self):
        pipe, sink, orch = _pipeline()
        # dockerd's forwarder resolves api.anthropic.com upstream; the reply
        # populates the IP→name cache used for hostname matching.
        _dns(pipe, "1.1.1.1", "192.168.1.87",
             dns_response_a(7, "api.anthropic.com", ["160.79.104.10"]),
             sport=53, dport=40000)
        lines = (FIXTURES / "conntrack_events.txt").read_text().splitlines()
        pipe.handle_conntrack_line(lines[0])   # NEW  ai-gateway → 160.79.104.10:443
        pipe.handle_conntrack_line(lines[1])   # DESTROY, bytes 2412/9876
        flows = [d for d in sink.lines if d["event"] in ("flow_start", "flow_end")]
        assert [d["event"] for d in flows] == ["flow_start", "flow_end"]
        assert all(d["service"] == "ai-gateway" and d["allowed"] is True and
                   d["policy"] == "ai-gateway->cloud-llm-providers-optin"
                   for d in flows)
        assert flows[1]["bytes_out"] == 2412 and flows[1]["bytes_in"] == 9876
        assert flows[0]["dst_name"] == "api.anthropic.com"
        assert orch.posted == []


class TestUnlistedFlow:
    def test_anomaly_posted_once_per_tuple(self):
        pipe, sink, orch = _pipeline()
        lines = (FIXTURES / "conntrack_events.txt").read_text().splitlines()
        pipe.handle_conntrack_line(lines[2])   # NEW  orchestrator → 8.8.8.8:53 udp
        pipe.handle_conntrack_line(lines[3])   # DESTROY (same tuple)
        flows = [d for d in sink.lines if d["event"].startswith("flow")]
        assert all(d["allowed"] is False and "policy" not in d for d in flows)
        assert len(orch.posted) == 1           # gate dedups NEW+DESTROY
        assert orch.posted[0]["kind"] == "unlisted_destination"
        assert orch.posted[0]["service"] == "orchestrator"
        assert orch.posted[0]["dst"] == "8.8.8.8" and orch.posted[0]["port"] == 53


class TestScopeFilters:
    def test_host_source_allowed_by_host_rule(self):
        pipe, sink, orch = _pipeline()
        pipe.handle_conntrack_line(
            "[1751600080.0]\t    [NEW] udp      17 30 src=192.168.1.87 dst=1.1.1.1 "
            "sport=40001 dport=53 [UNREPLIED] src=1.1.1.1 dst=192.168.1.87 "
            "sport=53 dport=40001")
        assert sink.lines[0]["service"] == "host" and sink.lines[0]["allowed"] is True
        assert orch.posted == []

    def test_lan_and_private_destinations_skipped(self):
        pipe, sink, orch = _pipeline()
        pipe.handle_conntrack_line(              # LAN client source — out of scope
            "[1751600081.0]\t    [NEW] tcp      6 120 SYN_SENT src=192.168.20.55 "
            "dst=8.8.8.8 sport=1 dport=443 [UNREPLIED] src=8.8.8.8 "
            "dst=192.168.20.55 sport=443 dport=1")
        pipe.handle_conntrack_line(              # container → container (private dst)
            "[1751600082.0]\t    [NEW] tcp      6 120 SYN_SENT src=172.18.0.7 "
            "dst=172.18.0.9 sport=2 dport=5432 [UNREPLIED] src=172.18.0.9 "
            "dst=172.18.0.7 sport=5432 dport=2")
        assert sink.lines == [] and orch.posted == []


class TestDns:
    def test_query_logged_with_qname(self):
        pipe, sink, _ = _pipeline()
        _dns(pipe, "192.168.1.87", "1.1.1.1", dns_query(9, "telemetry.example.com"))
        assert sink.lines == [{
            "v": 1, "event": "dns_query", "ts": 1751600000.0, "service": "host",
            "src": "192.168.1.87", "dst": "1.1.1.1", "proto": "udp", "port": 53,
            "qname": "telemetry.example.com",
        }]

    def test_response_feeds_cache_not_log(self):
        pipe, sink, _ = _pipeline()
        _dns(pipe, "1.1.1.1", "192.168.1.87",
             dns_response_a(9, "x.example", ["9.9.9.9"]), sport=53, dport=40000)
        assert sink.lines == []

    def test_lan_client_query_skipped(self):
        pipe, sink, _ = _pipeline()
        _dns(pipe, "192.168.20.55", "192.168.20.1", dns_query(9, "lan.example"))
        assert sink.lines == []


class TestAllowlistUnavailable:
    def test_records_tagged_and_single_anomaly(self):
        pipe, sink, orch = _pipeline(allowlist=None)
        lines = (FIXTURES / "conntrack_events.txt").read_text().splitlines()
        pipe.handle_conntrack_line(lines[0])
        pipe.handle_conntrack_line(lines[2])
        flows = [d for d in sink.lines if d["event"].startswith("flow")]
        assert all("allowed" not in d and d["policy"] == "allowlist-unavailable"
                   for d in flows)
        kinds = [p["kind"] for p in orch.posted]
        assert kinds == ["allowlist_unavailable"]   # gate collapses repeats
