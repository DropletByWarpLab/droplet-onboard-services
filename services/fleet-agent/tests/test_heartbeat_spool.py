"""WARP-963 — heartbeat delivery, disk spool + replay, 429 backoff, geo."""

from __future__ import annotations

import json

import httpx
import respx

from spool import DiskSpool

from .conftest import PORTAL_URL, build_agent, register_response



def _register_ok() -> None:
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )


@respx.mock
async def test_heartbeat_posts_with_contract_headers(env, collector):
    _register_ok()
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(204)
    )
    agent = build_agent(env, collector)
    await agent.ensure_registered()
    await agent.heartbeat_tick()

    assert hb.call_count == 1
    req = hb.calls[0].request
    assert req.headers["Authorization"] == "Bearer dpl_01J9MZTEST_secret"
    assert req.headers["X-Droplet-Id"] == "01J9MZTEST"
    assert req.headers["X-Droplet-FW"] == "0.9.3+pytest"
    assert req.headers["X-Idempotency-Key"]  # UUIDv4 picked by the client
    body = json.loads(req.content)
    for field in ("ts", "uptime_s", "load", "cpu_pct", "ram"):
        assert field in body
    # No geo configured → the fields are ABSENT, not null/empty ("" 422s).
    assert "geoCountry" not in body
    assert "geoRegion" not in body


@respx.mock
async def test_heartbeat_includes_canonicalized_geo_when_configured(env, collector):
    e = dict(env)
    e["DROPLET_TELEMETRY_GEO_COUNTRY"] = "de"
    e["DROPLET_TELEMETRY_GEO_REGION"] = "eu-central-1"
    _register_ok()
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(204)
    )
    agent = build_agent(e, collector)
    await agent.ensure_registered()
    await agent.heartbeat_tick()
    body = json.loads(hb.calls[0].request.content)
    assert body["geoCountry"] == "DE"
    assert body["geoRegion"] == "eu-central-1"


@respx.mock
async def test_portal_down_spools_and_replays(env, state_dir, collector):
    """Portal down ⇒ no crash, heartbeats spool to disk; portal back up ⇒
    spool replays oldest-first before the current beat (idempotent on
    (machine_id, ts) server-side, so replays are safe)."""
    _register_ok()
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        side_effect=httpx.ConnectError("portal down")
    )
    agent = build_agent(env, collector)
    await agent.ensure_registered()

    # Three failed ticks → three spooled beats, zero exceptions.
    await agent.heartbeat_tick()
    await agent.heartbeat_tick()
    await agent.heartbeat_tick()
    spool_file = state_dir / "heartbeat-spool.jsonl"
    assert spool_file.exists()
    spooled = [json.loads(line) for line in spool_file.read_text().splitlines()]
    assert len(spooled) == 3

    # Portal recovers → next tick replays the 3 spooled + sends the live one.
    hb.mock(return_value=httpx.Response(204))
    await agent.heartbeat_tick()
    assert hb.call_count == 3 + 4  # 3 failed attempts + 3 replays + 1 live
    sent_ts = [
        json.loads(c.request.content)["uptime_s"] for c in hb.calls[3:]
    ]
    assert sent_ts == sorted(sent_ts)  # oldest-first replay
    assert spool_file.read_text().strip() == ""  # drained


@respx.mock
async def test_spool_is_bounded_on_disk(env, state_dir, collector):
    """The spool never grows past its bound — oldest entries drop."""
    e = dict(env)
    e["DROPLET_TELEMETRY_SPOOL_MAX"] = "5"
    _register_ok()
    respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        side_effect=httpx.ConnectError("portal down")
    )
    agent = build_agent(e, collector)
    await agent.ensure_registered()
    for _ in range(12):
        await agent.heartbeat_tick()
    spool_file = state_dir / "heartbeat-spool.jsonl"
    lines = [l for l in spool_file.read_text().splitlines() if l.strip()]
    assert len(lines) == 5
    # The five NEWEST beats survived (uptime_s increments per tick).
    kept = [json.loads(l)["uptime_s"] for l in lines]
    assert kept == sorted(kept)
    assert kept[-1] - kept[0] == 4


@respx.mock
async def test_422_is_dropped_not_spooled(env, collector):
    """A validation reject is a poison pill — replaying it forever would
    wedge the spool. Log + drop."""
    _register_ok()
    respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(
            422,
            json={"error": {"code": "VALIDATION_FAILED", "message": "bad"}},
        )
    )
    agent = build_agent(env, collector)
    await agent.ensure_registered()
    await agent.heartbeat_tick()
    assert agent.spool.entry_count() == 0


@respx.mock
async def test_429_retry_after_is_honored(env, collector):
    """429 + Retry-After ⇒ the endpoint backs off; the beat spools for
    replay instead of hammering."""
    _register_ok()
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(
            429,
            headers={"Retry-After": "3600"},
            json={"error": {"code": "RATE_LIMITED", "message": "slow down"}},
        )
    )
    agent = build_agent(env, collector)
    await agent.ensure_registered()
    await agent.heartbeat_tick()
    assert hb.call_count == 1
    assert agent.spool.entry_count() == 1

    # Within the Retry-After window the client does not even dial out.
    await agent.heartbeat_tick()
    assert hb.call_count == 1
    assert agent.spool.entry_count() == 2


class TestDiskSpool:
    def test_corrupt_lines_are_skipped(self, tmp_path):
        p = tmp_path / "spool.jsonl"
        p.write_text('{"ok": 1}\nnot-json\n{"ok": 2}\n')
        spool = DiskSpool(p, max_entries=10)
        assert [e["ok"] for e in spool.entries()] == [1, 2]

    def test_append_bounds(self, tmp_path):
        spool = DiskSpool(tmp_path / "spool.jsonl", max_entries=3)
        for i in range(5):
            spool.append({"i": i})
        assert [e["i"] for e in spool.entries()] == [2, 3, 4]
