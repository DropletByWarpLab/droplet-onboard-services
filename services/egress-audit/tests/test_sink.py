"""WARP-268 — NDJSON day-file sink + orchestrator anomaly client."""
from __future__ import annotations

import io
import json
import urllib.error

from sink import NdjsonSink, OrchestratorClient

DAY1 = 1751600042.0   # 2025-07-04 UTC
DAY2 = DAY1 + 86400.0


class TestNdjsonSink:
    def test_writes_to_utc_day_file(self, tmp_path):
        sink = NdjsonSink(tmp_path, clock=lambda: DAY1)
        sink.write('{"a":1}')
        sink.write('{"b":2}')
        content = (tmp_path / "egress-20250704.ndjson").read_text()
        assert content == '{"a":1}\n{"b":2}\n'

    def test_rolls_to_new_day_file(self, tmp_path):
        now = [DAY1]
        sink = NdjsonSink(tmp_path, clock=lambda: now[0])
        sink.write('{"a":1}')
        now[0] = DAY2
        sink.write('{"b":2}')
        assert (tmp_path / "egress-20250704.ndjson").exists()
        assert (tmp_path / "egress-20250705.ndjson").exists()

    def test_prunes_beyond_retention(self, tmp_path):
        (tmp_path / "egress-20250101.ndjson").write_text("old\n")
        now = [DAY1]
        sink = NdjsonSink(tmp_path, clock=lambda: now[0], retention_days=30)
        sink.write('{"a":1}')          # prune runs on day-roll / first open
        assert not (tmp_path / "egress-20250101.ndjson").exists()


class _FakeResponse:
    status = 202
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class TestOrchestratorClient:
    def test_posts_bearer_and_json(self):
        seen = {}
        def opener(req, timeout):
            seen["url"] = req.full_url
            seen["auth"] = req.get_header("Authorization")
            seen["body"] = json.loads(req.data.decode())
            seen["timeout"] = timeout
            return _FakeResponse()
        client = OrchestratorClient("http://127.0.0.1:3000", "tok123", opener=opener)
        ok = client.post_anomaly({"kind": "unlisted_destination"})
        assert ok is True
        assert seen["url"] == "http://127.0.0.1:3000/api/security/egress-anomaly"
        assert seen["auth"] == "Bearer tok123"
        assert seen["body"] == {"kind": "unlisted_destination"}

    def test_outage_swallowed_and_recovers(self):
        calls = {"n": 0}
        def opener(req, timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.URLError("connection refused")
            return _FakeResponse()
        client = OrchestratorClient("http://127.0.0.1:3000", "tok", opener=opener)
        assert client.post_anomaly({}) is False
        assert client.post_anomaly({}) is False
        assert client.post_anomaly({}) is True

    def test_empty_token_never_posts(self):
        def opener(req, timeout):
            raise AssertionError("must not be called")
        client = OrchestratorClient("http://127.0.0.1:3000", "", opener=opener)
        assert client.post_anomaly({}) is False
