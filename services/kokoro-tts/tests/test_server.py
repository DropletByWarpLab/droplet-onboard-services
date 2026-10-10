"""Regression tests through a real TCP socket; no speech-model downloads."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from runtime import KokoroEngine, create_cpu_session, split_text


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.fail = False

    async def stream(self, text, voice):
        self.calls.append((text, voice))
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("private spoken text")
        yield b"\x01\x00" * 7000
        yield b"\x02\x00" * 12000


async def read(reader):
    line = await asyncio.wait_for(reader.readline(), 2)
    if not line:
        return None, b""
    header = json.loads(line)
    pcm = await reader.readexactly(header.get("payload_length", 0))
    return header, pcm


class TcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = FakeEngine()
        self.service = server.WyomingServer(self.engine)
        self.listener = await asyncio.start_server(self.service.handle, "127.0.0.1", 0, limit=server.MAX_EVENT_BYTES)
        self.port = self.listener.sockets[0].getsockname()[1]
        self.clients = []

    async def asyncTearDown(self):
        self.engine.release.set()
        for _, writer in self.clients:
            writer.close()
            await writer.wait_closed()
        self.listener.close()
        await self.listener.wait_closed()

    async def connect(self):
        client = await asyncio.open_connection("127.0.0.1", self.port)
        self.clients.append(client)
        return client

    async def send(self, writer, kind, data=None):
        writer.write(json.dumps({"type": kind, "data": data, "payload_length": 0}).encode() + b"\n")
        await writer.drain()

    async def assert_error_closed(self, reader, code):
        event, _ = await read(reader)
        self.assertEqual(event["type"], "error")
        self.assertEqual(event["data"]["code"], code)
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")

    async def test_catalog_and_selected_voice_pcm(self):
        reader, writer = await self.connect()
        await self.send(writer, "describe")
        event, _ = await read(reader)
        self.assertEqual(event["type"], "info")
        program = event["data"]["tts"][0]
        self.assertEqual(program["name"], "kokoro")
        self.assertEqual(program["default_voice"], "af_heart")
        self.assertEqual({v["name"] for v in program["voices"]}, server.VOICE_NAMES)
        self.assertTrue(all(v["installed"] and v["attribution"] for v in program["voices"]))
        await self.send(writer, "synthesize", {"text": "Hello", "voice": {"name": "bf_emma"}})
        first, _ = await read(reader)
        self.assertEqual(first["type"], "audio-start")
        self.assertEqual(first["data"], {"rate": 24000, "width": 2, "channels": 1})
        audio = b""
        while True:
            event, pcm = await read(reader)
            if event["type"] == "audio-stop":
                break
            self.assertEqual(event["type"], "audio-chunk")
            self.assertLessEqual(len(pcm), server.PCM_CHUNK_BYTES)
            audio += pcm
        self.assertEqual(audio, b"\x01\x00" * 7000 + b"\x02\x00" * 12000)
        self.assertEqual(self.engine.calls, [("Hello", "bf_emma")])

    async def test_separate_data_encoding_and_default(self):
        reader, writer = await self.connect()
        body = json.dumps({"text": "Hi"}).encode()
        writer.write(json.dumps({"type": "synthesize", "data_length": len(body)}).encode() + b"\n" + body)
        await writer.drain()
        while (await read(reader))[0]["type"] != "audio-stop":
            pass
        self.assertEqual(self.engine.calls, [("Hi", "af_heart")])

    async def test_unknown_voice_and_bad_text_never_infer(self):
        for data, code in [
            ({"text": "Hi", "voice": {"name": "missing"}}, "invalid-voice"),
            ({"text": "Hi", "voice": "af_heart"}, "invalid-voice"),
            ({"text": " "}, "invalid-text"),
            ({"text": "x" * (server.MAX_TEXT_CHARS + 1)}, "invalid-text"),
        ]:
            reader, writer = await self.connect()
            await self.send(writer, "synthesize", data)
            await self.assert_error_closed(reader, code)
        self.assertEqual(self.engine.calls, [])

    async def test_malformed_lengths_and_oversized_header(self):
        for wire in [
            b'not json\n', b'[]\n',
            b'{"type":"synthesize","data_length":-1}\n',
            b'{"type":"synthesize","data_length":999999999}\n',
            b'{"type":"synthesize","payload_length":999999999}\n',
            b'{"type":"synthesize","data":[]}\n',
            b'x' * (server.MAX_EVENT_BYTES + 1) + b'\n',
        ]:
            reader, writer = await self.connect()
            writer.write(wire)
            await writer.drain()
            await self.assert_error_closed(reader, "invalid-request")
        self.assertEqual(self.engine.calls, [])

    async def test_second_synthesis_queues_behind_the_first(self):
        # A cue pre-synthesis racing a reply (or a preview landing
        # mid-sentence) waits for the single slot instead of failing the
        # caller's turn; describe keeps answering meanwhile.
        self.engine.release.clear()
        first_reader, first_writer = await self.connect()
        await self.send(first_writer, "synthesize", {"text": "First"})
        await asyncio.wait_for(self.engine.started.wait(), 2)
        reader, writer = await self.connect()
        await self.send(writer, "synthesize", {"text": "Second"})
        await asyncio.sleep(0.05)
        self.assertTrue(self.service.synthesizing)
        self.assertEqual(self.engine.calls, [("First", "af_heart")])  # queued, not started
        probe_reader, probe_writer = await self.connect()
        await self.send(probe_writer, "describe")
        self.assertEqual((await read(probe_reader))[0]["type"], "info")
        self.engine.release.set()
        while (await read(first_reader))[0]["type"] != "audio-stop":
            pass
        while (await read(reader))[0]["type"] != "audio-stop":
            pass
        self.assertEqual(self.engine.calls, [("First", "af_heart"), ("Second", "af_heart")])
        self.assertFalse(self.service.synthesizing)

    async def test_queue_wait_is_bounded_and_answers_busy(self):
        self.engine.release.clear()
        first_reader, first_writer = await self.connect()
        await self.send(first_writer, "synthesize", {"text": "First"})
        await asyncio.wait_for(self.engine.started.wait(), 2)
        with patch.object(server, "SYNTH_QUEUE_WAIT_S", 0.05):
            reader, writer = await self.connect()
            await self.send(writer, "synthesize", {"text": "Second"})
            await self.assert_error_closed(reader, "busy")
        self.engine.release.set()
        while (await read(first_reader))[0]["type"] != "audio-stop":
            pass
        self.assertEqual(self.engine.calls, [("First", "af_heart")])

    async def test_model_failure_closes_without_success_or_private_error(self):
        self.engine.fail = True
        reader, writer = await self.connect()
        await self.send(writer, "synthesize", {"text": "Hi"})
        with self.assertLogs("kokoro-tts", level="ERROR"):
            event, _ = await read(reader)
        self.assertEqual(event["type"], "error")
        self.assertNotIn("private", json.dumps(event))
        self.assertEqual(await reader.read(), b"")
        self.assertFalse(self.service.synthesizing)

    async def test_connection_budget_and_read_timeout(self):
        with patch.object(server, "MAX_CONNECTIONS", 1):
            await self.connect()
            reader, _ = await self.connect()
            await self.assert_error_closed(reader, "busy")
        with patch.object(server, "IO_TIMEOUT", 0.02):
            reader, writer = await self.connect()
            writer.write(b'{"type":')
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")


class ProviderTests(unittest.TestCase):
    def test_cpu_provider_is_explicit_and_acceleration_is_rejected(self):
        calls = []
        session = SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"])
        ort = SimpleNamespace(
            disable_telemetry_events=lambda: None,
            SessionOptions=SimpleNamespace,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL=1),
            InferenceSession=lambda *args, **kwargs: (calls.append((args, kwargs)) or session),
        )
        with patch.dict(sys.modules, {"onnxruntime": ort}):
            self.assertIs(create_cpu_session(Path("model.onnx"), 2), session)
            self.assertEqual(calls[0][1]["providers"], ["CPUExecutionProvider"])
            self.assertEqual(calls[0][1]["sess_options"].intra_op_num_threads, 2)
            session.get_providers = lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"]
            with self.assertRaisesRegex(RuntimeError, "exclusively"):
                create_cpu_session(Path("model.onnx"), 2)

    def test_sentence_and_long_word_batches_are_bounded(self):
        text = "Hello Droplet. " + "longword" * 200
        batches = list(split_text(text))
        self.assertEqual(batches[0], "Hello Droplet.")
        self.assertTrue(all(0 < len(batch) <= 300 for batch in batches))
        self.assertEqual("".join(batches[1:]), "longword" * 200)

    def test_invalid_default_voice_fails_startup(self):
        with self.assertRaises(ValueError):
            server.WyomingServer(None, "en_US-ryan-medium")


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_keeps_slot_until_running_cpu_batch_finishes(self):
        started, release = threading.Event(), threading.Event()
        engine = KokoroEngine.__new__(KokoroEngine)
        engine.executor = ThreadPoolExecutor(max_workers=1)

        def create_pcm(text, voice):
            started.set()
            if not release.wait(2):
                raise TimeoutError("test worker was not released")
            return b"\x01\x00"

        engine._create_pcm = create_pcm
        service = server.WyomingServer(engine)
        task = asyncio.create_task(service.synthesize({"text": "Hi"}, None))
        try:
            await asyncio.to_thread(started.wait, 2)
            self.assertTrue(started.is_set())
            task.cancel()
            # Give cancellation a full event-loop turn to reach the running worker.
            await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            self.assertTrue(service.synthesizing)
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(service.synthesizing)
        finally:
            release.set()
            engine.close()


if __name__ == "__main__":
    unittest.main()
