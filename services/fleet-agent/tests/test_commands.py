"""WARP-963 — v1 answers EVERY portal command with an explicit
"unsupported" result. No ssh tunnels, no container restarts, no action
of any kind is taken on the box."""

from __future__ import annotations

import json

import httpx
import respx

from .conftest import PORTAL_URL, build_agent, register_response



def _register_ok() -> None:
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )


def _command(cmd_id: str, cmd_type: str) -> dict:
    return {
        "id": cmd_id,
        "type": cmd_type,
        "issued_at": "2026-07-01T10:00:00Z",
        "expires_at": "2026-07-01T10:05:00Z",
        "payload": {"relay_host": "relay.example", "relay_port": 49100},
    }


@respx.mock
async def test_every_command_type_gets_unsupported_result(env):
    _register_ok()
    poll = respx.get(f"{PORTAL_URL}/agents/commands/poll").mock(
        return_value=httpx.Response(
            200,
            json={
                "commands": [
                    _command("cmd_1", "ssh.tunnel.open"),
                    _command("cmd_2", "container.restart"),
                    _command("cmd_3", "diagnostic.run"),
                ]
            },
        )
    )
    results = {
        cmd_id: respx.post(f"{PORTAL_URL}/agents/commands/{cmd_id}/result").mock(
            return_value=httpx.Response(204)
        )
        for cmd_id in ("cmd_1", "cmd_2", "cmd_3")
    }

    agent = build_agent(env)
    await agent.ensure_registered()
    await agent.commands_tick()

    # Long-poll used the contract's wait parameter.
    assert poll.calls[0].request.url.params["wait"] == "25"

    for cmd_id, route in results.items():
        assert route.call_count == 1, f"{cmd_id} got no result POST"
        body = json.loads(route.calls[0].request.content)
        assert body["status"] == "error"
        assert "unsupported" in body["stderr"].lower()
        assert body["started_at"] and body["finished_at"]
        assert body["data"]["unsupported"] is True


@respx.mock
async def test_empty_poll_is_quiet(env):
    _register_ok()
    respx.get(f"{PORTAL_URL}/agents/commands/poll").mock(
        return_value=httpx.Response(200, json={"commands": []})
    )
    agent = build_agent(env)
    await agent.ensure_registered()
    await agent.commands_tick()  # no result POSTs, no exception


@respx.mock
async def test_poll_failure_is_fail_open(env):
    _register_ok()
    respx.get(f"{PORTAL_URL}/agents/commands/poll").mock(
        side_effect=httpx.ConnectError("portal down")
    )
    agent = build_agent(env)
    await agent.ensure_registered()
    await agent.commands_tick()  # swallowed + logged, never raises
