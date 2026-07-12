"""WARP-1057 — XVF3800 DSP restart: voice/dsp.py + the
POST /voice/restart-processor endpoint.

The xvf_host call is always mocked (no XMOS hardware in CI); the seam is
`restart_dsp(run=...)` for the module tests and `main.restart_dsp` for
the endpoint tests. Hardware verification is deferred to the WARP-1001
release-smoke walkthrough.
"""
from __future__ import annotations

import os
import stat
import subprocess

import pytest
from fastapi.testclient import TestClient

import main
from voice import dsp
from voice.dsp import DspRestartError, restart_dsp


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_xvf_host(tmp_path, monkeypatch):
    """An executable stand-in binary so the isfile/X_OK gate passes."""
    path = tmp_path / "xvf_host"
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("XVF_HOST_PATH", str(path))
    return path


def completed(returncode: int = 0, stderr: str = "", stdout: str = ""):
    return subprocess.CompletedProcess(
        args=["xvf_host", "REBOOT", "1"],
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
    )


# ────────────────────────────────────────────────────────────────────
# voice/dsp.py — the subprocess contract
# ────────────────────────────────────────────────────────────────────

class TestRestartDsp:
    def test_success_runs_the_watchdogs_exact_command(self, fake_xvf_host):
        calls = []

        def run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return completed(0)

        result = restart_dsp(run=run)
        assert result["ok"] is True
        assert result["method"] == "xvf_host"
        assert result["restarted_at"] > 0
        # Command contract mirrors scripts/host/droplet-watchdog.sh.
        assert calls[0][0] == [str(fake_xvf_host), "REBOOT", "1"]
        assert calls[0][1]["timeout"] == pytest.approx(10.0)

    def test_timeout_env_overrides_subprocess_deadline(
        self, fake_xvf_host, monkeypatch,
    ):
        monkeypatch.setenv("XVF_RESTART_TIMEOUT_S", "3.5")
        seen = {}

        def run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return completed(0)

        restart_dsp(run=run)
        assert seen["timeout"] == pytest.approx(3.5)

    @pytest.mark.parametrize("raw", ["", "nonsense", "0", "-2"])
    def test_bad_timeout_env_falls_back_to_default(self, raw, monkeypatch):
        monkeypatch.setenv("XVF_RESTART_TIMEOUT_S", raw)
        assert dsp.restart_timeout_s() == pytest.approx(10.0)

    def test_missing_tool_raises_with_install_guidance(self, monkeypatch, tmp_path):
        monkeypatch.setenv("XVF_HOST_PATH", str(tmp_path / "absent"))
        with pytest.raises(DspRestartError) as exc:
            restart_dsp(run=lambda *a, **k: completed(0))
        assert "isn't available" in exc.value.detail

    def test_directory_at_tool_path_is_not_executable(self, monkeypatch, tmp_path):
        # The docker bind-mount failure shape: a missing host path
        # materialises as a directory (which passes a bare X_OK check).
        bogus = tmp_path / "xvf_host"
        bogus.mkdir()
        monkeypatch.setenv("XVF_HOST_PATH", str(bogus))
        with pytest.raises(DspRestartError):
            restart_dsp(run=lambda *a, **k: completed(0))

    def test_nonzero_exit_raises_with_stderr_tail(self, fake_xvf_host):
        def run(cmd, **kwargs):
            return completed(1, stderr="usb error\ncontrol transfer failed")

        with pytest.raises(DspRestartError) as exc:
            restart_dsp(run=run)
        assert "exit 1" in exc.value.detail
        assert "control transfer failed" in exc.value.detail

    def test_timeout_raises_operational_error(self, fake_xvf_host):
        def run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs["timeout"])

        with pytest.raises(DspRestartError) as exc:
            restart_dsp(run=run)
        assert "timed out" in exc.value.detail

    def test_exec_oserror_raises(self, fake_xvf_host):
        def run(cmd, **kwargs):
            raise OSError("Exec format error")

        with pytest.raises(DspRestartError) as exc:
            restart_dsp(run=run)
        assert "Exec format error" in exc.value.detail

    def test_default_path_used_when_env_empty(self, monkeypatch):
        # Compose passes XVF_HOST_PATH through as "" when unset — treat
        # empty the same as absent (main.py's env convention).
        monkeypatch.setenv("XVF_HOST_PATH", "")
        assert dsp.xvf_host_path() == dsp.DEFAULT_XVF_HOST_PATH


# ────────────────────────────────────────────────────────────────────
# POST /voice/restart-processor — the HTTP contract
# ────────────────────────────────────────────────────────────────────

class TestRestartProcessorEndpoint:
    def test_success_returns_restart_payload(self, client, monkeypatch):
        monkeypatch.setattr(
            main, "restart_dsp",
            lambda: {"ok": True, "method": "xvf_host", "restarted_at": 123.0},
        )
        resp = client.post("/voice/restart-processor")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["method"] == "xvf_host"
        assert body["restarted_at"] == 123.0

    def test_failure_maps_to_503_with_detail(self, client, monkeypatch):
        def boom():
            raise DspRestartError("xvf_host REBOOT 1 failed (exit 1)")

        monkeypatch.setattr(main, "restart_dsp", boom)
        resp = client.post("/voice/restart-processor")
        assert resp.status_code == 503
        assert "xvf_host REBOOT 1 failed" in resp.json()["detail"]

    def test_timeout_maps_to_503_with_detail(self, client, monkeypatch):
        def hang():
            raise DspRestartError("xvf_host REBOOT 1 timed out after 10s")

        monkeypatch.setattr(main, "restart_dsp", hang)
        resp = client.post("/voice/restart-processor")
        assert resp.status_code == 503
        assert "timed out" in resp.json()["detail"]

    def test_concurrent_restart_answers_409(self, client, monkeypatch):
        monkeypatch.setattr(
            main, "restart_dsp",
            lambda: {"ok": True, "method": "xvf_host", "restarted_at": 1.0},
        )
        assert main._restart_lock.acquire(blocking=False)
        try:
            resp = client.post("/voice/restart-processor")
            assert resp.status_code == 409
            assert "already in progress" in resp.json()["detail"]
        finally:
            main._restart_lock.release()
        # And the lock is released after a normal call — a follow-up works.
        assert client.post("/voice/restart-processor").status_code == 200

    def test_works_without_a_pipeline(self, client, monkeypatch):
        # The reboot is a USB control write — a box whose wake loop never
        # started (no mic at boot) must still be able to recover the DSP.
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(
            main, "restart_dsp",
            lambda: {"ok": True, "method": "xvf_host", "restarted_at": 1.0},
        )
        assert client.post("/voice/restart-processor").status_code == 200
