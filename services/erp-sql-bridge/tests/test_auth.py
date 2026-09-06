"""WARP-2590 — the service bearer gate (auth.py).

The bridge already had two guards: `allowlist.py` decides WHICH statement may
run, and the database grant decides what `droplet_ro` may touch. Neither
decides WHO may ask, so any container on the compose network could drive the
bridge — including pointing `target.host` at a server it controlled and
harvesting the practice's ODBC credentials from the connection attempt.

Every test here is a MUTATION test: delete `setup_auth(app)` from main.py, or
downgrade the empty-token branch to "allow anyway", and at least one goes red.
The pool sentinel is what makes that airtight — a refused request provably
never acquires a connection, so these cannot pass by coincidence.
"""
from __future__ import annotations

import pytest

import main
from db import UpstreamUnavailable
from tests.conftest import TEST_SERVICE_TOKEN

# A statement the allowlist accepts for this route+name, so a request that
# clears the gate lands on the pool rather than being refused a layer later.
# Kept in sync with test_allowlist.py by the same registry it comes from.
GET_PATIENT_SQL = (
    'SELECT "patient_id", "first_name", "last_name" '
    'FROM "dba"."patient" '
    'WHERE "patient_id" = ?'
)
TARGET = {"host": "127.0.0.1", "port": 9}


@pytest.fixture
def pool_sentinel(monkeypatch):
    """Raises if the pool is ever reached, and records that it was.

    An empty list after a refused request is the proof the gate ran BEFORE any
    connection attempt — which is the whole point. If auth were checked after
    the route body, the credential-bearing connect would already have happened.
    """
    calls: list[tuple] = []

    def sentinel(*args, **kwargs):
        calls.append(args)
        raise UpstreamUnavailable("sentinel: the pool was reached")

    monkeypatch.setattr(main.POOL, "acquire", sentinel)
    return calls


class TestGateRefusesUnauthenticatedCallers:
    """No bearer, wrong bearer, wrong scheme — all refused before the pool."""

    @pytest.mark.parametrize(
        ("route", "name"),
        [("read", "get_patient"), ("write", "reschedule_appointment"), ("introspect", None)],
    )
    def test_a_request_with_no_bearer_is_refused_before_the_pool(
        self, unauthenticated_client, pool_sentinel, route, name
    ):
        path = "/introspect" if name is None else f"/{route}/{name}"
        body = (
            {"queries": {"tables": {"sql": "SELECT 1", "params": []}}, "target": TARGET}
            if name is None
            else {"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET}
        )
        r = unauthenticated_client.post(path, json=body)
        assert r.status_code == 401
        assert r.json()["code"] == "UNAUTHORIZED"
        assert pool_sentinel == []

    @pytest.mark.parametrize(
        "header",
        [
            "",
            "Bearer",
            "Bearer ",
            "Bearer wrong-token",
            f"Bearer {TEST_SERVICE_TOKEN}x",
            f"Bearer  {TEST_SERVICE_TOKEN}",  # extra space — not the same string
            f"Basic {TEST_SERVICE_TOKEN}",
            TEST_SERVICE_TOKEN,  # raw token, no scheme
            f"bearer {TEST_SERVICE_TOKEN}",  # scheme is case-sensitive here
        ],
    )
    def test_a_malformed_or_wrong_bearer_is_refused(
        self, unauthenticated_client, pool_sentinel, header
    ):
        r = unauthenticated_client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
            headers={"Authorization": header},
        )
        assert r.status_code == 401
        assert r.json()["code"] == "UNAUTHORIZED"
        assert pool_sentinel == []

    def test_a_prefix_of_the_token_is_refused(self, unauthenticated_client, pool_sentinel):
        """Guards the constant-time compare's contract: no prefix match."""
        r = unauthenticated_client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
            headers={"Authorization": f"Bearer {TEST_SERVICE_TOKEN[:-1]}"},
        )
        assert r.status_code == 401
        assert pool_sentinel == []

    def test_the_comparison_is_constant_time(self, unauthenticated_client, monkeypatch):
        """Swapping `hmac.compare_digest` for `==` is FUNCTIONALLY invisible —
        both accept exactly the right token and reject everything else — so no
        assertion about status codes can catch it. Mutation-testing this file
        proved that: the `==` mutant survived every other test here.

        A timing side channel is not observable from a functional test either
        (wall-clock assertions are flaky by construction). So pin the mechanism
        instead: the gate must route its decision through `compare_digest`. A
        `==` rewrite makes this go red, which is the whole point.

        It matters because Ollama-style unauthenticated neighbours share this
        network: a caller that can time responses recovers the token a byte at
        a time from a short-circuiting compare.
        """
        import auth

        seen: list[tuple[str, str]] = []
        real = auth.hmac.compare_digest

        def spy(a, b):
            seen.append((a, b))
            return real(a, b)

        monkeypatch.setattr(auth.hmac, "compare_digest", spy)
        unauthenticated_client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
            headers={"Authorization": "Bearer not-the-token"},
        )
        assert seen, "the bearer check did not go through hmac.compare_digest"
        assert seen[0][0] == "Bearer not-the-token"
        assert seen[0][1] == f"Bearer {TEST_SERVICE_TOKEN}"


class TestGateAdmitsTheOrchestrator:
    """The other half of the mutation detector: the correct bearer gets through.

    Without these, deleting every route would also make the refusal tests pass.
    """

    def test_the_correct_bearer_reaches_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE"
        assert len(pool_sentinel) == 1

    def test_the_allowlist_still_runs_behind_the_gate(self, client, pool_sentinel):
        """Authenticating is not authorising a statement — WARP-2540 still bites."""
        r = client.post(
            "/read/get_patient",
            json={"sql": "SELECT * FROM patient", "params": [], "target": TARGET},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert pool_sentinel == []


class TestHealthIsExempt:
    """The compose healthcheck cannot hold a secret, so /health stays open.

    It reports reachability only — never a credential, never a row.
    """

    def test_health_answers_without_a_bearer(self, unauthenticated_client):
        r = unauthenticated_client.get("/health")
        assert r.status_code == 200
        assert "ok" in r.json()

    def test_health_body_carries_no_credential(self, unauthenticated_client):
        body = r"{}".format(unauthenticated_client.get("/health").text).lower()
        for leak in ("password", "pwd=", "uid=", "droplet_ro", "droplet_rw"):
            assert leak not in body


class TestUnprovisionedBridgeFailsClosed:
    """An empty SERVICE_TOKEN_ERP_BRIDGE is a misconfiguration, never a mode.

    This is the case that separates this service from inference-manager, whose
    empty token means permissive. Flip this branch to "allow anyway" and these
    two go red.
    """

    @pytest.fixture
    def unprovisioned_client(self, monkeypatch):
        import auth
        from fastapi.testclient import TestClient

        monkeypatch.setattr(auth, "SERVICE_TOKEN", "")
        main.POOL.close_all()
        with TestClient(main.app) as c:
            yield c
        main.POOL.close_all()

    def test_routes_answer_503_not_200_when_no_token_is_configured(
        self, unprovisioned_client, pool_sentinel
    ):
        r = unprovisioned_client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "BRIDGE_NOT_PROVISIONED"
        assert pool_sentinel == []

    def test_an_attacker_supplied_bearer_cannot_provision_the_bridge(
        self, unprovisioned_client, pool_sentinel
    ):
        """`hmac.compare_digest(header, "Bearer ")` must not be satisfiable by
        sending exactly that — the empty-token branch returns first."""
        r = unprovisioned_client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": TARGET},
            headers={"Authorization": "Bearer "},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "BRIDGE_NOT_PROVISIONED"
        assert pool_sentinel == []

    def test_health_still_answers_on_an_unprovisioned_bridge(self, unprovisioned_client):
        """Otherwise the container healthcheck would fail the box into a
        restart loop over a missing secret."""
        assert unprovisioned_client.get("/health").status_code == 200
