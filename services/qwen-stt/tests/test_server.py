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
    # WARP-3729: pins the shipped model so a stale 1.7B label cannot ship.
    assert response["data"]["asr"][0]["models"][0]["name"] == "qwen3-asr-0.6b"
    assert response["data"]["asr"][0]["version"] == "0.6B"


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


class BlockingEngine:
    """A decode that holds the slot until released, to drive the queue."""

    def __init__(self):
        import threading

        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = []

    def transcribe(self, pcm):
        self.calls.append(pcm)
        self.started.set()
        assert self.release.wait(5)
        return "queued transcript"


def transcribe_events(tag: bytes):
    return [
        ("transcribe", {"language": "en"}, b"", "v1"),
        ("audio-start", {"rate": 16000, "width": 2, "channels": 1}, b"", "v1"),
        ("audio-chunk", {}, tag * 800, "v1"),
        ("audio-stop", {}, b"", "v1"),
    ]


async def send_events(writer, events):
    for event, data, payload, _framing in events:
        header = {"type": event, "data": data, "payload_length": len(payload)}
        writer.write(json.dumps(header).encode() + b"\n" + payload)
    await writer.drain()


async def test_second_request_queues_behind_the_running_decode():
    # Appliance voice arriving a few seconds behind a dashboard dictation
    # must wait for the single decode slot, not fail the turn with busy.
    engine = BlockingEngine()
    service = Server(engine)
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0, limit=8192)
    async with server:
        port = server.sockets[0].getsockname()[1]
        first = await asyncio.open_connection("127.0.0.1", port)
        await send_events(first[1], transcribe_events(b"\x01\x00"))
        assert await asyncio.to_thread(engine.started.wait, 2)
        second = await asyncio.open_connection("127.0.0.1", port)
        await send_events(second[1], transcribe_events(b"\x02\x00"))
        await asyncio.sleep(0.05)
        assert service.busy
        assert len(engine.calls) == 1  # the second decode has not started
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(second[0].readline(), 0.1)  # still waiting, no error
        engine.release.set()
        for reader, writer in (first, second):
            response = json.loads(await asyncio.wait_for(reader.readline(), 3))
            assert response["type"] == "transcript"
            assert response["data"]["text"] == "queued transcript"
            writer.close()
            await writer.wait_closed()
    assert engine.calls == [b"\x01\x00" * 800, b"\x02\x00" * 800]
    assert not service.busy


async def test_queue_wait_is_bounded_and_answers_busy(monkeypatch):
    import server as server_mod

    monkeypatch.setattr(server_mod, "QUEUE_WAIT_S", 0.05)
    engine = BlockingEngine()
    service = Server(engine)
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0, limit=8192)
    async with server:
        port = server.sockets[0].getsockname()[1]
        first = await asyncio.open_connection("127.0.0.1", port)
        await send_events(first[1], transcribe_events(b"\x01\x00"))
        assert await asyncio.to_thread(engine.started.wait, 2)
        second = await asyncio.open_connection("127.0.0.1", port)
        await send_events(second[1], transcribe_events(b"\x02\x00"))
        response = json.loads(await asyncio.wait_for(second[0].readline(), 3))
        assert response["type"] == "error"
        assert response["data"]["code"] == "busy"
        engine.release.set()
        response = json.loads(await asyncio.wait_for(first[0].readline(), 3))
        assert response["type"] == "transcript"
        for _reader, writer in (first, second):
            writer.close()
            await writer.wait_closed()
    assert len(engine.calls) == 1


async def test_cancelled_request_keeps_the_slot_until_the_decode_returns():
    engine = BlockingEngine()
    service = Server(engine)
    task = asyncio.create_task(service.transcribe(b"\x01\x00"))
    assert await asyncio.to_thread(engine.started.wait, 2)
    task.cancel()
    await asyncio.sleep(0.01)
    assert not task.done()
    assert service.busy  # the worker thread is still inside the native call
    engine.release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not service.busy
