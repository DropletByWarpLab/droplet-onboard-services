"""WARP-963 — register-once semantics against a mocked portal."""

from __future__ import annotations

import asyncio
import json

import httpx
import respx

from .conftest import PORTAL_URL, build_agent, register_response



@respx.mock
async def test_register_once_persists_token(env, state_dir):
    route = respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )
    agent = build_agent(env)

    assert await agent.ensure_registered() is True
    assert route.call_count == 1

    # Provisioning headers went out; body carried the required fields.
    req = route.calls[0].request
    assert req.headers["X-Provisioning-Code"] == "prov-code-123"
    assert req.headers["X-Droplet-FW"] == "0.9.3+pytest"
    body = json.loads(req.content)
    assert body["hostname"] == "droplet-pytest"
    assert body["tier"] in ("home", "business", "enterprise")
    assert body["firmware_version"] == "0.9.3+pytest"

    # Token persisted to the runtime state dir (never tracked).
    identity_file = state_dir / "identity.json"
    assert identity_file.exists()
    stored = json.loads(identity_file.read_text())
    assert stored["ingest_token"] == "dpl_01J9MZTEST_secret"
    assert stored["machine_id"] == "01J9MZTEST"

    # Second call is a no-op — /agents/register is one-time.
    assert await agent.ensure_registered() is True
    assert route.call_count == 1


@respx.mock
async def test_register_survives_portal_down(env):
    """Portal unreachable at first boot → no crash, retried next call."""
    route = respx.post(f"{PORTAL_URL}/agents/register").mock(
        side_effect=httpx.ConnectError("portal down")
    )
    agent = build_agent(env)
    assert await agent.ensure_registered() is False

    # Portal comes back → registration succeeds on a later attempt.
    route.mock(return_value=httpx.Response(201, json=register_response()))
    assert await agent.ensure_registered() is True


@respx.mock
async def test_concurrent_ticks_register_exactly_once(env):
    """Boot-time alignment: the errors (5s) / commands (15s) / heartbeat
    (30s) ticks can all await ensure_registered() in the same event-loop
    slice. The provisioning code is single-use and the portal's
    consumption check is racy under concurrency — the agent must
    serialize registration so exactly ONE POST /agents/register ever
    leaves the box, and the losers adopt the winner's identity instead
    of burning the code (or logging a false 'code consumed' error)."""
    route = respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )
    agent = build_agent(env)

    # Hold the in-flight register across an event-loop tick so the three
    # callers genuinely overlap (a respx-mocked request can resolve
    # without ever yielding control).
    real_register = agent.portal.register

    async def slow_register(code, payload):
        await asyncio.sleep(0.02)
        return await real_register(code, payload)

    agent.portal.register = slow_register

    results = await asyncio.gather(
        agent.ensure_registered(),
        agent.ensure_registered(),
        agent.ensure_registered(),
    )

    assert results == [True, True, True]
    assert route.call_count == 1


@respx.mock
async def test_register_consumed_code_gives_up_without_crash(env):
    """409 = provisioning code already consumed. Unrecoverable — the agent
    logs and stops hammering the endpoint (fail-open, never crash-loop)."""
    route = respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(
            409,
            json={"error": {"code": "CODE_CONSUMED", "message": "already used"}},
        )
    )
    agent = build_agent(env)
    assert await agent.ensure_registered() is False
    assert await agent.ensure_registered() is False
    assert route.call_count == 1  # second attempt short-circuits
