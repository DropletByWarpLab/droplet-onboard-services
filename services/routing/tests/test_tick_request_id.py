import pytest

import scheduler
from request_context import request_id_var, get_request_id


@pytest.mark.asyncio
async def test_throughput_tick_sets_request_id(monkeypatch):
    request_id_var.set(None)
    seen = {}

    # Stub the inner steps so _tick reaches _post_sample quickly.
    monkeypatch.setattr(scheduler, "_resolve_wan_device", lambda r: "eth0")
    monkeypatch.setattr(scheduler, "_read_counters", lambda r, d: (1, 2))
    monkeypatch.setattr(scheduler, "_derive_bps", lambda a, b: (10, 20))
    scheduler._previous = (0, 0)  # already primed so it emits a sample

    async def fake_post_sample(down, up):
        seen["rid"] = get_request_id()

    monkeypatch.setattr(scheduler, "_post_sample", fake_post_sample)

    await scheduler._tick(object())
    assert seen.get("rid") is not None and len(seen["rid"]) >= 8
