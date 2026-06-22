"""Tests for firewall rule authoring + zone-policy editing."""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import FirewallApi

AUTH = {"authorization": "Bearer pytest-fake-token"}


class TestFirewallApiAuthoring:
    def test_add_rule_writes_uci_rule_and_reloads(self) -> None:
        router = MagicMock()
        FirewallApi(router).add_rule("Allow-NAS", "wan", "lan", "tcp", "443", "ACCEPT")
        cfg, kind, values = router.uci.add.call_args.args
        assert cfg == "firewall" and kind == "rule"
        assert values["name"] == "Allow-NAS" and values["target"] == "ACCEPT"
        assert values["src"] == "wan" and values["dest"] == "lan" and values["dest_port"] == "443"
        router.uci.commit.assert_called_with("firewall")
        router.exec_service.assert_called_with("firewall", "reload")

    def test_add_rule_omits_unset_ports(self) -> None:
        router = MagicMock()
        FirewallApi(router).add_rule("Block-X", "lan", "wan", target="REJECT")
        _, _, values = router.uci.add.call_args.args
        assert "dest_port" not in values and "src_port" not in values

    def test_set_zone_policy_updates_the_named_zone_under_safe_apply(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"values": {"cfg_lan": {"name": "lan"}, "cfg_wan": {"name": "wan"}}}
        FirewallApi(router).set_zone_policy("lan", input="REJECT", forward="DROP")
        # safe_apply context manager was entered.
        router.safe_apply.assert_called_once_with(timeout=60)
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "firewall" and section == "cfg_lan"
        assert values == {"input": "REJECT", "forward": "DROP"}

    def test_set_zone_policy_raises_for_unknown_zone(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"values": {"cfg_lan": {"name": "lan"}}}
        try:
            FirewallApi(router).set_zone_policy("nope", input="ACCEPT")
            raised = False
        except Exception:
            raised = True
        assert raised


class TestFirewallAuthoringEndpoints:
    def test_add_rule_dispatches(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/firewall/rule",
            json={"name": "Allow-NAS", "src": "wan", "dest": "lan", "proto": "tcp", "dest_port": "443", "target": "ACCEPT"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "name": "Allow-NAS"}
        mock_router.firewall.add_rule.assert_called_once()

    def test_add_rule_rejects_bad_target(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/firewall/rule",
            json={"name": "X", "src": "lan", "dest": "wan", "target": "ALLOW"},
            headers=AUTH,
        )
        assert resp.status_code == 422

    def test_zone_policy_dispatches(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/firewall/zone-policy",
            json={"zone": "lan", "input": "REJECT"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "zone": "lan"}
        mock_router.firewall.set_zone_policy.assert_called_once()

    def test_zone_policy_rejects_bad_value(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/firewall/zone-policy", json={"zone": "lan", "forward": "MAYBE"}, headers=AUTH,
        )
        assert resp.status_code == 422


class TestFirewallAuthoringAuth:
    def test_add_rule_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/firewall/rule", json={"name": "X", "src": "lan", "dest": "wan"})
        assert resp.status_code == 401
