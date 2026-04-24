"""Tests for the DNS hostname (dnsmasq static `address=/host/ip`) endpoints.

These back the local-DNS feature that lets users reach the Droplet at
`droplet.lan` instead of its raw IP. Covers:
  - schema validation (hostname grammar, IPv4 shape)
  - SDK upsert / list / delete semantics (including duplicate pruning)
  - REST layer 400/404/503 paths
"""

from __future__ import annotations

import pytest

import main  # noqa: F401 — imported so main.app loads for the REST-layer tests
from droplet_openwrt_sdk import DHCPApi


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

class TestDnsHostnameSchema:
    """Pydantic validation at the REST boundary."""

    def _payload(self, **overrides):
        data = {"hostname": "droplet.lan", "ip": "192.168.50.197"}
        data.update(overrides)
        return data

    def test_valid_payload(self, connected_client):
        resp = connected_client.post(
            "/dhcp/hostnames",
            json=self._payload(),
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        # The real SDK is mocked — just assert the schema didn't reject us.
        assert resp.status_code != 422, resp.text

    @pytest.mark.parametrize(
        "bad_host",
        [
            "Droplet.lan",        # uppercase
            "-droplet.lan",       # leading hyphen
            "droplet-.lan",       # trailing hyphen
            "droplet.lan.",       # trailing dot
            "droplet..lan",       # empty label
            "drop let.lan",       # space
            "a" * 64 + ".lan",    # label > 63 chars
            "",                   # empty
        ],
    )
    def test_invalid_hostname_rejected(self, connected_client, bad_host):
        resp = connected_client.post(
            "/dhcp/hostnames",
            json=self._payload(hostname=bad_host),
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize(
        "bad_ip",
        [
            "192.168.1",          # only 3 octets
            "192.168.1.256",      # > 255
            "192.168.1.1.1",      # 5 octets
            "fe80::1",            # IPv6 — rejected, we only back v4 entries
            "not-an-ip",
        ],
    )
    def test_invalid_ip_rejected(self, connected_client, bad_ip):
        resp = connected_client.post(
            "/dhcp/hostnames",
            json=self._payload(ip=bad_ip),
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# SDK (DHCPApi) upsert / list / delete
# ---------------------------------------------------------------------------

class _FakeUci:
    """Minimal UCI stand-in with in-memory `dhcp` config and a type filter.

    Real ubus returns `{"values": {<section>: {<kv>}}}` from `uci get`. We
    match that shape so DHCPApi.list_hostrecords works without mocking it.
    """

    def __init__(self):
        self.sections: dict[str, dict] = {}
        self._counter = 0
        self.commits: list[str] = []

    def get(self, config, section=None, option=None, type=None):
        assert config == "dhcp"
        if type:
            values = {k: v for k, v in self.sections.items() if v.get(".type") == type}
        else:
            values = dict(self.sections)
        return {"values": values}

    def set(self, config, section, values):
        assert config == "dhcp"
        # Real UCI merges keys; mimic that so `.type` survives an update.
        self.sections.setdefault(section, {}).update(values)

    def add(self, config, type, values=None, name=None):
        assert config == "dhcp"
        self._counter += 1
        section = f"cfg{self._counter:02d}{type}"
        body = {".type": type}
        if values:
            body.update(values)
        self.sections[section] = body
        return {"section": section}

    def delete(self, config, section, option=None):
        assert config == "dhcp"
        self.sections.pop(section, None)

    def commit(self, config):
        self.commits.append(config)


class _FakeRouter:
    def __init__(self):
        self.uci = _FakeUci()


@pytest.fixture
def dhcp_api():
    router = _FakeRouter()
    api = DHCPApi(router)
    return api, router


class TestDHCPApiDomainEntries:
    def test_set_creates_new_entry(self, dhcp_api):
        api, router = dhcp_api
        result = api.set_hostrecord("droplet-ai.lan", "192.168.50.197")
        assert result["action"] == "created"
        assert result["hostname"] == "droplet-ai.lan"
        assert result["ip"] == "192.168.50.197"
        # SDK must NOT commit here — commit happens at the endpoint via uci.apply,
        # which is what triggers dnsmasq reload. Pre-committing would turn the
        # apply into a no-op and break live DNS updates.
        assert router.uci.commits == []

        listed = api.list_hostrecords()
        assert len(listed) == 1
        assert listed[0]["hostname"] == "droplet-ai.lan"
        assert listed[0]["ip"] == "192.168.50.197"

    def test_set_updates_existing_entry_in_place(self, dhcp_api):
        api, router = dhcp_api
        first = api.set_hostrecord("droplet.lan", "192.168.50.10")
        second = api.set_hostrecord("droplet.lan", "192.168.50.197")

        assert second["action"] == "updated"
        assert second["section"] == first["section"], \
            "upsert must reuse the original UCI section so IDs are stable"

        listed = api.list_hostrecords()
        assert [e["ip"] for e in listed] == ["192.168.50.197"]

    def test_set_is_case_insensitive_on_hostname(self, dhcp_api):
        api, _ = dhcp_api
        api.set_hostrecord("droplet.lan", "192.168.50.10")
        api.set_hostrecord("Droplet.LAN", "192.168.50.197")

        listed = api.list_hostrecords()
        assert len(listed) == 1
        # Stored hostname reflects the latest write — consistent with dnsmasq's
        # case-insensitive matching, so we keep whatever the caller sent last.
        assert listed[0]["hostname"] == "Droplet.LAN"
        assert listed[0]["ip"] == "192.168.50.197"

    def test_set_prunes_duplicate_sections(self, dhcp_api):
        """If someone manually added two `config hostrecord` entries for the
        same host, upsert should normalize to one."""
        api, router = dhcp_api
        # Seed two raw duplicates (simulating a hand-edited /etc/config/dhcp).
        router.uci.add("dhcp", "hostrecord", {"name": "droplet.lan", "ip": "1.1.1.1"})
        router.uci.add("dhcp", "hostrecord", {"name": "droplet.lan", "ip": "2.2.2.2"})
        assert len(api.list_hostrecords()) == 2

        api.set_hostrecord("droplet.lan", "192.168.50.197")

        listed = api.list_hostrecords()
        assert len(listed) == 1
        assert listed[0]["ip"] == "192.168.50.197"

    def test_list_ignores_malformed_sections(self, dhcp_api):
        api, router = dhcp_api
        router.uci.add("dhcp", "hostrecord", {"name": "droplet.lan", "ip": "10.0.0.1"})
        router.uci.add("dhcp", "hostrecord", {"name": "no-ip-here"})         # missing ip
        router.uci.add("dhcp", "hostrecord", {"ip": "10.0.0.2"})              # missing name

        listed = api.list_hostrecords()
        assert len(listed) == 1
        assert listed[0]["hostname"] == "droplet.lan"

    def test_delete_returns_count(self, dhcp_api):
        api, _ = dhcp_api
        api.set_hostrecord("droplet.lan", "192.168.50.197")
        api.set_hostrecord("printer.lan", "192.168.50.50")

        removed = api.delete_hostrecord("droplet.lan")
        assert removed == 1
        assert [e["hostname"] for e in api.list_hostrecords()] == ["printer.lan"]

    def test_delete_missing_returns_zero(self, dhcp_api):
        api, _ = dhcp_api
        assert api.delete_hostrecord("nobody.lan") == 0


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

class TestDnsHostnameEndpoints:
    def test_list_returns_entries_from_router(self, connected_client, mock_router):
        mock_router.dhcp.list_hostrecords.return_value = [
            {"section": "cfg01domain", "hostname": "droplet.lan", "ip": "192.168.50.197"},
        ]
        resp = connected_client.get(
            "/dhcp/hostnames",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "entries": [
                {"section": "cfg01domain", "hostname": "droplet.lan", "ip": "192.168.50.197"}
            ]
        }

    def test_upsert_triggers_uci_apply(self, connected_client, mock_router):
        """Reload must use uci.apply — NOT file.exec via exec_service — because
        the droplet-ai rpcd ACL grants uci.apply but denies file.exec. Using
        exec_service here would cause every POST to return 'Access denied' on
        production routers (this was the original bug)."""
        mock_router.dhcp.set_hostrecord.return_value = {
            "section": "cfg03domain",
            "hostname": "droplet.lan",
            "ip": "192.168.50.197",
            "action": "created",
        }
        resp = connected_client.post(
            "/dhcp/hostnames",
            json={"hostname": "droplet.lan", "ip": "192.168.50.197"},
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["action"] == "created"

        mock_router.dhcp.set_hostrecord.assert_called_once_with(
            "droplet.lan", "192.168.50.197",
        )
        mock_router.uci.apply.assert_called_once()
        mock_router.exec_service.assert_not_called()

    def test_delete_missing_hostname_is_404(self, connected_client, mock_router):
        mock_router.dhcp.delete_hostrecord.return_value = 0
        resp = connected_client.delete(
            "/dhcp/hostnames/ghost.lan",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 404
        mock_router.uci.apply.assert_not_called()
        mock_router.exec_service.assert_not_called()

    def test_delete_triggers_uci_apply(self, connected_client, mock_router):
        mock_router.dhcp.delete_hostrecord.return_value = 1
        resp = connected_client.delete(
            "/dhcp/hostnames/droplet.lan",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        mock_router.uci.apply.assert_called_once()
        mock_router.exec_service.assert_not_called()

    def test_delete_rejects_invalid_hostname(self, connected_client, mock_router):
        resp = connected_client.delete(
            "/dhcp/hostnames/-bad",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 400
        mock_router.dhcp.delete_hostrecord.assert_not_called()

    def test_upsert_without_router_returns_503(self, disconnected_client):
        resp = disconnected_client.post(
            "/dhcp/hostnames",
            json={"hostname": "droplet.lan", "ip": "192.168.50.197"},
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 503
