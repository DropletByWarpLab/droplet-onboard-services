"""Tests for the DNS hostname (dnsmasq static `address=/host/ip`) endpoints.

These back the local-DNS feature that lets users reach the Droplet at
`droplet.lan` instead of its raw IP. Covers:
  - schema validation (hostname grammar, IPv4 shape)
  - SDK upsert / list / delete semantics (including duplicate pruning)
  - REST layer 400/404/503 paths
  - WARP-987: lookup NOT_FOUND/NO_DATA treated as absence, same-value
    re-post idempotency (apply NO_DATA is benign), and the explicit
    dnsmasq reload after every successful mutation
"""

from __future__ import annotations

import pytest

import main  # noqa: F401 — imported so main.app loads for the REST-layer tests
from droplet_openwrt_sdk import (
    DHCPApi,
    UBUS_STATUS_NO_DATA,
    UBUS_STATUS_NOT_FOUND,
    UbusError,
)


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

    # --- ADR-023: the opaque per-device FQDN must pass hostname validation ---
    # The split-horizon FQDN `d-<hmac>.devices.warp-lab.ai` is a multi-label
    # FQDN with hyphens — exactly the shape the grammar must accept so
    # local-dns.sh's setup_public_fqdn_dns() can register it.
    @pytest.mark.parametrize(
        "fqdn",
        [
            "d-abc123def456.devices.warp-lab.ai",
            "d-0a1b2c3d4e5f6789.devices.warp-lab.ai",
        ],
    )
    def test_opaque_fqdn_passes_validation(self, connected_client, fqdn):
        resp = connected_client.post(
            "/dhcp/hostnames",
            json=self._payload(hostname=fqdn, ip="192.168.20.1"),
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        # The real SDK is mocked — assert the schema accepted the FQDN shape.
        assert resp.status_code != 422, resp.text


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


class _NoDataOnEmptyUci(_FakeUci):
    """rpcd-build variant that reports an empty lookup as a NO_DATA error
    instead of `{"values": {}}` — the shape behind the WARP-987 500s. The
    SDK must treat it as absence (same convention as a missing section)."""

    def get(self, config, section=None, option=None, type=None):
        result = super().get(config, section=section, option=option, type=type)
        if not result["values"]:
            raise UbusError(UBUS_STATUS_NO_DATA, "no data")
        return result


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

    # --- WARP-987: a lookup that finds nothing is absence, not a fault ---
    @pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
    def test_list_treats_lookup_miss_as_absent(self, code):
        """Depending on the rpcd build / box state, a hostrecord lookup with
        nothing to return surfaces as NOT_FOUND/NO_DATA rather than an empty
        result. That means "no entries" — never a 500."""
        router = _FakeRouter()
        def _raise(*args, **kwargs):
            raise UbusError(code, "no data")
        router.uci.get = _raise
        api = DHCPApi(router)
        assert api.list_hostrecords() == []

    def test_list_treats_missing_uci_object_as_absent(self):
        """A whole missing `uci` ubus object surfaces as the -1 "Object not
        found" shape (same class `_ubus_object_absent` degrades elsewhere)."""
        router = _FakeRouter()
        def _raise(*args, **kwargs):
            raise UbusError(-1, "Object not found")
        router.uci.get = _raise
        api = DHCPApi(router)
        assert api.list_hostrecords() == []

    def test_list_propagates_real_faults(self):
        """PERMISSION_DENIED (and friends) are NOT absence — they must
        propagate so a broken ACL surfaces instead of reading as empty."""
        router = _FakeRouter()
        def _raise(*args, **kwargs):
            raise UbusError(6, "Access denied")
        router.uci.get = _raise
        api = DHCPApi(router)
        with pytest.raises(UbusError):
            api.list_hostrecords()

    def test_set_creates_when_lookup_reports_no_data(self):
        """First-ever add on a clean box: set_hostrecord's existing-record
        lookup gets NO_DATA, treats it as absent, and creates (WARP-987 —
        this path used to explode before any uci write happened)."""
        router = _FakeRouter()
        router.uci = _NoDataOnEmptyUci()
        api = DHCPApi(router)
        result = api.set_hostrecord("droplet.lan", "192.168.50.197")
        assert result["action"] == "created"
        listed = api.list_hostrecords()
        assert [(e["hostname"], e["ip"]) for e in listed] == [
            ("droplet.lan", "192.168.50.197")
        ]


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

    def test_upsert_commits_and_reloads_dnsmasq(self, connected_client, mock_router):
        """A fresh add must commit (uci.apply) AND explicitly restart dnsmasq
        (dhcp.reload). apply alone only commits — its procd config.change
        trigger does not regenerate /var/etc/dnsmasq.conf.* on the appliance,
        so without the reload the record is committed but never SERVED
        (WARP-987 live incident)."""
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
        mock_router.dhcp.reload.assert_called_once()

    def test_upsert_same_value_repost_is_idempotent(self, connected_client, mock_router):
        """THE WARP-987 500: re-posting a record already committed in uci
        stages nothing (rpcd's `uci set` skips unchanged values), so
        `uci apply` reports NO_DATA. That's "nothing to commit", not a fault
        — the endpoint must return 200 and still restart dnsmasq so a
        committed-but-unserved record self-heals."""
        fqdn = "d-b5839920cb1b0d09.droplet-us.com"
        mock_router.dhcp.set_hostrecord.return_value = {
            "section": "cfg02hostrecord",
            "hostname": fqdn,
            "ip": "192.168.20.1",
            "action": "updated",
        }
        mock_router.uci.apply.side_effect = UbusError(UBUS_STATUS_NO_DATA, "no data")
        resp = connected_client.post(
            "/dhcp/hostnames",
            json={"hostname": fqdn, "ip": "192.168.20.1"},
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"
        mock_router.dhcp.reload.assert_called_once()

    def test_upsert_apply_real_fault_still_errors(self, connected_client, mock_router):
        """Only the no-pending NO_DATA is benign — a genuine apply fault
        (e.g. PERMISSION_DENIED from a stale ACL) must surface as a 5xx and
        must NOT be masked by a reload attempt."""
        mock_router.dhcp.set_hostrecord.return_value = {
            "section": "cfg03domain",
            "hostname": "droplet.lan",
            "ip": "192.168.50.197",
            "action": "created",
        }
        mock_router.uci.apply.side_effect = UbusError(6, "Access denied")
        resp = connected_client.post(
            "/dhcp/hostnames",
            json={"hostname": "droplet.lan", "ip": "192.168.50.197"},
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 500
        mock_router.dhcp.reload.assert_not_called()

    def test_delete_missing_hostname_is_404(self, connected_client, mock_router):
        mock_router.dhcp.delete_hostrecord.return_value = 0
        resp = connected_client.delete(
            "/dhcp/hostnames/ghost.lan",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 404
        mock_router.uci.apply.assert_not_called()
        mock_router.dhcp.reload.assert_not_called()

    def test_delete_commits_and_reloads_dnsmasq(self, connected_client, mock_router):
        mock_router.dhcp.delete_hostrecord.return_value = 1
        resp = connected_client.delete(
            "/dhcp/hostnames/droplet.lan",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        mock_router.uci.apply.assert_called_once()
        mock_router.dhcp.reload.assert_called_once()

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

    # --- ADR-023: the opaque per-device FQDN round-trips through the endpoint ---
    def test_opaque_fqdn_round_trips(self, connected_client, mock_router):
        """setup_public_fqdn_dns() POSTs {fqdn -> 192.168.20.1}; the endpoint
        must accept the FQDN shape AND forward it verbatim to set_hostrecord so
        the box resolves the FQDN on LAN (and over the tunnel via 192.168.20.1)."""
        fqdn = "d-abc123def456.devices.warp-lab.ai"
        mock_router.dhcp.set_hostrecord.return_value = {
            "section": "cfg09domain",
            "hostname": fqdn,
            "ip": "192.168.20.1",
            "action": "created",
        }
        resp = connected_client.post(
            "/dhcp/hostnames",
            json={"hostname": fqdn, "ip": "192.168.20.1"},
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["hostname"] == fqdn
        mock_router.dhcp.set_hostrecord.assert_called_once_with(fqdn, "192.168.20.1")
        mock_router.uci.apply.assert_called_once()

    def test_opaque_fqdn_deregisters(self, connected_client, mock_router):
        """factory-reset.sh DELETEs the FQDN host-record on deregistration."""
        fqdn = "d-abc123def456.devices.warp-lab.ai"
        mock_router.dhcp.delete_hostrecord.return_value = 1
        resp = connected_client.delete(
            f"/dhcp/hostnames/{fqdn}",
            headers={"authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200, resp.text
        mock_router.dhcp.delete_hostrecord.assert_called_once_with(fqdn)
        mock_router.uci.apply.assert_called_once()
