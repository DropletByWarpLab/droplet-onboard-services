import asyncio
import json

import pytest

from server import Server


class Engine:
    def __init__(self):
        self.received = None

    def transcribe(self, pcm):
        self.received = pcm
        return "Turn on the kitchen lights."


async def exchange(events):
    engine = Engine()
    server = await asyncio.start_server(Server(engine).handle, "127.0.0.1", 0, limit=8192)
    async with server:
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        for event, data, payload, framing in events:
            if framing == "v2":
                encoded = json.dumps(data).encode()
                header = {"type": event, "data_length": len(encoded), "payload_length": len(payload)}
            else:
                header = {"type": event, "data": data, "payload_length": len(payload)}
                encoded = b""
            writer.write(json.dumps(header).encode() + b"\n" + encoded + payload)
        await writer.drain()
        response = json.loads(await asyncio.wait_for(reader.readline(), 3))
        writer.close()
        await writer.wait_closed()
    return response, engine


@pytest.mark.parametrize("framing", ["v1", "v2"])
async def test_pcm_round_trip(framing):
    pcm = b"\x01\x00" * 1600
    response, engine = await exchange([
        ("transcribe", {"language": "en"}, b"", framing),
        ("audio-start", {"rate": 16000, "width": 2, "channels": 1}, b"", framing),
        ("audio-chunk", {}, pcm, framing),
        ("audio-stop", {}, b"", framing),
    ])
    assert response["type"] == "transcript"
    assert response["data"]["text"] == "Turn on the kitchen lights."
    assert engine.received == pcm


async def test_describe_advertises_installed_english_model():
    response, _ = await exchange([("describe", {}, b"", "v1")])
    assert response["type"] == "info"
    assert response["data"]["asr"][0]["models"][0]["languages"] == ["en"]


@pytest.mark.parametrize("rate,width,channels", [(6000, 2, 1), (16000, 4, 1), (16000, 2, 2)])
async def test_rejects_unsupported_audio(rate, width, channels):
    response, engine = await exchange([
        ("transcribe", {}, b"", "v1"),
        ("audio-start", {"rate": rate, "width": width, "channels": channels}, b"", "v1"),
    ])
    assert response["type"] == "error"
    assert engine.received is None


async def test_rejects_audio_over_limit_before_inference():
    events = [("transcribe", {}, b"", "v1"), ("audio-start", {"rate": 16000, "width": 2, "channels": 1}, b"", "v1")]
    events += [("audio-chunk", {}, bytes(32000), "v1")] * 31
    response, engine = await exchange(events)
    assert response["type"] == "error"
    assert engine.received is None


async def test_rejects_oversized_event_header_length():
    response, engine = await exchange([("transcribe", {}, bytes(65538), "v1")])
    assert response["type"] == "error"
    assert engine.received is None


@pytest.mark.parametrize("rate", [8000, 48000])
async def test_normalizes_bluetooth_and_full_rate_pcm(rate):
    response, engine = await exchange([
        ("transcribe", {}, b"", "v1"),
        ("audio-start", {"rate": rate, "width": 2, "channels": 1}, b"", "v1"),
        ("audio-chunk", {}, b"\x01\x00" * (rate // 10), "v1"),
        ("audio-stop", {}, b"", "v1"),
    ])
    assert response["type"] == "transcript"
    assert abs(len(engine.received) - 3200) <= 4


async def test_full_30_seconds_at_48khz_with_browser_chunks():
    events = [("transcribe", {}, b"", "v1"), ("audio-start", {"rate": 48000, "width": 2, "channels": 1}, b"", "v1")]
    events += [("audio-chunk", {}, bytes(2560), "v1")] * 1125
    events += [("audio-stop", {}, b"", "v1")]
    response, engine = await exchange(events)
    assert response["type"] == "transcript"
    assert len(engine.received) == 16000 * 2 * 30
