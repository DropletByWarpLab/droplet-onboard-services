"""WARP-3906 — a noisy app cannot block on its logs or retain unbounded output."""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

import pytest

import supervisor
from tests.proc_helpers import needs_linux, wait_gone


@pytest.fixture()
def log_process(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(supervisor, "EXTENSIONS_DIR", os.path.realpath(str(tmp_path)))
    monkeypatch.setattr(supervisor, "INTERPRETERS", {"python": sys.executable})

    def start(source: str, *, restart: str = "never", max_restarts: int = 0):
        (tmp_path / "app.py").write_text(source, encoding="utf-8")
        sup = supervisor.Supervisor()
        sup.start("app", ["python", "app.py"], cwd=None, restart=restart, max_restarts=max_restarts, env={})
        return sup

    return start


def terminal(sup: supervisor.Supervisor, timeout: float = 10) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = sup.status("app")
        if status and status["state"] in {"exited", "failed", "stopped"}:
            return status
        time.sleep(0.01)
    raise AssertionError(f"app never finished: {sup.status('app')}")


def output_contains(sup: supervisor.Supervisor, text: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        logs = sup.logs("app")
        if text in logs["output"]:
            return logs
        time.sleep(0.01)
    raise AssertionError(f"app never logged {text!r}")


def assert_capture_closed(sup: supervisor.Supervisor) -> None:
    capture = sup._entries["app"].capture
    assert capture.pipe.closed, "the exited process still has an open output pipe"
    assert not capture.thread.is_alive(), "the exited process still has a drain thread"


def test_stdout_and_stderr_share_one_ordered_buffer(log_process):
    sup = log_process("import os\nos.write(1, b'out one\\n')\nos.write(2, b'err one\\n')\nos.write(1, b'out two\\n')\n")
    assert terminal(sup)["state"] == "exited"
    logs = sup.logs("app")
    assert logs["output"] == "out one\nerr one\nout two\n"
    assert logs["retainedBytes"] == logs["nextSequence"] == 24
    assert logs["startSequence"] == logs["droppedBytes"] == 0
    assert logs["truncated"] is False
    assert_capture_closed(sup)


def test_flood_is_drained_without_a_reader_and_only_the_last_64k_are_kept(log_process):
    sup = log_process(
        "import os\n"
        "for _ in range(256):\n"
        "    os.write(1, b'x' * 4096)\n"
        "os.write(2, b'\\nlast error\\n')\n"
    )
    # No log read until it exits: stopping the drain at the cap would fill
    # the pipe and leave this process running forever.
    assert terminal(sup)["state"] == "exited"
    logs = sup.logs("app")
    assert logs["retainedBytes"] == supervisor.LOG_CAP_BYTES
    assert len(logs["output"].encode()) == supervisor.LOG_CAP_BYTES
    assert logs["output"].endswith("\nlast error\n")
    assert logs["nextSequence"] == 256 * 4096 + len(b"\nlast error\n")
    assert logs["droppedBytes"] == logs["nextSequence"] - supervisor.LOG_CAP_BYTES
    assert logs["startSequence"] == logs["droppedBytes"]
    assert logs["truncated"] is True
    assert_capture_closed(sup)


def test_line_tail_and_old_cursor_both_report_truncation(log_process):
    sup = log_process("import os\nos.write(1, b'one\\ntwo\\nthree\\nfour\\n')\n")
    terminal(sup)
    full = sup.logs("app")
    tail = sup.logs("app", limit=2)
    assert tail["output"] == "three\nfour\n"
    assert tail["truncated"] is True
    assert tail["startSequence"] == len(b"one\ntwo\n")
    assert tail["retainedBytes"] == full["retainedBytes"]
    assert sup.logs("app", since=full["nextSequence"])["output"] == ""
    assert sup.logs("app", since=full["nextSequence"])["truncated"] is False

    flood = log_process("import os\nos.write(1, b'z' * (128 * 1024))\n")
    terminal(flood)
    assert flood.logs("app", since=1)["truncated"] is True
    retained = flood.logs("app")
    assert flood.logs("app", since=retained["startSequence"])["truncated"] is False


def test_live_reads_are_repeatable_and_byte_cursor_returns_only_new_output(log_process, tmp_path):
    sup = log_process(
        "import os, time\nfrom pathlib import Path\n"
        "os.write(1, b'before\\n')\n"
        "for _ in range(500):\n"
        "    if Path('continue').exists():\n"
        "        break\n"
        "    time.sleep(0.01)\n"
        "os.write(2, b'after\\n')\n"
    )
    try:
        first = output_contains(sup, "before\n")
        assert sup.logs("app") == first
        (tmp_path / "continue").touch()
        terminal(sup)
        second = sup.logs("app", since=first["nextSequence"])
        assert second["output"] == "after\n"
        assert second["startSequence"] == first["nextSequence"]
        assert second["nextSequence"] == len(b"before\nafter\n")
        assert second["truncated"] is False
    finally:
        sup.stop("app", grace_s=0.5)


def test_binary_and_partial_utf8_are_rendered_without_losing_the_byte_budget(log_process):
    sup = log_process("import os\nos.write(1, b'\\xff\\xe2\\x82\\xac\\xe2')\n")
    terminal(sup)
    logs = sup.logs("app")
    assert logs["output"] == "\ufffd\u20ac\ufffd"
    assert logs["retainedBytes"] == logs["nextSequence"] == 5


def test_automatic_restarts_keep_logs_and_close_each_generation(log_process, monkeypatch):
    captures = []
    original = supervisor._Capture.finish

    def finish(capture):
        original(capture)
        captures.append(capture)

    monkeypatch.setattr(supervisor._Capture, "finish", finish)
    sup = log_process("import os\nos.write(1, b'attempt\\n')\nraise SystemExit(3)\n", restart="on-failure", max_restarts=2)
    status = terminal(sup)
    assert status["exitCode"] == 3 and status["restarts"] == 2
    assert sup.logs("app")["output"] == "attempt\n" * 3
    assert sup.logs("app")["nextSequence"] == len(b"attempt\n") * 3
    assert len(captures) == 3
    assert all(c.pipe.closed and not c.thread.is_alive() for c in captures)


def test_stop_closes_the_pipe_and_drain_thread_but_keeps_final_logs(log_process):
    sup = log_process("import os, time\nos.write(2, b'ready\\n')\ntime.sleep(30)\n")
    try:
        output_contains(sup, "ready\n")
        assert sup.stop("app", grace_s=0.5)["state"] == "stopped"
        assert sup.logs("app")["output"] == "ready\n"
        assert_capture_closed(sup)
        sup.forget("app")
        assert sup.logs("app") is None
    finally:
        sup.stop("app", grace_s=0.5)


def test_capture_start_failure_kills_the_child_and_closes_its_pipe(log_process, monkeypatch):
    seen = []
    real_popen = supervisor.subprocess.Popen

    def popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    def unavailable(*args):
        raise OSError("nonblocking pipe unavailable")

    monkeypatch.setattr(supervisor.subprocess, "Popen", popen)
    monkeypatch.setattr(supervisor.os, "set_blocking", unavailable)
    with pytest.raises(supervisor.SupervisorError) as exc:
        log_process("import time\ntime.sleep(30)\n")
    assert exc.value.status == 400
    assert len(seen) == 1 and seen[0].poll() is not None
    assert seen[0].stdout.closed


@needs_linux
def test_an_escaped_fork_holding_the_pipe_cannot_keep_the_reader_alive(log_process, tmp_path):
    sup = log_process(
        "import os, subprocess, sys\n"
        "from pathlib import Path\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)\n"
        "Path('escaped.pid').write_text(str(p.pid))\n"
        "os.write(1, b'parent done\\n')\n"
    )
    pid = None
    try:
        started = time.monotonic()
        assert terminal(sup)["state"] == "exited"
        pid = int((tmp_path / "escaped.pid").read_text())
        assert time.monotonic() - started < 3
        assert sup.logs("app")["output"] == "parent done\n"
        assert sup.logs("app")["truncated"] is True
        assert_capture_closed(sup)
    finally:
        if pid is None and (tmp_path / "escaped.pid").exists():
            pid = int((tmp_path / "escaped.pid").read_text())
        if pid is not None:
            os.kill(pid, signal.SIGKILL)
            assert wait_gone(pid)
        sup.stop("app", grace_s=0.5)


@pytest.mark.parametrize("limit,since", [(0, None), (2001, None), (True, None), (1, -1), (1, True), (1, "1")])
def test_log_query_is_closed_in_shape(limit, since):
    with pytest.raises(supervisor.SupervisorError) as exc:
        supervisor.Supervisor().logs("missing", limit=limit, since=since)
    assert exc.value.status == 400


def test_unknown_process_has_no_logs_and_app_environment_is_explicit():
    assert supervisor.Supervisor().logs("missing") is None
    assert supervisor.check_extra_env({
        "PORT": "18000",
        "DROPLET_EXT_BASE_PATH": "/shop/",
        "DROPLET_EXT_DATA_DIR": "/var/lib/workspace-ext-data/shop",
    })["PORT"] == "18000"
    with pytest.raises(supervisor.SupervisorError):
        supervisor.check_extra_env({"SANDBOX_SERVICE_TOKEN": "secret"})
