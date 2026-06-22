"""droplet-ai ubus RPC scopes — GET /ai-access (read-only).

The droplet-ai user + its ACL is a real, shipping artifact (the routing service
authenticates AS this user). This surfaces its read/write scopes (parsed from the
live on-box ACL via file.read, falling back to the bundled canonical file) + the
session state, so the dashboard chips reflect on-box truth, not a stale copy.
Rotate/Revoke are NOT here — they're honest-gated in the UI (no per-token
credential to rotate without a coordinated secret refresh).
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import parse_ai_acl_scopes

AUTH = {"authorization": "Bearer pytest-fake-token"}

_ACL = {
    "droplet-ai": {
        "read": {
            "ubus": {
                "system": ["board", "info"],
                "network.interface.*": ["status", "dump"],
                "uci": ["get"],
            },
        },
        "write": {
            "ubus": {
                "network": ["restart"],
                "system": ["reboot"],
                "wireguard": ["*"],
            },
        },
    }
}


# ---------------------------------------------------------------------------
# 1. ACL parsing
# ---------------------------------------------------------------------------


class TestParseAclScopes:
    def test_flattens_read_and_write_ubus_methods(self) -> None:
        scopes = parse_ai_acl_scopes(_ACL)
        assert "system.board" in scopes["read"]
        assert "network.interface.*.status" in scopes["read"]
        assert "network.restart" in scopes["write"]
        assert "system.reboot" in scopes["write"]
        assert "wireguard.*" in scopes["write"]

    def test_empty_acl_yields_empty_scopes(self) -> None:
        scopes = parse_ai_acl_scopes({})
        assert scopes == {"read": [], "write": []}


# ---------------------------------------------------------------------------
# 2. REST endpoint
# ---------------------------------------------------------------------------


class TestAiAccessEndpoint:
    def test_returns_scopes_and_session(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.file.read.return_value = json.dumps(_ACL)
        mock_router.session_info.return_value = {
            "active": True,
            "expires_at": 1781890000.0,
            "username": "droplet-ai",
        }
        resp = connected_client.get("/ai-access", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["user"] == "droplet-ai"
        assert "system.board" in body["read_scopes"]
        assert "system.reboot" in body["write_scopes"]
        assert body["session"]["active"] is True
        assert body["session"]["rotates"] == "hourly"
        # endpoint reflects the live connection target, not the legacy 192.168.50.1.
        assert "ubus" in body["endpoint"]

    def test_falls_back_to_canonical_when_file_read_fails(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        from droplet_openwrt_sdk import UbusError

        mock_router.file.read.side_effect = UbusError(-1, "permission denied")
        mock_router.session_info.return_value = {
            "active": True,
            "expires_at": 1.0,
            "username": "droplet-ai",
        }
        resp = connected_client.get("/ai-access", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The bundled canonical ACL still yields the real shipping scopes.
        assert "system.board" in body["read_scopes"]
        assert "network.restart" in body["write_scopes"]

    def test_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.get("/ai-access")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 3. Anti-drift: the routing fallback ACL must match the committed canonical
#    ACL, so the chips can't silently drift from the on-box grant set.
# ---------------------------------------------------------------------------


class TestFallbackAclParity:
    def test_routing_fallback_matches_committed_canonical_acl(self) -> None:
        from pathlib import Path

        import main

        # The committed canonical ACL the box actually provisions.
        repo_root = Path(__file__).resolve().parents[3]
        acl_path = repo_root / "openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json"
        if not acl_path.exists():
            import pytest

            pytest.skip("canonical ACL not present in this checkout layout")
        canonical = json.loads(acl_path.read_text(encoding="utf-8"))

        canon_scopes = parse_ai_acl_scopes(canonical)
        fallback_scopes = parse_ai_acl_scopes(main._AI_ACL_FALLBACK)
        assert sorted(canon_scopes["read"]) == sorted(fallback_scopes["read"])
        assert sorted(canon_scopes["write"]) == sorted(fallback_scopes["write"])
