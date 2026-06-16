"""NET-09: PortForwardRequest input validation.

`PortForwardRequest` was the only un-validated network mutator: `dest_ip`,
`src_port`, `dest_port` were free strings written verbatim into a UCI
firewall `redirect` (DNAT) rule. Port-forwarding exposes WAN ingress, so a
malformed `dest_ip` (hostname/CIDR/whitespace) or garbage port silently
produced a broken/never-matching rule with no feedback. This pins the
schema-level validation: bad input is rejected with a 422 BEFORE any UCI
write is attempted (no port forward is ever created for invalid input).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import main
from schemas import PortForwardRequest


AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# Pure schema validation (no router needed)
# ---------------------------------------------------------------------------


class TestPortForwardSchema:
    def test_valid_single_ports(self):
        req = PortForwardRequest(
            name="ssh", src_port="2222", dest_ip="192.168.1.50",
            dest_port="22", proto="tcp",
        )
        assert req.dest_ip == "192.168.1.50"
        assert req.src_port == "2222"

    def test_valid_port_range(self):
        req = PortForwardRequest(
            name="rtp", src_port="8000-8100", dest_ip="10.0.0.5",
            dest_port="8000-8100", proto="udp",
        )
        assert req.dest_port == "8000-8100"

    @pytest.mark.parametrize(
        "bad_ip",
        [
            "not-an-ip",
            "example.com",          # hostname, not IPv4
            "192.168.1.0/24",       # CIDR
            "256.1.1.1",            # octet > 255
            "192.168.1",            # too few octets
            " 192.168.1.5",         # leading whitespace
            "192.168.1.5 ",         # trailing whitespace
            "",
        ],
    )
    def test_bad_dest_ip_rejected(self, bad_ip):
        with pytest.raises(ValidationError):
            PortForwardRequest(
                name="x", src_port="80", dest_ip=bad_ip, dest_port="80",
            )

    @pytest.mark.parametrize(
        "bad_port",
        [
            "0",                    # below range
            "65536",                # above range
            "99999",                # way above
            "abc",                  # non-numeric
            "80/tcp",               # garbage suffix
            "8000-",                # malformed range
            "8100-8000",            # reversed range (lo > hi)
            "0-100",                # range endpoint below 1
            "1-70000",              # range endpoint above 65535
            "",
        ],
    )
    def test_bad_ports_rejected(self, bad_port):
        with pytest.raises(ValidationError):
            PortForwardRequest(
                name="x", src_port=bad_port, dest_ip="10.0.0.5",
                dest_port="80",
            )
        with pytest.raises(ValidationError):
            PortForwardRequest(
                name="x", src_port="80", dest_ip="10.0.0.5",
                dest_port=bad_port,
            )

    @pytest.mark.parametrize("bad_proto", ["icmp", "TCP", "all", "", "tcp udp"])
    def test_bad_proto_rejected(self, bad_proto):
        with pytest.raises(ValidationError):
            PortForwardRequest(
                name="x", src_port="80", dest_ip="10.0.0.5",
                dest_port="80", proto=bad_proto,
            )


# ---------------------------------------------------------------------------
# Endpoint-level: bad input is rejected (422) and NEVER reaches the SDK,
# i.e. no port forward is attempted on invalid input.
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch, mock_router) -> TestClient:
    monkeypatch.setattr(main, "router_instance", mock_router)
    return TestClient(main.app)


def test_endpoint_rejects_bad_ip_without_touching_router(client, mock_router):
    resp = client.post(
        "/firewall/port-forward",
        json={"name": "x", "src_port": "80", "dest_ip": "example.com",
              "dest_port": "80", "proto": "tcp"},
        headers=AUTH,
    )
    assert resp.status_code == 422
    # The SDK mutator must never have been called — validation happens first.
    mock_router.firewall.add_port_forward.assert_not_called()


def test_endpoint_rejects_bad_port_without_touching_router(client, mock_router):
    resp = client.post(
        "/firewall/port-forward",
        json={"name": "x", "src_port": "99999", "dest_ip": "10.0.0.5",
              "dest_port": "80", "proto": "tcp"},
        headers=AUTH,
    )
    assert resp.status_code == 422
    mock_router.firewall.add_port_forward.assert_not_called()


def test_endpoint_accepts_valid_request(client, mock_router):
    resp = client.post(
        "/firewall/port-forward",
        json={"name": "ssh", "src_port": "2222", "dest_ip": "192.168.1.50",
              "dest_port": "22", "proto": "tcp"},
        headers=AUTH,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok", "name": "ssh"}
    mock_router.firewall.add_port_forward.assert_called_once_with(
        "ssh", "2222", "192.168.1.50", "22", "tcp",
    )
