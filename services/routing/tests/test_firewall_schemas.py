"""WARP-42: Pydantic firewall schemas survive realistic OpenWrt UCI payloads."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas import (
    FirewallRedirect,
    FirewallRedirectCollection,
    FirewallRule,
    FirewallRuleCollection,
    FirewallZone,
    FirewallZoneCollection,
)


class TestFirewallZone:
    def test_parses_typical_lan_zone(self):
        raw = {
            ".anonymous": False,
            ".type": "zone",
            ".name": "cfg01abc",
            "name": "lan",
            "network": ["lan"],
            "input": "ACCEPT",
            "output": "ACCEPT",
            "forward": "ACCEPT",
        }
        zone = FirewallZone.model_validate(raw)
        assert zone.name == "lan"
        assert zone.network == ["lan"]
        assert zone.input == "ACCEPT"

    def test_accepts_string_network(self):
        """UCI can store `network` as a single string OR a list."""
        zone = FirewallZone.model_validate({"name": "wan", "network": "wan"})
        assert zone.network == "wan"

    def test_preserves_unknown_fields(self):
        """Dotted UCI meta-keys and future fields pass through (extra='allow')."""
        zone = FirewallZone.model_validate(
            {"name": "guest", ".type": "zone", "custom_future_field": "xyz"}
        )
        dumped = zone.model_dump()
        assert dumped[".type"] == "zone"
        assert dumped["custom_future_field"] == "xyz"

    def test_all_fields_optional(self):
        # OpenWrt can emit a minimal zone with only defaults on disk.
        zone = FirewallZone.model_validate({})
        assert zone.name is None


class TestFirewallRule:
    def test_parses_block_rule(self):
        raw = {
            "name": "block-aabbccddeeff",
            "src": "lan",
            "dest": "wan",
            "src_mac": "aa:bb:cc:dd:ee:ff",
            "target": "REJECT",
            "enabled": "1",
        }
        rule = FirewallRule.model_validate(raw)
        assert rule.target == "REJECT"
        assert rule.src_mac == "aa:bb:cc:dd:ee:ff"

    def test_proto_can_be_list(self):
        rule = FirewallRule.model_validate({"name": "x", "proto": ["tcp", "udp"]})
        assert rule.proto == ["tcp", "udp"]


class TestFirewallRedirect:
    def test_parses_port_forward(self):
        raw = {
            "name": "ssh",
            "src": "wan",
            "dest": "lan",
            "proto": "tcp",
            "src_dport": "22",
            "dest_ip": "10.0.0.5",
            "dest_port": "22",
            "target": "DNAT",
            "enabled": "1",
        }
        redirect = FirewallRedirect.model_validate(raw)
        assert redirect.dest_ip == "10.0.0.5"
        assert redirect.target == "DNAT"


class TestCollections:
    def test_zone_collection_with_multiple_sections(self):
        raw = {
            "values": {
                "cfg01abc": {"name": "lan", "input": "ACCEPT"},
                "cfg02def": {"name": "wan", "input": "REJECT"},
            }
        }
        collection = FirewallZoneCollection.model_validate(raw)
        assert len(collection.values) == 2
        assert collection.values["cfg01abc"].name == "lan"

    def test_rule_collection_empty(self):
        collection = FirewallRuleCollection.model_validate({"values": {}})
        assert collection.values == {}

    def test_redirect_collection_missing_values_defaults_to_empty(self):
        # An empty UCI response (no config entries) should validate cleanly.
        collection = FirewallRedirectCollection.model_validate({})
        assert collection.values == {}

    def test_collection_preserves_wire_shape_on_dump(self):
        """Round-trip: parsed → dumped must match the wire shape we document."""
        raw = {
            "values": {
                "cfg01abc": {
                    ".anonymous": False,
                    ".type": "zone",
                    "name": "lan",
                    "input": "ACCEPT",
                }
            }
        }
        collection = FirewallZoneCollection.model_validate(raw)
        dumped = collection.model_dump(exclude_none=True)
        assert dumped["values"]["cfg01abc"]["name"] == "lan"
        assert dumped["values"]["cfg01abc"][".type"] == "zone"


class TestRejection:
    def test_bad_values_type_rejected(self):
        """`values` must be a dict — the dashboard relies on Object.entries."""
        with pytest.raises(ValidationError):
            FirewallZoneCollection.model_validate({"values": "not a dict"})
