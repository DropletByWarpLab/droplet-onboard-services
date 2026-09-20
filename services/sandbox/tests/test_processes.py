"""The supervision seam (slice H) — gated off by default, real when on.

Off: every /processes route is 404 (undiscoverable). On: start a long-lived
child, read its state, stop it; the state is explicit, never inferred from a
missing pid.
"""

from __future__ import annotations

import sys
import time

import supervisor


def _wait_for(sup: supervisor.Supervisor, proc_id: str, states: set[str], timeout_s: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        st = sup.status(proc_id)
        if st and st["state"] in states:
            return st
        time.sleep(0.05)
    return sup.status(proc_id) or {}


def test_gated_off_by_default_every_route_is_404(client, auth, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", False)
    body = {"id": "ext-a", "argv": [sys.executable, "-c", "pass"]}
    assert client.post("/processes", json=body, headers=auth).status_code == 404
    assert client.get("/processes/ext-a", headers=auth).status_code == 404
    assert client.delete("/processes/ext-a", headers=auth).status_code == 404
    assert client.get("/health").json()["processes"] is False


def test_start_status_stop_when_enabled(client, auth, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    monkeypatch.setattr(supervisor, "SUPERVISOR", supervisor.Supervisor())
    body = {"id": "ext-b", "argv": [sys.executable, "-c", "import time; time.sleep(30)"], "restart": "never"}
    r = client.post("/processes", json=body, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "running"
    assert r.json()["pid"]

    assert client.post("/processes", json=body, headers=auth).status_code == 409

    assert client.get("/processes/ext-b", headers=auth).json()["state"] == "running"

    d = client.delete("/processes/ext-b", headers=auth).json()
    assert d["state"] == "stopped"
    assert client.get("/processes/nope", headers=auth).status_code == 404


def test_on_failure_restarts_up_to_the_budget_then_reports_failed():
    sup = supervisor.Supervisor()
    snap = sup.start(
        "ext-c", [sys.executable, "-c", "raise SystemExit(3)"], cwd=None, restart="on-failure", max_restarts=2, env={}
    )
    assert snap["id"] == "ext-c"
    st = _wait_for(sup, "ext-c", {"failed"})
    assert st["state"] == "failed"
    assert st["restarts"] == 2
    assert st["exitCode"] == 3


def test_a_clean_exit_with_never_is_exited_not_failed():
    sup = supervisor.Supervisor()
    sup.start("ext-d", [sys.executable, "-c", "pass"], cwd=None, restart="never", max_restarts=3, env={})
    assert _wait_for(sup, "ext-d", {"exited", "failed"})["state"] == "exited"
