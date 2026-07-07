"""WARP-268 — defensive consumption of the WARP-269 allowlist + matching.

These tests exercise the ACTUAL committed schema of
docs/security/allowed-egress.yaml (top-level `version: 1`, nested
destination.hosts[]/cidrs[]/ports[]). TestRealAllowlist additionally loads the
real repo file — that is the regression guard against the two-schema drift that
left the runtime collector permanently in "allowlist-unavailable" mode.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from allowlist import Allowlist, AllowlistError, load_allowlist, match
from conftest import FIXTURES

SAMPLE = (FIXTURES / "allowed-egress.sample.yaml").read_text()

# The real, committed registry the collector consumes on every box.
REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_ALLOWLIST = REPO_ROOT / "docs" / "security" / "allowed-egress.yaml"


class TestLoad:
    def test_loads_sample_fixture(self):
        al = load_allowlist(SAMPLE)
        # 4 egress rules; the dynamic + reference entries are skipped (not
        # problems) because runtime allow-matching ignores them.
        assert len(al.rules) == 4
        assert al.problems == ()
        assert al.rules[0].key == "ai-gateway->cloud-llm-providers-optin"

    def test_dynamic_and_reference_entries_are_ignored_not_errors(self):
        al = load_allowlist(SAMPLE)
        ids = {r.entry_id for r in al.rules}
        assert "user-mail-servers" not in ids       # kind: dynamic
        assert "ref-xml-namespaces" not in ids       # kind: reference
        assert al.problems == ()

    def test_unsupported_version_raises(self):
        with pytest.raises(AllowlistError, match="version"):
            load_allowlist("version: 2\nentries: []\n")

    def test_legacy_flat_schema_version_key_raises(self):
        # The old phantom flat schema used `schema_version:` — it must now be
        # rejected (top-level `version:` is the committed key).
        with pytest.raises(AllowlistError, match="version"):
            load_allowlist("schema_version: 1\nentries: []\n")

    def test_unparseable_yaml_raises(self):
        with pytest.raises(AllowlistError):
            load_allowlist("entries: [unclosed\n")

    def test_non_mapping_top_level_raises(self):
        with pytest.raises(AllowlistError):
            load_allowlist("- just\n- a\n- list\n")

    def test_malformed_entry_is_skipped_and_reported(self):
        text = (
            "version: 1\n"
            "entries:\n"
            "  - id: ok\n"
            "    kind: egress\n"
            "    service: ai-gateway\n"
            "    destination:\n"
            "      hosts: [api.anthropic.com]\n"
            "      ports: [443]\n"
            "      protocol: https\n"
            "    purpose: ok entry\n"
            "    ticket: WARP-268\n"
            "  - id: broken\n"
            "    kind: egress\n"
            "    service: broken\n"
            "    destination:\n"
            "      hosts: [example.com]\n"
            "      ports: [not-a-port]\n"
            "      protocol: https\n"
            "    purpose: bad port\n"
            "    ticket: WARP-268\n"
        )
        al = load_allowlist(text)
        assert len(al.rules) == 1
        assert len(al.problems) == 1 and "broken" in al.problems[0]

    def test_entry_with_no_destination_hosts_or_cidrs_is_reported(self):
        text = (
            "version: 1\n"
            "entries:\n"
            "  - id: empty-dest\n"
            "    kind: egress\n"
            "    service: host\n"
            "    destination:\n"
            "      ports: [443]\n"
            "    purpose: no hosts\n"
            "    ticket: WARP-268\n"
        )
        al = load_allowlist(text)
        assert al.rules == ()
        assert len(al.problems) == 1


def _match(al: Allowlist, **kw):
    defaults = dict(service="ai-gateway", dst_ip="160.79.104.10", port=443,
                    protocol="tcp", dst_names=frozenset())
    defaults.update(kw)
    return match(al, **defaults)


class TestMatch:
    def test_hostname_match_via_dns_names(self):
        al = load_allowlist(SAMPLE)
        rule = _match(al, dst_names=frozenset({"api.anthropic.com"}))
        assert rule is not None and rule.entry_id == "cloud-llm-providers-optin"

    def test_hostname_without_dns_observation_does_not_match(self):
        # Hardcoded-IP / DoH egress to an allowlisted NAME still flags —
        # by design (see allowlist.py docstring + egress-audit.md).
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
        # exact IP (1.1.1.1) present in both hosts and cidrs; dns protocol
        # spans tcp+udp so a udp/53 flow matches.
        assert _match(al, service="host", dst_ip="1.1.1.1", port=53,
                      protocol="udp") is not None
        # 0.0.0.0/0 CIDR, port 123, udp/ntp
        assert _match(al, service="host", dst_ip="216.239.35.0", port=123,
                      protocol="udp") is not None
        # port mismatch on the NTP rule
        assert _match(al, service="host", dst_ip="216.239.35.0", port=124,
                      protocol="udp") is None

    def test_service_and_protocol_gates(self):
        al = load_allowlist(SAMPLE)
        # wrong service
        assert _match(al, service="orchestrator",
                      dst_names=frozenset({"api.anthropic.com"})) is None
        # protocol advisory: https rule is tcp-only, so a udp flow to the same
        # host+port must NOT match.
        assert _match(al, protocol="udp",
                      dst_names=frozenset({"api.anthropic.com"})) is None

    def test_port_gate(self):
        al = load_allowlist(SAMPLE)
        assert _match(al, port=8443,
                      dst_names=frozenset({"api.anthropic.com"})) is None


class TestRealAllowlist:
    """Regression guard for the two-schema drift (WARP-268/269).

    Before the allowlist.py fix these all fail: load_allowlist raised
    AllowlistError('unsupported schema_version None') on the real file, so the
    collector ran permanently in allowlist-unavailable mode.
    """

    def test_real_repo_allowlist_exists(self):
        assert REAL_ALLOWLIST.is_file(), REAL_ALLOWLIST

    def test_real_repo_allowlist_parses_without_error(self):
        al = load_allowlist(REAL_ALLOWLIST.read_text())
        assert al.problems == (), al.problems
        assert len(al.rules) > 0

    def test_known_allowlisted_host_port_classifies_as_allowed(self):
        al = load_allowlist(REAL_ALLOWLIST.read_text())
        # ai-gateway -> api.anthropic.com:443/tcp is a documented egress row.
        rule = match(al, service="ai-gateway", dst_ip="160.79.104.10",
                     port=443, protocol="tcp",
                     dst_names=frozenset({"api.anthropic.com"}))
        assert rule is not None
        assert rule.entry_id == "cloud-llm-providers-optin"

    def test_known_allowlisted_ip_resolver_classifies_as_allowed(self):
        al = load_allowlist(REAL_ALLOWLIST.read_text())
        # The collector attributes the router's flows to "openwrt" (bridge
        # container droplet-openwrt) — NOT the registry label "openwrt-router".
        # Feed the string Attributor.resolve() actually emits so this guards the
        # WARP-268 service-name reconciliation end-to-end (1.1.1.1:53 is an
        # IP/CIDR egress row, no DNS observation needed).
        rule = match(al, service="openwrt", dst_ip="1.1.1.1", port=53,
                     protocol="udp", dst_names=frozenset())
        assert rule is not None
        assert rule.entry_id == "public-dns-resolvers"

    def test_unlisted_host_classifies_as_anomaly(self):
        al = load_allowlist(REAL_ALLOWLIST.read_text())
        rule = match(al, service="ai-gateway", dst_ip="93.184.216.34",
                     port=443, protocol="tcp",
                     dst_names=frozenset({"telemetry.evil.example"}))
        assert rule is None  # -> collector emits an unlisted_destination anomaly

    def test_host_attributed_cloudflared_tunnel_matches(self):
        al = load_allowlist(REAL_ALLOWLIST.read_text())
        # cloudflared runs network_mode:host, so the attributor emits "host",
        # NOT the registry label "cloudflared". The alias must let the box's own
        # outbound tunnel match instead of surfacing as a false anomaly.
        rule = match(al, service="host", dst_ip="198.41.192.7", port=7844,
                     protocol="udp",
                     dst_names=frozenset({"tunnel.argotunnel.com"}))
        assert rule is not None
        assert rule.entry_id == "cloudflare-tunnel-edge"

    def test_every_runtime_egress_service_is_attributor_producible(self):
        """WARP-268 drift guard. match() filters candidate rules by the string
        Attributor.resolve() emits, so every runtime-phase egress row's
        canonicalized service must be a value the attributor can actually
        produce — otherwise the row is dead and its destination flags as a false
        anomaly on every box. The producible set is derived from
        docker-compose.yml, so a renamed service or a newly host-mode container
        trips this test instead of silently shipping false anomalies. This fails
        before the _SERVICE_ALIASES fix (openwrt-router / cloudflared are not
        attributor outputs).
        """
        import yaml
        from attribution import service_from_container_name

        compose = yaml.safe_load(
            (REPO_ROOT / "docker" / "docker-compose.yml").read_text(encoding="utf-8")
        )
        producible = {"host"}
        for name, cfg in (compose.get("services") or {}).items():
            cfg = cfg or {}
            if cfg.get("network_mode") == "host":
                producible.add("host")
            else:
                cname = cfg.get("container_name") or f"droplet-{name}"
                producible.add(service_from_container_name(cname))

        al = load_allowlist(REAL_ALLOWLIST.read_text())
        dead = [
            (r.entry_id, r.service, r.match_service)
            for r in al.rules
            if r.phase == "runtime" and r.match_service not in producible
        ]
        assert not dead, (
            "runtime egress rows whose service no Attributor.resolve() output "
            f"can match (registry/compose drift): {dead}"
        )
