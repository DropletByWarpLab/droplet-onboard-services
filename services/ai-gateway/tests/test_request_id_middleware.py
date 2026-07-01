import pytest


@pytest.mark.anyio
async def test_response_echoes_generated_id(client):
    r = await client.get("/ai/health")
    rid = r.headers.get("x-request-id")
    assert rid is not None and len(rid) >= 8


@pytest.mark.anyio
async def test_adopts_valid_inbound_id(client):
    r = await client.get("/ai/health", headers={"x-request-id": "inbound_valid_1"})
    assert r.headers.get("x-request-id") == "inbound_valid_1"


@pytest.mark.anyio
async def test_regenerates_invalid_inbound_id(client):
    r = await client.get("/ai/health", headers={"x-request-id": "bad id!"})
    assert r.headers.get("x-request-id") != "bad id!"
    assert r.headers.get("x-request-id") is not None
