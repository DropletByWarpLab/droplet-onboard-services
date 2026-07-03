"""WARP-963 — agent-side error reporting to POST /agents/errors.

The reporter queues fingerprinted errors and a 5s apscheduler tick
drains them. Portal-transport failures never feed back into the queue
(no self-amplifying error loops)."""

from __future__ import annotations

import json

import httpx
import respx

from errors import ErrorReporter, fingerprint

from .conftest import PORTAL_URL, build_agent, register_response



def test_fingerprint_is_stable_and_normalized():
    a = fingerprint("fleet-agent", "Boom", "read failed at 0x1234")
    b = fingerprint("fleet-agent", "Boom", "read failed at 0x1234")
    assert a == b
    assert len(a) == 64  # sha256 hex


@respx.mock
async def test_errors_flush_posts_and_drains(env):
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )
    errs = respx.post(f"{PORTAL_URL}/agents/errors").mock(
        return_value=httpx.Response(
            200, json={"error_id": "err_1", "count": 1, "deduped": False}
        )
    )
    agent = build_agent(env)
    await agent.ensure_registered()
    agent.errors.report(
        severity="error",
        service="fleet-agent",
        title="collector failed",
        message="OSError: /proc unreadable",
    )
    await agent.errors_tick()
    assert errs.call_count == 1
    body = json.loads(errs.calls[0].request.content)
    assert body["severity"] == "error"
    assert body["fingerprint"] == fingerprint(
        "fleet-agent", "collector failed", "OSError: /proc unreadable"
    )
    # Drained: a second tick posts nothing.
    await agent.errors_tick()
    assert errs.call_count == 1


def test_reporter_queue_is_bounded():
    r = ErrorReporter(max_queue=3)
    for i in range(10):
        r.report(severity="error", service="s", title=f"t{i}", message="m")
    assert r.pending() == 3
