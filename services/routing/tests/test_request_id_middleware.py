def test_health_echoes_request_id(connected_client):
    r = connected_client.get("/health")
    assert r.headers.get("x-request-id") is not None


def test_adopts_valid_inbound(connected_client):
    r = connected_client.get("/health", headers={"x-request-id": "inbound_ok_1"})
    assert r.headers.get("x-request-id") == "inbound_ok_1"


def test_regenerates_invalid_inbound(connected_client):
    r = connected_client.get("/health", headers={"x-request-id": "bad id!"})
    assert r.headers.get("x-request-id") not in (None, "bad id!")
