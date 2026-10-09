"""TLS lifetime/order and real inherited filesystem boundary regressions."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path

import pytest

SERVICES = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SERVICES))
from _shared import healthcheck, internal_tls, sandbox_isolation, sandbox_serve


def test_tls_launcher_protects_then_loads_cleans_seals_and_serves(monkeypatch):
    seen = []
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setattr(internal_tls, "protect_process", lambda: seen.append("protect"))
    monkeypatch.setattr(sandbox_serve, "cleanup_staged_tls", lambda: seen.append("cleanup"))
    monkeypatch.setattr(sandbox_serve, "seal_sandbox", lambda: seen.append("seal"))

    class Config:
        def __init__(self, app, **kwargs):
            assert app == "main:app" and kwargs["workers"] == 1
            assert kwargs["ssl_cert_reqs"] == 2
            seen.append("config")

        def load(self):
            seen.append("load-key")

    class Server:
        def __init__(self, config):
            pass

        def run(self):
            seen.append("customer-lifespan")

    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(Config=Config, Server=Server))
    sandbox_serve.main(["main:app", "--port", "8030"])
    assert seen == ["protect", "config", "load-key", "cleanup", "seal", "customer-lifespan"]


def test_tls_launcher_fails_closed_before_customer_code_without_landlock(monkeypatch):
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setattr(internal_tls, "protect_process", lambda: None)
    monkeypatch.setattr(sandbox_serve, "cleanup_staged_tls", lambda: None)
    monkeypatch.setattr(sandbox_serve, "seal_sandbox", lambda: (_ for _ in ()).throw(sandbox_isolation.IsolationUnavailable("unsupported kernel")))
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(
        Config=lambda *a, **k: types.SimpleNamespace(load=lambda: None),
        Server=lambda *a: pytest.fail("customer server must not start"),
    ))
    with pytest.raises(sandbox_isolation.IsolationUnavailable):
        sandbox_serve.main(["main:app", "--port", "8030"])


def test_plaintext_with_mounted_private_key_also_seals(monkeypatch):
    seen = []
    real_path = Path
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "0")
    monkeypatch.setattr(sandbox_serve, "Path", lambda value: types.SimpleNamespace(exists=lambda: True) if value == "/data/service-tls/key.pem" else real_path(value))
    monkeypatch.setattr(internal_tls, "protect_process", lambda: seen.append("protect"))
    monkeypatch.setattr(sandbox_serve, "cleanup_staged_tls", lambda: None)
    monkeypatch.setattr(sandbox_serve, "seal_sandbox", lambda: seen.append("seal"))
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(
        Config=lambda *a, **k: types.SimpleNamespace(load=lambda: None),
        Server=lambda *a: types.SimpleNamespace(run=lambda: seen.append("serve")),
    ))
    sandbox_serve.main(["main:app", "--port", "8030"])
    assert seen == ["protect", "seal", "serve"]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="native tmpfs staging uses /tmp")
def test_cleanup_removes_only_explicit_staged_copies(monkeypatch, tmp_path):
    host_key = tmp_path / "host-key.pem"
    host_key.write_text("host secret")
    stage = Path(tempfile.mkdtemp(prefix="droplet-service-tls.", dir="/tmp"))
    for name in ("key.pem", "cert.pem", "ca.pem"):
        (stage / name).write_text("private copy")
    monkeypatch.setenv("DROPLET_TLS_STAGING_DIR", str(stage))
    sandbox_serve.cleanup_staged_tls()
    assert not stage.exists() and host_key.read_text() == "host secret"
    monkeypatch.setenv("DROPLET_TLS_STAGING_DIR", str(tmp_path))
    with pytest.raises(RuntimeError, match="staging directory"):
        sandbox_serve.cleanup_staged_tls()
    assert host_key.read_text() == "host secret"


def test_healthcheck_protects_memory_before_loading_key(monkeypatch):
    seen = []
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setattr(internal_tls, "protect_process", lambda: seen.append("protect"))
    monkeypatch.setattr(healthcheck.ssl, "create_default_context", lambda **kw: types.SimpleNamespace(load_cert_chain=lambda **kw: seen.append("load-key")))
    url, _ = healthcheck.probe_url_and_context("8030", "/health")
    assert url == "https://localhost:8030/health"
    assert seen == ["protect", "load-key"]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real inherited Landlock requires Linux")
def test_inherited_boundary_denies_private_files_and_proc_aliases_preserves_tools(tmp_path):
    # The fixture is outside /tmp, which is intentionally a writable runtime.
    # No root or Docker is needed; the key is readable by this same uid before
    # sealing, so permission denial must come from the inherited policy.
    secret_root = Path(tempfile.mkdtemp(prefix=".droplet-tls-test-", dir=Path.home()))
    try:
        key = secret_root / "key.pem"
        key.write_text("private TLS identity")
        key.chmod(0o600)
        assert key.read_text() == "private TLS identity"
        runtime = {str(SERVICES), sys.prefix, sys.base_prefix, str(Path(sys.executable).parent.parent)}
        child_python = shutil.which("python3") or sys.executable
        code = r'''
import ctypes, json, os, pathlib, socket, subprocess, sys
sys.path.insert(0, sys.argv[1])
from _shared import sandbox_isolation
sandbox_isolation.READ_ONLY_PATHS += tuple(json.loads(sys.argv[2]))
sandbox_isolation.seal_sandbox()
key, workspace, parent, child_python = sys.argv[3:]
for candidate in (key, '/proc/self/root' + key, f'/proc/{parent}/root' + key):
    try:
        pathlib.Path(candidate).read_bytes()
    except PermissionError:
        pass
    else:
        raise AssertionError('TLS read escaped: ' + candidate)
child = "import pathlib,sys;\ntry: pathlib.Path(sys.argv[1]).read_bytes()\nexcept PermissionError: print('denied')\nelse: raise AssertionError('child escaped')"
assert subprocess.check_output([child_python, '-c', child, key], text=True).strip() == 'denied'
pathlib.Path(workspace, 'ordinary.py').write_text("print('workspace-python')")
assert subprocess.check_output([child_python, str(pathlib.Path(workspace, 'ordinary.py'))], text=True).strip() == 'workspace-python'
subprocess.run(['git', 'init', '-q', workspace], check=True)
subprocess.run(['git', '-C', workspace, 'add', 'ordinary.py'], check=True)
subprocess.run(['git', '-C', workspace, '-c', 'user.name=TLS Test', '-c', 'user.email=tls@example.test', 'commit', '-qm', 'workspace'], check=True)
assert subprocess.check_output(['git', '-C', workspace, 'status', '--porcelain'], text=True) == ''
with socket.socket() as server:
    server.bind(('127.0.0.1', 0)); server.listen(1)
    with socket.create_connection(server.getsockname()) as client:
        connection, _ = server.accept()
        with connection:
            client.sendall(b'extension'); assert connection.recv(9) == b'extension'
print('filesystem, inheritance, git, Python and sockets passed')
'''
        result = subprocess.run([sys.executable, "-c", code, str(SERVICES), json.dumps(sorted(runtime)), str(key), str(tmp_path), str(os.getpid()), child_python], check=False, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stdout + result.stderr
    finally:
        shutil.rmtree(secret_root)


@pytest.mark.skipif(not sys.platform.startswith("linux") or shutil.which("node") is None, reason="native extension execution requires Linux and a Node runtime")
def test_extension_node_inherits_private_file_denial():
    node = shutil.which("node")
    secret_root = Path(tempfile.mkdtemp(prefix=".droplet-tls-node-test-", dir=Path.home()))
    try:
        key = secret_root / "key.pem"
        key.write_text("private TLS identity")
        key.chmod(0o600)
        runtime = {str(SERVICES), sys.prefix, sys.base_prefix, str(Path(node).resolve().parent.parent)}
        code = r'''
import json,subprocess,sys
sys.path.insert(0,sys.argv[1])
from _shared import sandbox_isolation
sandbox_isolation.READ_ONLY_PATHS += tuple(json.loads(sys.argv[2]))
sandbox_isolation.seal_sandbox()
extension = "const fs=require('fs'); for(const p of [process.argv[1], '/proc/self/root'+process.argv[1]]) { try { fs.readFileSync(p); throw Error('extension read TLS'); } catch(e) { if(e.code !== 'EACCES') throw e; } } console.log('extension-denied');"
assert subprocess.check_output([sys.argv[3],'-e',extension,sys.argv[4]],text=True).strip() == 'extension-denied'
'''
        result = subprocess.run([sys.executable,"-c",code,str(SERVICES),json.dumps(sorted(runtime)),node,str(key)], check=False, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stdout + result.stderr
    finally:
        shutil.rmtree(secret_root)


@pytest.mark.skipif(not sys.platform.startswith("linux") or os.geteuid() == 0, reason="same-uid inspection denial must run without root privileges")
def test_private_key_holder_cannot_be_inspected_through_proc():
    code = "import sys; sys.path.insert(0,sys.argv[1]); from _shared.internal_tls import protect_process; protect_process(); print('protected',flush=True); sys.stdin.read()"
    with subprocess.Popen([sys.executable, "-c", code, str(SERVICES)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as process:
        try:
            assert process.stdout.readline().strip() == "protected"
            for name in ("environ", "mem"):
                with pytest.raises(PermissionError):
                    Path(f"/proc/{process.pid}/{name}").read_bytes()
            with pytest.raises(PermissionError):
                list(Path(f"/proc/{process.pid}/fd").iterdir())
        finally:
            process.communicate(timeout=5)
