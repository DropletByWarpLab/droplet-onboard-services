"""WARP-963 — the agent may NEVER degrade the box. Every tick swallows
and logs every exception class it can meet: collector reads, transport
errors, server 5xx, scheduler wiring."""

from __future__ import annotations

import httpx
import respx

from .conftest import PORTAL_URL, RaisingCollector, build_agent, register_response



def _register_ok() -> None:
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )


@respx.mock
async def test_collector_exception_never_escapes(env):
    _register_ok()
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(204)
    )
    agent = build_agent(env, RaisingCollector())
    await agent.ensure_registered()
    await agent.heartbeat_tick()  # collector raises OSError inside
    assert hb.call_count == 0  # nothing sent, nothing raised


@respx.mock
async def test_server_500_everywhere_never_crashes(env):
    _register_ok()
    for path in ("heartbeat", "metrics", "inventory", "network"):
        respx.post(f"{PORTAL_URL}/agents/{path}").mock(
            return_value=httpx.Response(500, json={"error": {"code": "BOOM", "message": "x"}})
        )
    respx.get(f"{PORTAL_URL}/agents/commands/poll").mock(
        return_value=httpx.Response(500, json={"error": {"code": "BOOM", "message": "x"}})
    )
    agent = build_agent(env)
    await agent.ensure_registered()
    await agent.heartbeat_tick()
    await agent.metrics_tick()
    await agent.inventory_tick()
    await agent.network_tick()
    await agent.commands_tick()
    # Reaching this line = nothing raised.


@respx.mock
async def test_unregistered_ticks_are_noops_not_crashes(env):
    """Portal down at registration time: every telemetry tick short-circuits
    quietly (heartbeats spool) instead of raising on a missing token."""
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        side_effect=httpx.ConnectError("portal down")
    )
    agent = build_agent(env)
    await agent.ensure_registered()
    await agent.heartbeat_tick()
    await agent.metrics_tick()
    await agent.commands_tick()
    # heartbeat spooled for replay after registration eventually succeeds
    assert agent.spool.entry_count() == 1


def test_scheduler_uses_apscheduler_interval_jobs(env):
    """No hand-rolled while-True loops: every cadence is an apscheduler
    interval job with max_instances=1 (architecture-guard rule 9)."""
    agent = build_agent(env)
    scheduler = agent.build_scheduler()
    try:
        jobs = {j.id: j for j in scheduler.get_jobs()}
        expected = {
            "warp-963-heartbeat": 30,
            "warp-963-metrics": 60,
            "warp-963-errors": 5,
            "warp-963-inventory": 6 * 3600,
            "warp-963-network": 300,
            "warp-963-commands": 15,
        }
        assert set(jobs) == set(expected)
        for job_id, seconds in expected.items():
            assert jobs[job_id].trigger.interval.total_seconds() == seconds, job_id
            assert jobs[job_id].max_instances == 1
    finally:
        if scheduler.running:  # never started in this test — guard shutdown
            scheduler.shutdown(wait=False)
