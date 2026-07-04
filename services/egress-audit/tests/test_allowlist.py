"""WARP-268 — defensive consumption of the WARP-269 allowlist + matching."""
from __future__ import annotations

import pytest

from allowlist import Allowlist, AllowlistError, load_allowlist, match
from conftest import FIXTURES

SAMPLE = (FIXTURES / "allowed-egress.sample.yaml").read_text()


class TestLoad:
    def test_loads_sample_fixture(self):
        al = load_allowlist(SAMPLE)
        assert len(al.rules) == 5
        assert al.problems == ()
        assert al.rules[0].key == "ai-gateway->api.anthropic.com:443/tcp"

    def test_unsupported_schema_version_raises(self):
        with pytest.raises(AllowlistError, match="schema_version"):
            load_allowlist("schema_version: 2\nentries: []\n")

    def test_unparseable_yaml_raises(self):
        with pytest.raises(AllowlistError):
            load_allowlist("entries: [unclosed\n")

    def test_non_mapping_top_level_raises(self):
        with pytest.raises(AllowlistError):
            load_allowlist("- just\n- a\n- list\n")

    def test_malformed_entry_is_skipped_and_reported(self):
        text = (
            "schema_version: 1\n"
            "entries:\n"
            "  - service: ai-gateway\n"
            "    destination: api.anthropic.com\n"
            "    port: 443\n"
            "    protocol: tcp\n"
            "    purpose: ok entry\n"
            "    ticket: WARP-268\n"
            "  - service: broken\n"
            "    destination: example.com\n"
            "    port: not-a-port\n"
            "    protocol: tcp\n"
            "    purpose: bad port\n"
            "    ticket: WARP-268\n"
        )
        al = load_allowlist(text)
        assert len(al.rules) == 1
        assert len(al.problems) == 1 and "entries[1]" in al.problems[0]


def _match(al: Allowlist, **kw):
    defaults = dict(service="ai-gateway", dst_ip="160.79.104.10", port=443,
                    protocol="tcp", dst_names=frozenset())
    defaults.update(kw)
    return match(al, **defaults)


class TestMatch:
    def test_hostname_match_via_dns_names(self):
        al = load_allowlist(SAMPLE)
        rule = _match(al, dst_names=frozenset({"api.anthropic.com"}))
        assert rule is not None and rule.ticket == "WARP-268"

    def test_hostname_without_dns_observation_does_not_match(self):
        # Hardcoded-IP / DoH egress to an allowlisted NAME still flags —
        # by design (see spec header "Coordination contract").
        assert _match(load_allowlist(SAMPLE)) is None

    def test_wildcard_suffix(self):
        al = load_allowlist(SAMPLE)
        assert _match(al, dst_ip="104.18.7.192",
                      dst_names=frozenset({"chatgpt.openai.com"})) is not None
        # no dot boundary — "evilopenai.com" must NOT match "*.openai.com"
        assert _match(al, dst_ip="104.18.7.192",
                      dst_names=frozenset({"evilopenai.com"})) is None

    def test_ip_and_cidr_destinations(self):
        al = load_allowlist(SAMPLE)
        assert _match(al, service="host", dst_ip="1.1.1.1", port=53,
                      protocol="udp") is not None       # exact IP + protocol any
        assert _match(al, service="host", dst_ip="216.239.35.0", port=123,
                      protocol="udp") is not None       # 0.0.0.0/0 CIDR
        assert _match(al, service="host", dst_ip="216.239.35.0", port=124,
                      protocol="udp") is None           # port mismatch

    def test_service_and_protocol_gates(self):
        al = load_allowlist(SAMPLE)
        assert _match(al, service="orchestrator",
                      dst_names=frozenset({"api.anthropic.com"})) is None
        assert _match(al, protocol="udp",
                      dst_names=frozenset({"api.anthropic.com"})) is None
