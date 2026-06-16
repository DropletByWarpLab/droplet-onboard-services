"""WARP-40: in-memory operation store + X-Operation-Id middleware + polling endpoint."""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

import main
import operations


@pytest.fixture(autouse=True)
def reset_operations():
    """Drop any stored operations between tests."""
    operations.clear()
    yield
    operations.clear()


class TestOperationsStore:
    def test_register_returns_unique_pending_ids(self):
        a = operations.register()
        b = operations.register()
        assert a != b

        op_a = operations.get(a)
        op_b = operations.get(b)
        assert op_a is not None and op_b is not None
        assert op_a.state == "pending"
        assert op_b.state == "pending"

    def test_mark_applied_updates_state(self):
        op_id = operations.register()
        operations.mark_applied(op_id)
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "applied"
        assert op.finished_at is not None
        assert op.reason is None

    def test_mark_rolled_back_records_reason(self):
        op_id = operations.register()
        operations.mark_rolled_back(op_id, "connectivity lost")
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "rolled_back"
        assert op.reason == "connectivity lost"

    def test_mark_rejected_records_reason(self):
        op_id = operations.register()
        operations.mark_rejected(op_id, "HTTP 422")
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "rejected"
        assert op.reason == "HTTP 422"

    def test_rejected_is_terminal_and_sticky(self):
        """A rejected op must not later flip to applied/rolled_back."""
        op_id = operations.register()
        operations.mark_rejected(op_id, "HTTP 401")
        operations.mark_applied(op_id)
        operations.mark_rolled_back(op_id, "too late")
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "rejected"
        assert op.reason == "HTTP 401"

    def test_terminal_state_is_sticky(self):
        """Once applied, a later mark_rolled_back must not flip the state."""
        op_id = operations.register()
        operations.mark_applied(op_id)
        operations.mark_rolled_back(op_id, "too late")
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "applied"
        assert op.reason is None

    def test_get_unknown_returns_none(self):
        assert operations.get("not-a-real-id") is None

    def test_ttl_evicts_old_finished_entries(self):
        op_id = operations.register()
        operations.mark_applied(op_id)
        # Fast-forward past TTL
        with patch("operations.time.time", return_value=time.time() + operations.OPERATION_TTL_SEC + 1):
            assert operations.get(op_id) is None


class TestOperationsEndpoint:
    def test_get_operation_returns_payload(self, disconnected_client):
        op_id = operations.register()
        resp = disconnected_client.get(
            f"/operations/{op_id}",
            headers={"Authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == op_id
        assert body["state"] == "pending"
        assert body["startedAt"] > 0
        assert body["finishedAt"] is None
        assert body["reason"] is None

    def test_get_missing_operation_404(self, disconnected_client):
        resp = disconnected_client.get(
            "/operations/does-not-exist",
            headers={"Authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 404

    def test_get_operation_requires_bearer(self, disconnected_client):
        op_id = operations.register()
        resp = disconnected_client.get(f"/operations/{op_id}")
        # Auth middleware runs before our handler.
        assert resp.status_code == 401


class TestOperationTrackingMiddleware:
    """Verifies POST/PUT/DELETE requests get a new operation id via the header,
    and that terminal state is classified by status code.

    Using `/network/summary` (GET) to verify the skip path, and a non-existent
    POST path to verify 404 still comes through with an X-Operation-Id header
    (the middleware runs before routing).
    """

    def test_get_does_not_track(self, disconnected_client):
        resp = disconnected_client.get(
            "/network/summary",
            headers={"Authorization": "Bearer pytest-fake-token"},
        )
        # /network/summary returns 503 when router is disconnected; what matters
        # is no X-Operation-Id was set.
        assert "X-Operation-Id" not in resp.headers
        # And no operations were created.
        assert len(operations._store) == 0

    def test_health_not_tracked(self, disconnected_client):
        resp = disconnected_client.get("/health")
        assert "X-Operation-Id" not in resp.headers
        assert len(operations._store) == 0

    def test_operations_path_not_tracked(self, disconnected_client):
        # Even GET /operations/x shouldn't create a new operation record.
        op_id = operations.register()
        # Re-check count before polling
        before = len(operations._store)
        resp = disconnected_client.get(
            f"/operations/{op_id}",
            headers={"Authorization": "Bearer pytest-fake-token"},
        )
        assert resp.status_code == 200
        assert len(operations._store) == before

    def test_post_write_gets_header_and_applied_state(self, connected_client):
        """POST to a handler that returns 2xx marks applied + emits header."""
        # Use /wireless/ssid as a representative write — it returns 2xx on
        # success. connected_client mocks the router so set_ssid is a no-op.
        resp = connected_client.post(
            "/wireless/ssid",
            headers={"Authorization": "Bearer pytest-fake-token"},
            json={"radio": "radio0", "iface_section": "default_radio0", "ssid": "Test"},
        )
        assert resp.status_code < 400, resp.text
        assert "X-Operation-Id" in resp.headers

        op_id = resp.headers["X-Operation-Id"]
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "applied"

    def test_post_write_5xx_marks_rolled_back(self, disconnected_client):
        """Router-disconnected 503 is classified as rolled_back in the record."""
        resp = disconnected_client.post(
            "/wireless/ssid",
            headers={"Authorization": "Bearer pytest-fake-token"},
            json={"radio": "radio0", "iface_section": "default_radio0", "ssid": "Test"},
        )
        assert resp.status_code == 503
        assert "X-Operation-Id" in resp.headers

        op_id = resp.headers["X-Operation-Id"]
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "rolled_back"
        assert "503" in (op.reason or "")

    def test_post_write_4xx_marks_rejected(self, connected_client):
        """4xx means the request was refused before any router state change.

        Security regression: this used to mark `applied`, recording a 401/422 as
        a successful router change and masking auth/validation failures from
        operators. It must now mark the neutral `rejected` terminal, carrying the
        status code as the reason.
        """
        resp = connected_client.post(
            "/wireless/ssid",
            headers={"Authorization": "Bearer pytest-fake-token"},
            # Missing required fields → 422 from FastAPI validation
            json={},
        )
        assert 400 <= resp.status_code < 500
        assert "X-Operation-Id" in resp.headers

        op_id = resp.headers["X-Operation-Id"]
        op = operations.get(op_id)
        assert op is not None
        assert op.state == "rejected"
        assert str(resp.status_code) in (op.reason or "")
