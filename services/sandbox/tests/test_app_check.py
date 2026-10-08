"""Real pre-promotion probes, capped data and cleanup (WARP-3906)."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import app_check
import extensions
import hosted_http
import workspace
from gitstore import StoreError
from tests.proc_helpers import needs_linux, wait_gone

ALICE = ("Alice", "alice@example.test")


def manifest(runtime="python312", **changes):
    value = {"schemaVersion": 1, "id": "ws-app", "name": "App", "version": "1.0.0", "kind": "app",
             "runtime": runtime, "entrypoint": "server.py", "http": {"health": "/healthz"},
             "provides": {"tools": [], "routineDrafts": [], "proposedGrants": []},
             "resources": {"memoryMb": 64, "processes": 1}, "egress": "none"}
    if runtime == "static":
        value.pop("entrypoint")
        value["http"] = {"health": "/", "dir": "public"}
    value.update(changes)
    return value


def app(store, source="", *, config=None):
    store.create_workspace("ws-app", None, ALICE)
    workspace.write("ws-app", "extension-manifest.json", json.dumps(config or manifest()))
    if source:
        workspace.write("ws-app", "server.py", source)
    return store.work_path("ws-app")


SERVER = """
import http.server, json, os
from pathlib import Path
data = Path(os.environ['DROPLET_EXT_DATA_DIR'])
(data / 'temporary.txt').write_text('temporary')
facts = {'pid': os.getpid(), 'port': os.environ['PORT'], 'extPort': os.environ['DROPLET_EXT_PORT'],
         'data': str(data), 'base': os.environ['DROPLET_EXT_BASE_PATH'],
         'secret': os.environ.get('SANDBOX_SERVICE_TOKEN')}
Path('probe-facts.json').write_text(json.dumps(facts))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        base = os.environ['DROPLET_EXT_BASE_PATH']
        self.send_response(200 if self.path in (base, base + 'healthz') else 404)
        self.end_headers()
        self.wfile.write(json.dumps(facts).encode())
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
"""


def test_exact_app_check_argv_and_tool_refusal_before_execution(store):
    assert workspace.resolve_run_argv(["app-check"]) == ["app-check"]
    for argv in (["app-check", "--port=80"], ["app-check", "server.py"]):
        with pytest.raises(StoreError, match="takes no arguments"):
            workspace.resolve_run_argv(argv)
    app(store, "raise RuntimeError('must never run')", config=manifest(kind="extension"))
    with pytest.raises(StoreError, match="only available for kind: app"):
        workspace.run("ws-app", ["app-check"])
    assert workspace.last_run("ws-app") is None


def test_python_server_gets_assigned_port_no_service_secret_and_temporary_data(store, monkeypatch):
    monkeypatch.setenv("SANDBOX_SERVICE_TOKEN", "never-copy-me")
    work = app(store, SERVER)
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 0, result
    assert result["timedOut"] is False
    assert result["appCheck"]["health"]["status"] == result["appCheck"]["root"]["status"] == 200
    facts = json.loads((work / "probe-facts.json").read_text())
    assert facts["port"] == facts["extPort"] and int(facts["port"]) > 0
    assert facts["base"] == "/ws-app/" and facts["secret"] is None
    assert not Path(facts["data"]).exists()
    assert workspace.last_run("ws-app") == result


@needs_linux
def test_success_kills_the_whole_app_process_group(store):
    fork = "import subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nPath('child.pid').write_text(str(child.pid))\n"
    source = SERVER.replace("class Handler", fork + "class Handler")
    work = app(store, source)
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 0, result
    assert wait_gone(int((work / "child.pid").read_text()))
    assert wait_gone(json.loads((work / "probe-facts.json").read_text())["pid"])


def test_a_server_that_never_becomes_ready_times_out_and_leaves_no_temporary_data(store):
    work = app(store, "import os, time\nfrom pathlib import Path\nPath('temp-path.txt').write_text(os.environ['DROPLET_EXT_DATA_DIR'])\ntime.sleep(60)\n")
    started = time.monotonic()
    result = workspace.run("ws-app", ["app-check"], 1000)
    assert result["timedOut"] is True and result["exitCode"] is None
    assert time.monotonic() - started < 2
    assert not Path((work / "temp-path.txt").read_text()).exists()


def test_server_failure_is_reported_without_waiting_for_the_deadline(store):
    app(store, "import sys\nprint('startup failed', file=sys.stderr)\nraise SystemExit(7)\n")
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 1 and result["timedOut"] is False
    assert "exit 7" in result["stderr"] and "startup failed" in result["stderr"]
    assert result["appCheck"]["health"] is None


def test_body_and_child_output_are_bounded_and_truncation_is_explicit(store):
    source = SERVER.replace("class Handler", "print('x' * 200000, flush=True)\nclass Handler")
    source = source.replace("json.dumps(facts).encode()", "b'y' * 10000")
    app(store, source)
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 0, result
    assert result["truncated"] is True
    assert len(result["stdout"].encode()) <= app_check.OUTPUT_CAP_BYTES
    for key in ("root", "health"):
        assert len(result["appCheck"][key]["body"].encode()) == 2048
        assert result["appCheck"][key]["truncated"] is True


def test_static_http_facts_and_spa_fallback_use_no_child_process(store, monkeypatch):
    app(store, config=manifest("static", http={"health": "/healthz", "dir": "public", "spa": True}))
    workspace.write("ws-app", "public/index.html", "<h1>App works</h1>")
    monkeypatch.setattr(app_check.subprocess, "Popen", lambda *a, **k: pytest.fail("static smoke check spawned a child"))
    # _checkout performs git operations, so invoke the helper on the already
    # followed tree while Popen is forbidden.
    result = app_check.run(store.work_path("ws-app"), 1000, env={}, with_limits=lambda command: command)
    assert result["exitCode"] == 0, result
    assert result["appCheck"]["health"]["body"] == "<h1>App works</h1>"
    assert result["appCheck"]["root"]["status"] == 200


def test_static_missing_health_is_a_reported_404_not_a_pass(store):
    app(store, config=manifest("static", http={"health": "/healthz", "dir": "public"}))
    workspace.write("ws-app", "public/index.html", "works")
    result = workspace.run("ws-app", ["app-check"], 1000)
    assert result["exitCode"] == 1 and result["timedOut"] is False
    assert result["appCheck"]["health"]["status"] == 404


@pytest.mark.parametrize("config", [manifest(entrypoint="../outside.py"), manifest(entrypoint="/outside.py"),
    manifest(http={"health": "http://example.test/health"}), manifest(http={"health": "//example.test/"}),
    manifest(http={"health": "/_droplet/session"}), manifest("static", http={"health": "/", "dir": "../outside"}),
    manifest(runtime="image"), manifest(runtime=["node20"]), manifest(egress="internet"),
    manifest(resources={"memoryMb": True, "processes": 1}),
    manifest(resources={"memoryMb": 64, "processes": True})])
def test_unsafe_manifest_shapes_never_execute(store, config):
    app(store, "raise RuntimeError('must never run')", config=config)
    with pytest.raises(StoreError) as exc:
        workspace.run("ws-app", ["app-check"])
    assert exc.value.status == 400


def test_runtime_timeout_is_clamped_to_thirty_seconds(store, monkeypatch):
    work = app(store, SERVER)
    values = []
    original = app_check._probe
    def probe(port, path, deadline):
        values.append(deadline - time.monotonic())
        return original(port, path, deadline)
    monkeypatch.setattr(app_check, "_probe", probe)
    result = workspace.run("ws-app", ["app-check"], 600_000)
    assert result["exitCode"] == 0, result
    assert values and max(values) <= 30
    assert not Path(json.loads((work / "probe-facts.json").read_text())["data"]).exists()


@pytest.mark.skipif(shutil.which("node") is None, reason="Node interpreter not installed")
def test_node_server_entrypoint_runs_without_a_host_shim(store, monkeypatch):
    app(store, config=manifest("node20", entrypoint="server.mjs"))
    workspace.write("ws-app", "server.mjs", "import http from 'node:http';\nimport v8 from 'node:v8';\nimport fs from 'node:fs';\nfs.writeFileSync('node-heap.json',JSON.stringify(v8.getHeapStatistics()));\nhttp.createServer((req,res)=>{const base=process.env.DROPLET_EXT_BASE_PATH;res.statusCode=[base,base+'healthz'].includes(req.url)?200:404;res.end('node app');}).listen(Number(process.env.PORT),'127.0.0.1');\n")
    monkeypatch.setattr(app_check, "NODE_BIN", shutil.which("node"))
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 0, result
    assert result["appCheck"]["health"]["body"] == "node app"
    heap = json.loads((store.work_path("ws-app") / "node-heap.json").read_text())
    baseline = subprocess.run([shutil.which("node"), "--print", "require('node:v8').getHeapStatistics().heap_size_limit"],
                              capture_output=True, check=True, timeout=10)
    # V8's other heap spaces vary by Node version. The real child must still
    # report a smaller heap ceiling than the interpreter's uncapped default.
    assert heap["heap_size_limit"] < int(baseline.stdout)


def test_app_check_budget_is_preflighted_against_running_extensions(store, monkeypatch):
    app(store, SERVER)
    monkeypatch.setattr(extensions, "budget", lambda: {"availableMb": 32})
    with pytest.raises(StoreError, match="only 32 MB") as exc:
        workspace.run("ws-app", ["app-check"])
    assert exc.value.status == 409
    assert not (store.work_path("ws-app") / "probe-facts.json").exists()


def test_a_drip_fed_header_cannot_extend_the_combined_http_timeout(store):
    source = """
import os, socket, time
from pathlib import Path
Path('temp-path.txt').write_text(os.environ['DROPLET_EXT_DATA_DIR'])
server = socket.socket()
server.bind(('127.0.0.1', int(os.environ['PORT'])))
server.listen(1)
conn, _ = server.accept()
conn.recv(8192)
conn.sendall(b'HTTP/1.1 200 OK\\r\\nX-Slow: ')
for _ in range(100):
    conn.sendall(b'x')
    time.sleep(.05)
"""
    work = app(store, source)
    started = time.monotonic()
    result = workspace.run("ws-app", ["app-check"], 1000)
    assert result["timedOut"] is True and result["exitCode"] is None
    assert time.monotonic() - started < 2
    assert not Path((work / "temp-path.txt").read_text()).exists()


@pytest.mark.parametrize("address", ["00000000", "0101A8C0"])
def test_kernel_listener_validation_refuses_wildcard_and_lan_addresses(tmp_path, monkeypatch, address):
    monkeypatch.setattr(sys, "platform", "linux")
    table = tmp_path / "tcp"
    table.write_text(f"header\n0: {address}:4810 00000000:0000 0A\n")
    monkeypatch.setattr(hosted_http, "PROC_TCP_TABLES", ((str(table), "0100007F"),))
    with pytest.raises(StoreError, match="wildcard or LAN"):
        hosted_http.assert_loopback_listener(18448)


def test_kernel_listener_validation_checks_both_ipv4_and_ipv6(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    tcp, tcp6 = tmp_path / "tcp", tmp_path / "tcp6"
    tcp.write_text("header\n0: 0100007F:4810 00000000:0000 0A\n")
    tcp6.write_text("header\n0: 00000000000000000000000000000000:4810 0:0000 0A\n")
    tables = ((str(tcp), "0100007F"), (str(tcp6), "00000000000000000000000001000000"))
    monkeypatch.setattr(hosted_http, "PROC_TCP_TABLES", tables)
    with pytest.raises(StoreError, match="wildcard or LAN"):
        hosted_http.assert_loopback_listener(18448)
    tcp6.write_text("header\n0: 00000000000000000000000001000000:4810 0:0000 0A\n")
    assert hosted_http.assert_loopback_listener(18448) is True
    with pytest.raises(StoreError, match="no listener"):
        hosted_http.assert_loopback_listener(18449)


def test_linux_listener_validation_fails_closed_without_procfs(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(hosted_http, "PROC_TCP_TABLES", ((str(tmp_path / "missing"), "0100007F"),))
    with pytest.raises(StoreError, match="could not be inspected") as exc:
        hosted_http.assert_loopback_listener(18448)
    assert exc.value.status == 503


@needs_linux
def test_app_check_rejects_a_real_wildcard_listener_and_cleans_it_up(store):
    work = app(store, SERVER.replace("('127.0.0.1', int", "('0.0.0.0', int"))
    result = workspace.run("ws-app", ["app-check"], 5000)
    assert result["exitCode"] == 1 and "wildcard or LAN" in result["stderr"]
    facts = json.loads((work / "probe-facts.json").read_text())
    assert wait_gone(facts["pid"])
    assert not Path(facts["data"]).exists()


@needs_linux
def test_an_escaped_forks_output_pipe_cannot_leave_a_capture_thread_alive(store):
    fork = "import subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', 'import time; print(\\\"escaped child\\\", flush=True); time.sleep(60)'], start_new_session=True)\nPath('escaped.pid').write_text(str(child.pid))\n"
    work = app(store, SERVER.replace("class Handler", fork + "class Handler"))
    escaped = None
    try:
        result = workspace.run("ws-app", ["app-check"], 5000)
        escaped = int((work / "escaped.pid").read_text())
        assert result["exitCode"] == 0 and result["truncated"] is True, result
        assert not any(t.name.startswith("app-check-output-") for t in threading.enumerate())
    finally:
        if escaped is not None:
            os.kill(escaped, signal.SIGKILL)
            assert wait_gone(escaped)


def test_capture_setup_failure_still_kills_child_and_closes_both_pipes(store, monkeypatch):
    app(store, SERVER)
    real_popen = app_check.subprocess.Popen
    processes = []
    def spawn(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        processes.append(proc)
        return proc
    real_capture = app_check._Capture
    attempts = []
    def capture(pipe):
        attempts.append(pipe)
        if len(attempts) == 2:
            raise RuntimeError("thread could not start")
        return real_capture(pipe)
    # The helper is invoked directly to avoid patching git's unrelated Popen.
    monkeypatch.setattr(app_check.subprocess, "Popen", spawn)
    monkeypatch.setattr(app_check, "_Capture", capture)
    result = app_check.run(store.work_path("ws-app"), 5000, env=dict(workspace.RUN_ENV), with_limits=workspace._with_limits)
    assert result["exitCode"] == 1 and "thread could not start" in result["stderr"]
    assert len(processes) == 1 and processes[0].poll() is not None
    assert all(pipe.closed for pipe in (processes[0].stdout, processes[0].stderr))
    assert not any(t.name.startswith("app-check-output-") for t in threading.enumerate())
