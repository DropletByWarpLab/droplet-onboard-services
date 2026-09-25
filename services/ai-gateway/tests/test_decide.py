"""WARP-3070 — Decide gRPC handler (Kev decision model via the ai-gateway).

Uses the REAL committed grpc_generated stubs (other suites install fakes in
sys.modules, so the fixture swaps the real ones in and restores afterwards)
and respx for the sidecar's HTTP. Every failure mode must come back as a
DecideStatus, never as a gRPC error code.
"""

from __future__ import annotations

import importlib
import json
import sys
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

_MODS = ("grpc_generated", "grpc_generated.inference_pb2", "grpc_generated.inference_pb2_grpc", "grpc_server")
URL = "http://decision-model.test:8009"


@pytest.fixture
def gw(monkeypatch):
    saved = {k: sys.modules.pop(k) for k in _MODS if k in sys.modules}
    try:
        server = importlib.import_module("grpc_server")
        monkeypatch.setenv("DECISION_MODEL_URL", URL)
        monkeypatch.setenv("DECISION_MODEL_API_KEY", "k-secret")
        yield server, server.inference_pb2
    finally:
        for k in _MODS:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _servicer(server):
    return server.InferenceServicer(MagicMock(), MagicMock(enqueue=AsyncMock(), release=AsyncMock()))


def _request(pb2, timeout_ms=0):
    return pb2.DecideRequest(
        state="The front door camera has been offline since 7am.",
        timeout_ms=timeout_ms,
        questions={
            "urgent": pb2.DecideQuestion(
                type=pb2.DECIDE_QUESTION_TYPE_NOUL, instructions="Needs attention today?",
                true_description="yes, today",
            ),
            "domain": pb2.DecideQuestion(
                type=pb2.DECIDE_QUESTION_TYPE_CHOICE, instructions="Which area?",
                options=[
                    pb2.DecideOption(name="network", description="LAN and Wi-Fi"),
                    pb2.DecideOption(name="cameras"),
                    pb2.DecideOption(name="files"),
                ],
            ),
            "severity": pb2.DecideQuestion(
                type=pb2.DECIDE_QUESTION_TYPE_SCORE, instructions="How severe?",
                levels=["minor", "degraded", "outage"],
            ),
        },
    )


async def _call(server, req):
    ctx = MagicMock()
    resp = await _servicer(server).Decide(req, ctx)
    ctx.set_code.assert_not_called()  # fail soft as data, never a gRPC error
    return resp


async def test_unset_url_is_unavailable_without_network(gw, monkeypatch):
    server, pb2 = gw
    monkeypatch.setenv("DECISION_MODEL_URL", "")
    with respx.mock(assert_all_called=False) as mock:
        route = mock.route()
        resp = await _call(server, _request(pb2))
    assert not route.called
    assert resp.status == pb2.DECIDE_STATUS_UNAVAILABLE
    assert resp.detail == "decision-model not configured"


@respx.mock
async def test_ok_maps_all_three_types_and_keeps_option_order(gw):
    server, pb2 = gw
    route = respx.post(f"{URL}/v1/systemone").respond(200, json={
        "model": "kev-latest",
        "answers": {
            "urgent": {"type": "noul", "noul": 0.91},
            "domain": {"type": "choice", "choice": "cameras", "confidence": 0.8,
                       "probabilities": {"network": 0.1, "cameras": 0.85, "files": 0.05}},
            "severity": {"type": "score", "score": 1.6, "confidence": 0.5,
                         "legend": {"0": "minor", "1": "degraded", "2": "outage"},
                         "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7}},
        },
        "usage": {"input_tokens": 40}, "latency_ms": 37.5,
    })
    resp = await _call(server, _request(pb2))

    sent = route.calls.last.request
    assert sent.headers["authorization"] == "Bearer k-secret"
    body = json.loads(sent.content)
    assert body["model"] == "kev-latest"
    assert list(body["questions"]["domain"]["criteria"].items()) == [
        ("network", "LAN and Wi-Fi"), ("cameras", None), ("files", None)]
    assert body["questions"]["urgent"]["criteria"] == {"true": "yes, today"}
    assert body["questions"]["severity"]["criteria"] == ["minor", "degraded", "outage"]

    assert resp.status == pb2.DECIDE_STATUS_OK
    assert resp.model == "kev-latest" and resp.latency_ms == pytest.approx(37.5)
    a = resp.answers
    assert a["urgent"].type == pb2.DECIDE_QUESTION_TYPE_NOUL and a["urgent"].noul == pytest.approx(0.91)
    assert a["domain"].choice == "cameras" and a["domain"].confidence == pytest.approx(0.8)
    assert a["domain"].probabilities["cameras"] == pytest.approx(0.85)
    assert a["severity"].score == pytest.approx(1.6)
    assert a["severity"].legend["2"] == "outage"
    assert a["severity"].probabilities["2"] == pytest.approx(0.7)


@respx.mock
async def test_422_is_invalid_without_echoing_input(gw):
    server, pb2 = gw
    respx.post(f"{URL}/v1/systemone").respond(422, json={"detail": [
        {"loc": ["body", "questions", "domain"], "msg": "too many options", "input": "SECRET STATE"}]})
    resp = await _call(server, _request(pb2))
    assert resp.status == pb2.DECIDE_STATUS_INVALID
    assert "too many options" in resp.detail and "SECRET" not in resp.detail


@respx.mock
async def test_timeout_is_unavailable(gw):
    server, pb2 = gw
    respx.post(f"{URL}/v1/systemone").mock(side_effect=httpx.ReadTimeout("slow"))
    resp = await _call(server, _request(pb2, timeout_ms=150))
    assert resp.status == pb2.DECIDE_STATUS_UNAVAILABLE
    assert resp.detail == "timeout after 150 ms"


@respx.mock
async def test_401_is_unavailable(gw):
    server, pb2 = gw
    respx.post(f"{URL}/v1/systemone").respond(401, json={"detail": "bad key"})
    resp = await _call(server, _request(pb2))
    assert resp.status == pb2.DECIDE_STATUS_UNAVAILABLE and "401" in resp.detail


@respx.mock
async def test_5xx_and_connection_error_are_unavailable(gw):
    server, pb2 = gw
    respx.post(f"{URL}/v1/systemone").respond(503)
    assert (await _call(server, _request(pb2))).status == pb2.DECIDE_STATUS_UNAVAILABLE
    respx.post(f"{URL}/v1/systemone").mock(side_effect=httpx.ConnectError("refused"))
    assert (await _call(server, _request(pb2))).status == pb2.DECIDE_STATUS_UNAVAILABLE


async def test_unspecified_question_type_is_invalid_without_network(gw):
    server, pb2 = gw
    req = pb2.DecideRequest(state="x", questions={"q": pb2.DecideQuestion(instructions="?")})
    with respx.mock(assert_all_called=False) as mock:
        route = mock.route()
        resp = await _call(server, req)
    assert not route.called
    assert resp.status == pb2.DECIDE_STATUS_INVALID
