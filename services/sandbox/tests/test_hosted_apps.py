"""WARP-3906 — real signed-tree exports, serving, credential filtering and stop.

The orchestrator session/grant relay is HA-3; these exercise its internal
transport, not a claim that browser hosting is already released.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import time
from pathlib import Path

import pytest

import extensions
import hosted_http
import supervisor
import workspace
from gitstore import StoreError
from tests.test_extensions import (  # noqa: F401 — shared real store/process fixture
    ALICE,
    BASE_ENV,
    ext,
)


@pytest.fixture()
def apps(request, tmp_path, monkeypatch):
    store = request.getfixturevalue("ext")
    monkeypatch.setenv("SANDBOX_EXTENSIONS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    yield store


def install_app(store, runtime="static", *, http=None, source=None, **changes):
    name = "shop"
    store.create_workspace(name, None, ALICE)
    manifest = {
        "schemaVersion": 1, "id": name, "name": "Shop", "version": "1.0.0",
        "kind": "app", "runtime": runtime,
        "http": http or ({"health": "/", "dir": "public", "spa": True} if runtime == "static" else {"health": "/health"}),
        "provides": {"tools": [], "routineDrafts": [], "proposedGrants": []},
        "resources": {"memoryMb": 64, "processes": 1}, "egress": "none",
    }
    if runtime != "static":
        manifest["entrypoint"] = "server.mjs" if runtime == "node20" else "server.py"
    manifest.update(changes)
    workspace.write(name, "extension-manifest.json", json.dumps(manifest))
    workspace.write(name, "public/index.html", "<h1>My imported app</h1>")
    workspace.write(name, "public/asset.js", "console.log('app')")
    if source:
        workspace.write(name, manifest["entrypoint"], source)
    committed = workspace.commit(name, "Imported application", ALICE)["commit"]
    tree = store.must(store.git(["rev-parse", f"{committed}^{{tree}}"], store.work_path(name)), "tree").stdout.strip()
    result = extensions.install(name, workspace_id=name, version="1.0.0", commit=committed, tree=tree,
                                kind="app", runtime=runtime, entrypoint=manifest.get("entrypoint"),
                                memory_mb=64, token=None, http=manifest["http"], base_env=BASE_ENV)
    return result


def read_app(slug, key, path="", method="GET", headers=None, body=b""):
    response = extensions.app_request(slug, key, method, path, "", headers or {}, io.BytesIO(body), len(body))
    try:
        return response.status, response.headers, b"".join(response.chunks())
    finally:
        response.close()


def test_static_real_tree_no_process_budget_cache_and_stop(apps):
    result = install_app(apps)
    assert result["kind"] == "app" and result["running"] is True
    assert result["process"] is None and result["port"] == result["memoryMb"] == 0
    assert "relayKey" not in extensions.status("shop")
    status, headers, body = read_app("shop", result["relayKey"])
    assert status == 200 and b"My imported app" in body
    assert headers["content-type"] == "text/html" and headers["cache-control"] == "no-store"
    assert headers["x-droplet-relay"] == "app"
    assert read_app("shop", result["relayKey"], "dashboard")[0] == 200
    assert read_app("shop", result["relayKey"], "missing.js")[0] == 404
    assert read_app("shop", result["relayKey"], method="POST")[0] == 405
    assert read_app("shop", result["relayKey"], method="HEAD")[2] == b""
    assert read_app("shop", result["relayKey"], headers={"if-none-match": headers["etag"]})[0] == 304
    assert extensions.listing() == [{"slug": "shop", "running": True}]
    assert extensions.stop("shop")["state"] == "stopped"
    assert extensions.listing() == [{"slug": "shop", "running": False}]
    with pytest.raises(StoreError, match="stopped"):
        read_app("shop", result["relayKey"])


def test_static_paths_and_symlinks_cannot_leave_public_root(apps, tmp_path):
    result = install_app(apps)
    for path in ("../extension-manifest.json", "%2e%2e/extension-manifest.json", ".git/config", "a%5cb"):
        with pytest.raises(StoreError):
            read_app("shop", result["relayKey"], path)
    assert read_app("shop", result["relayKey"], "extension-manifest.json")[0] == 404
    root = extensions._get("shop").directory / "public"
    outside = tmp_path / "private.txt"
    outside.write_text("must never leak")
    try:
        os.chmod(root, 0o700)
        (root / "leak.txt").symlink_to(outside)
    except OSError:
        pytest.skip("Windows developer mode does not permit symlinks")
    with pytest.raises(StoreError):
        read_app("shop", result["relayKey"], "leak.txt")


def test_internal_auth_relay_key_feature_gate_and_request_cap(apps, client, auth, monkeypatch):
    result = install_app(apps)
    url = "/extensions/shop/http/"
    assert client.get(url).status_code == 401
    assert client.get(url, headers=auth).status_code == 403
    with pytest.raises(StoreError) as refused:
        read_app("shop", "caf\u00e9")
    assert refused.value.status == 403
    headers = {**auth, "X-Droplet-Relay-Key": result["relayKey"]}
    assert client.get(url, headers=headers).status_code == 200
    assert client.get("/extensions/shop/logs", headers=auth).json()["process"] is False
    assert client.get("/extensions/shop/logs?limit=0", headers=auth).status_code == 400
    monkeypatch.setattr(hosted_http, "MAX_REQUEST_BYTES", 8)
    assert client.post(url, headers=headers, content=b"0123456789").status_code == 413
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", False)
    assert client.get(url, headers=headers).status_code == 404


NODE_SERVER = """
import http from 'node:http';
console.log('starting imported app');
const facts = {port: process.env.PORT, extPort: process.env.DROPLET_EXT_PORT,
  base: process.env.DROPLET_EXT_BASE_PATH, data: process.env.DROPLET_EXT_DATA_DIR,
  token: process.env.DROPLET_EXT_TOKEN ?? null, service: process.env.SANDBOX_SERVICE_TOKEN ?? null};
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('set-cookie', 'droplet_session=forged');
  res.setHeader('access-control-allow-origin', '*');
  res.statusCode = req.url.endsWith('/missing') ? 404 : 200;
  res.end(JSON.stringify({...facts, url: req.url, headers: req.headers}));
}).listen(Number(process.env.PORT), '127.0.0.1');
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="no node")
def test_real_node_process_port_env_status_and_credential_stripping(apps, monkeypatch):
    monkeypatch.setenv("SANDBOX_SERVICE_TOKEN", "private-server-bearer")
    result = install_app(apps, "node20", source=NODE_SERVER)
    status, headers, data = read_app("shop", result["relayKey"], "missing", headers={
        "cookie": "droplet_session=private", "authorization": "Bearer private",
        "x-droplet-user-id": "alice", "x-droplet-role": "owner", "x-droplet-app": "shop",
    })
    facts = json.loads(data)
    assert status == 404 and headers["x-droplet-relay"] == "app"
    assert "set-cookie" not in headers and "access-control-allow-origin" not in headers
    assert facts["url"] == "/shop/missing"
    assert facts["port"] == facts["extPort"] and int(facts["port"]) == result["port"]
    assert facts["base"] == "/shop/" and Path(facts["data"]).is_dir()
    assert facts["token"] is None and facts["service"] is None
    assert "cookie" not in facts["headers"] and "authorization" not in facts["headers"]
    assert facts["headers"]["x-droplet-user-id"] == "alice"
    deadline = time.monotonic() + 2
    while "starting imported app" not in extensions.app_logs("shop")["output"] and time.monotonic() < deadline:
        time.sleep(0.01)
    assert "starting imported app" in extensions.app_logs("shop")["output"]
    with pytest.raises(StoreError, match="MCP"):
        extensions.relay("shop", b"{}")
    data_dir = Path(facts["data"])
    (data_dir / "saved.txt").write_text("persistent")
    extensions.uninstall("shop")
    assert (data_dir / "saved.txt").read_text() == "persistent"
    extensions.uninstall("shop", delete_data=True)
    assert not data_dir.exists()


def test_install_refuses_manifest_tools(apps):
    with pytest.raises(StoreError, match="must not provide tools"):
        install_app(apps, provides={"tools": [{"name": "hidden"}]})


def test_install_refuses_manifest_egress(apps):
    with pytest.raises(StoreError, match="egress"):
        install_app(apps, egress="internet")


@pytest.mark.parametrize("resources", [None, [], {}, {"memoryMb": 64, "processes": True},
                                      {"memoryMb": 64, "processes": 2}])
def test_install_refuses_invalid_process_accounting(apps, resources):
    with pytest.raises(StoreError, match="exactly one process"):
        install_app(apps, resources=resources)


def test_static_hashed_assets_are_immutable(tmp_path):
    (tmp_path / "app.1234abcd.js").write_text("console.log('built')")
    response = hosted_http.static_response(tmp_path, {"dir": "."}, "app.1234abcd.js")
    try:
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    finally:
        response.close()


@pytest.mark.skipif(shutil.which("node") is None, reason="no node")
def test_reinstall_process_app_as_static_has_no_process_snapshot(apps):
    install_app(apps, "node20", source=NODE_SERVER)
    manifest = json.loads(workspace.read("shop", "extension-manifest.json")["content"])
    manifest.update(runtime="static", http={"health": "/", "dir": "public"})
    manifest.pop("entrypoint")
    workspace.write("shop", "extension-manifest.json", json.dumps(manifest))
    commit = workspace.commit("shop", "Switch to built UI", ALICE)["commit"]
    tree = apps.must(apps.git(["rev-parse", f"{commit}^{{tree}}"], apps.work_path("shop")), "tree").stdout.strip()
    result = extensions.install("shop", workspace_id="shop", version="1.0.0", commit=commit, tree=tree,
                                kind="app", runtime="static", entrypoint=None, memory_mb=64, token=None,
                                http=manifest["http"], base_env=BASE_ENV)
    assert result["running"] and result["process"] is None
    assert result["port"] == result["memoryMb"] == 0


def test_explicit_data_delete_refuses_slug_symlink(apps, tmp_path):
    install_app(apps)
    data = tmp_path / "data" / "shop"
    data.rmdir()
    other = tmp_path / "data" / "other-app"
    other.mkdir()
    (other / "saved.txt").write_text("another app")
    try:
        data.symlink_to(other, target_is_directory=True)
    except OSError:
        pytest.skip("Windows developer mode does not permit symlinks")
    with pytest.raises(StoreError, match="inside its volume"):
        extensions.uninstall("shop", delete_data=True)
    assert (other / "saved.txt").read_text() == "another app"


@pytest.mark.parametrize("http,runtime", [
    ({"health": "https://elsewhere/"}, "node20"), ({"health": "/../secret"}, "node20"),
    ({"health": "/", "port": 80}, "node20"), ({"health": "/", "dir": "."}, "node20"),
    ({"health": "/", "dir": "../"}, "static"), ({"health": "/"}, "static"),
])
def test_http_manifest_paths_are_closed(http, runtime):
    with pytest.raises(StoreError):
        hosted_http.validate_http(http, runtime)


def test_stream_resource_closed_even_if_iteration_never_starts():
    body = io.BytesIO(b"body")
    response = hosted_http.RelayResponse(200, {}, body)
    response.close()
    assert body.closed
    response.close()  # ASGI finally and iterator finally can both close it.
