"""Extensions in the sandbox (WARP-2900, ADR-056 slice H2): install, relay,
stop, uninstall — real git, real host shims, real child processes.

What this file pins:

  * a proposal is read from the BARE repository at its tag, and install
    exports exactly the signed commit — a tree that is not the statement's
    tree is refused (the store cannot be rewritten under a signature);
  * the installed dir is read-only, the host shim answers MCP JSON-RPC on
    127.0.0.1 only, and only with the per-start relay key;
  * the child's environment is the base env plus the allowlisted extension
    keys — the sandbox's own bearer never reaches it;
  * the memory budget is enforced, and the relay's output cap is REPORTED;
  * every new route is 404 while SANDBOX_PROCESS_SUPERVISION is off.

The node cases need a `node` on PATH (the CI runner has one; the image
ships Node 20). The TypeScript build case additionally needs a `tsc`: the
repo's node_modules on a dev checkout, the image's global one in the box.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import shutil
import socket
import sys
from pathlib import Path

import pytest

import extensions
import supervisor
import workspace
from gitstore import StoreError

ALICE = ("Alice", "alice@example.test")
TOKEN = "dxt_" + "a" * 43
NODE = shutil.which("node")
REPO_TSC = Path(__file__).resolve().parents[3] / "node_modules" / "typescript" / "bin" / "tsc"
BASE_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C.UTF-8"}

needs_node = pytest.mark.skipif(NODE is None, reason="no node on PATH")


@pytest.fixture()
def ext(store, tmp_path, monkeypatch):
    root = tmp_path / "ext"
    root.mkdir()
    monkeypatch.setattr(supervisor, "EXTENSIONS_DIR", os.path.realpath(str(root)))
    monkeypatch.setattr(supervisor, "SUPERVISOR", supervisor.Supervisor())
    monkeypatch.setattr(
        supervisor,
        "INTERPRETERS",
        {"python": sys.executable, "python3": sys.executable, "node": NODE or "/usr/local/bin/node"},
    )
    monkeypatch.setattr(extensions, "_installed", {})
    monkeypatch.setattr(extensions, "CGROUP_MEMORY_FILES", ())
    monkeypatch.setattr(extensions, "FALLBACK_MEMORY_MB", 1024)
    yield store
    for slug in list(extensions._installed):
        extensions.uninstall(slug)


def _propose(store, ws: str, template: str | None, version: str = "0.1.0") -> dict:
    if not store.work_path(ws).exists():
        store.create_workspace(ws, template, ALICE)
    workspace.propose(ws, "Word counter", version, "Counts words.", ALICE)
    found = store.read_at_tag(ws, f"proposal/{version}")
    found["parsed"] = json.loads(found["manifest"])
    return found


def _install(ws: str, found: dict, slug: str | None = None, **over) -> dict:
    m = found["parsed"]
    kwargs = {
        "workspace_id": ws,
        "version": m["version"],
        "commit": found["commit"],
        "tree": found["tree"],
        "runtime": m["runtime"],
        "entrypoint": m["entrypoint"],
        "memory_mb": m["resources"]["memoryMb"],
        "token": TOKEN,
        "base_env": BASE_ENV,
    }
    kwargs.update(over)
    return extensions.install(slug or ws, **kwargs)


def _rpc(slug: str, method: str, params: dict | None = None, msg_id: int = 1) -> dict:
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    status, data = extensions.relay(slug, json.dumps(body).encode("utf-8"))
    assert status == 200, data
    return json.loads(data)


def _call_word_count(slug: str, text: str) -> dict:
    out = _rpc(slug, "tools/call", {"name": "word_count", "arguments": {"text": text}})["result"]
    assert out["isError"] is False, out
    return json.loads(out["content"][0]["text"])


# ── the proposal, read from the bare repository ─────────────────────────────


def test_read_at_tag_returns_the_committed_manifest_commit_and_tree(ext):
    found = _propose(ext, "ws-a", "python-tool")
    bare = ext.bare_path("ws-a")
    assert found["commit"] == ext.git(["rev-parse", "proposal/0.1.0^{commit}"], bare).stdout.strip()
    assert found["tree"] == ext.git(["rev-parse", "proposal/0.1.0^{tree}"], bare).stdout.strip()
    committed = ext.git(["cat-file", "blob", "proposal/0.1.0:extension-manifest.json"], bare, binary=True).stdout
    assert found["manifest"] == committed
    with pytest.raises(StoreError) as exc:
        ext.read_at_tag("ws-a", "proposal/9.9.9")
    assert exc.value.status == 404
    for bad in ("main", "proposal/../x", "refs/heads/work"):
        with pytest.raises(StoreError):
            ext.read_at_tag("ws-a", bad)


def test_a_commit_with_no_manifest_reads_as_none_not_an_error(ext):
    ext.create_workspace("ws-b", None, ALICE)
    work = ext.work_path("ws-b")
    ext.git(["tag", "-a", "proposal/0.1.0", "-m", "draft"], work, author=ALICE)
    ext.git(["push", "-q", "origin", "refs/tags/proposal/0.1.0"], work)
    assert ext.read_at_tag("ws-b", "proposal/0.1.0")["manifest"] is None


def test_export_refuses_a_tree_that_is_not_the_signed_tree(ext, tmp_path):
    # MUTATION: drop the `actual != tree` check in export_commit and this
    # exports the commit under a statement that names another tree.
    found = _propose(ext, "ws-c", "python-tool")
    with pytest.raises(StoreError) as exc:
        ext.export_commit("ws-c", found["commit"], "0" * 40, tmp_path / "out")
    assert exc.value.status == 409
    assert not (tmp_path / "out").exists()
    ext.export_commit("ws-c", found["commit"], found["tree"], tmp_path / "ok")
    assert (tmp_path / "ok" / "tool.py").is_file()


# ── install, relay, stop, uninstall ─────────────────────────────────────────


def test_python_extension_installs_answers_mcp_and_uninstalls(ext):
    found = _propose(ext, "ws-d", "python-tool")
    assert found["parsed"]["runtime"] == "python312"
    st = _install("ws-d", found)
    assert st["running"] is True and st["version"] == "0.1.0"

    init = _rpc("ws-d", "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert init["result"]["serverInfo"] == {"name": "ws-d", "version": "0.1.0"}
    tools = _rpc("ws-d", "tools/list")["result"]["tools"]
    assert [t["name"] for t in tools] == ["word_count"]
    # The listing is name/description/inputSchema only: no annotations.
    assert set(tools[0]) == {"name", "description", "inputSchema"}
    assert _call_word_count("ws-d", "hello big world") == {"words": 3, "characters": 15}
    unknown = _rpc("ws-d", "tools/call", {"name": "nope", "arguments": {}})
    assert unknown["error"]["code"] == -32602

    # A notification gets no body.
    status, data = extensions.relay("ws-d", json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode())
    assert status == 202 and data == b""

    stopped = extensions.stop("ws-d")
    assert stopped is not None and stopped["state"] == "stopped"
    out = extensions.uninstall("ws-d")
    assert out == {"slug": "ws-d", "uninstalled": True, "existed": True}
    assert not (Path(supervisor.EXTENSIONS_DIR) / "ws-d").exists()
    with pytest.raises(StoreError) as exc:
        extensions.status("ws-d")
    assert exc.value.status == 404


def test_the_installed_dir_is_read_only(ext):
    found = _propose(ext, "ws-e", "python-tool")
    _install("ws-e", found)
    installed = Path(supervisor.EXTENSIONS_DIR) / "ws-e" / "0.1.0"
    assert (installed / "tool.py").is_file()
    assert not os.access(installed / "tool.py", os.W_OK)
    assert not os.access(installed / "extension-manifest.json", os.W_OK)


def test_the_child_env_is_the_base_env_plus_the_allowlisted_keys(ext):
    # The sandbox's own bearer is in THIS process's environment (conftest);
    # it must not reach the extension. MUTATION: build the child env from
    # os.environ in Supervisor.start and SANDBOX_SERVICE_TOKEN shows up.
    ext.create_workspace("ws-f", "python-tool", ALICE)
    workspace.write(
        "ws-f",
        "tool.py",
        "import os\n\ndef run(input):\n    return sorted(os.environ)\n",
    )
    workspace.commit("ws-f", "env probe", ALICE)
    found = _propose(ext, "ws-f", None)
    _install("ws-f", found)
    out = _rpc("ws-f", "tools/call", {"name": "word_count", "arguments": {}})["result"]
    keys = set(json.loads(out["content"][0]["text"]))
    assert os.environ.get("SANDBOX_SERVICE_TOKEN")
    assert "SANDBOX_SERVICE_TOKEN" not in keys
    assert not any(k.endswith("_TOKEN") and k != "DROPLET_EXT_TOKEN" for k in keys)
    assert {"DROPLET_EXT_ID", "DROPLET_EXT_PORT", "DROPLET_EXT_TOKEN", "DROPLET_EXT_RELAY_KEY"} <= keys
    base = set(BASE_ENV) | {"SYSTEMROOT", "HOME"}  # the last two: a Windows dev checkout only
    assert keys - supervisor.EXTRA_ENV_KEYS - base == set(), keys


def test_a_manifest_that_does_not_match_the_request_is_refused(ext):
    found = _propose(ext, "ws-g", "python-tool")
    with pytest.raises(StoreError) as exc:
        _install("ws-g", found, runtime="node20", entrypoint="dist/index.js")
    assert exc.value.status == 409
    assert not (Path(supervisor.EXTENSIONS_DIR) / "ws-g" / "0.1.0").exists()
    for bad in ("../tool.py", "/etc/passwd", "a/../../b"):
        with pytest.raises(StoreError):
            extensions._inside(Path(supervisor.EXTENSIONS_DIR), bad)


def test_the_memory_budget_is_enforced(ext, monkeypatch, tmp_path):
    # MUTATION: drop the budget check in install() and the second install
    # lands over the container's ceiling.
    limit = tmp_path / "memory.max"
    limit.write_text(str((256 + 100) * 1024 * 1024), encoding="utf-8")
    monkeypatch.setattr(extensions, "CGROUP_MEMORY_FILES", (limit,))
    b = extensions.budget()
    assert b == {"ceilingMb": 356, "source": "cgroup", "transformHeadroomMb": 256, "installedMb": 0, "availableMb": 100}
    first = _propose(ext, "ws-h", "python-tool")  # 64 MB
    _install("ws-h", first)
    assert extensions.budget()["availableMb"] == 36
    second = _propose(ext, "ws-i", "python-tool")
    with pytest.raises(StoreError) as exc:
        _install("ws-i", second)
    assert exc.value.status == 409 and "does not fit" in str(exc.value)
    # Reinstalling the SAME extension does not count it twice.
    _install("ws-h", first)
    limit.write_text("max", encoding="utf-8")
    assert extensions.budget()["source"] == "env"


def test_the_relay_reports_an_answer_over_the_cap(ext, monkeypatch):
    # MUTATION: return the sliced bytes instead of raising and the relay
    # hands the orchestrator half a JSON document as if it were whole.
    found = _propose(ext, "ws-j", "python-tool")
    _install("ws-j", found)
    monkeypatch.setattr(extensions, "RELAY_OUTPUT_CAP_BYTES", 64)
    with pytest.raises(StoreError) as exc:
        extensions.relay("ws-j", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode())
    assert exc.value.status == 502 and "more than 64 bytes" in str(exc.value)


def test_the_shim_refuses_a_caller_without_the_relay_key(ext):
    # Another process in the container can connect to 127.0.0.1:<port>; it
    # cannot drive the extension without the key the sandbox holds.
    found = _propose(ext, "ws-k", "python-tool")
    st = _install("ws-k", found)
    conn = http.client.HTTPConnection("127.0.0.1", st["port"], timeout=5)
    try:
        conn.request("POST", "/mcp", body=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                     headers={"Content-Type": "application/json"})
        assert conn.getresponse().status == 401
    finally:
        conn.close()


@needs_node
def test_node_extension_starts_under_the_limits_and_answers(ext):
    # The WARP-2895 seam set RLIMIT_AS=256MB on every child, and V8 cannot
    # start under it. On Linux this runs node through the real limits
    # wrapper. MUTATION: pass as_bytes=budget for node in limited_command
    # and the process never answers (it dies at start) — red on the runner.
    ext.create_workspace("ws-l", None, ALICE)
    manifest = json.loads(
        (Path(__file__).resolve().parents[3] / "extensions" / "templates" / "typescript-tool" / "extension-manifest.json").read_text(encoding="utf-8")
    )
    manifest["entrypoint"] = "lib/index.mjs"
    workspace.write("ws-l", "extension-manifest.json", json.dumps(manifest))
    workspace.write(
        "ws-l",
        "lib/index.mjs",
        "export function run(input) {\n  const t = String(input.text ?? '').trim();\n"
        "  return { words: t === '' ? 0 : t.split(/\\s+/).length, characters: String(input.text ?? '').length };\n}\n",
    )
    workspace.commit("ws-l", "plain js", ALICE)
    found = _propose(ext, "ws-l", None)
    assert found["parsed"]["runtime"] == "node20"
    st = _install("ws-l", found)
    assert st["running"] is True
    assert _call_word_count("ws-l", "one two") == {"words": 2, "characters": 7}
    # Bound to loopback: the port answers on 127.0.0.1.
    with socket.create_connection(("127.0.0.1", st["port"]), timeout=5):
        pass


@needs_node
@pytest.mark.skipif(not (REPO_TSC.is_file() or os.path.exists(extensions.TSC_ARGV[0])), reason="no tsc on this machine")
def test_typescript_template_builds_with_tsc_and_answers(ext, monkeypatch):
    if REPO_TSC.is_file():
        monkeypatch.setattr(extensions, "TSC_ARGV", [NODE, str(REPO_TSC)])
    found = _propose(ext, "ws-m", "typescript-tool")
    assert found["parsed"]["entrypoint"] == "dist/index.js"
    _install("ws-m", found)
    assert (Path(supervisor.EXTENSIONS_DIR) / "ws-m" / "0.1.0" / "dist" / "index.js").is_file()
    assert _call_word_count("ws-m", "a b c d") == {"words": 4, "characters": 7}


def test_a_failing_build_is_a_422_with_the_compiler_output(ext, monkeypatch):
    fake_tsc = Path(supervisor.EXTENSIONS_DIR).parent / "fake_tsc.py"
    fake_tsc.write_text("import sys\nprint('src/index.ts(1,1): error TS1005')\nsys.exit(2)\n", encoding="utf-8")
    monkeypatch.setattr(extensions, "TSC_ARGV", [sys.executable, str(fake_tsc)])
    found = _propose(ext, "ws-n", "typescript-tool")
    with pytest.raises(StoreError) as exc:
        _install("ws-n", found)
    assert exc.value.status == 422 and "TS1005" in str(exc.value)
    assert not (Path(supervisor.EXTENSIONS_DIR) / "ws-n" / "0.1.0").exists()


# ── the HTTP layer ──────────────────────────────────────────────────────────


NEW_ROUTES = [
    ("get", "/workspaces/ws-a/proposals/0.1.0/manifest", None),
    ("get", "/extensions/budget", None),
    ("get", "/extensions/ws-a", None),
    ("post", "/extensions/ws-a/install", {}),
    ("post", "/extensions/ws-a/rpc", {"jsonrpc": "2.0", "id": 1, "method": "ping"}),
    ("delete", "/extensions/ws-a/process", None),
    ("delete", "/extensions/ws-a", None),
]


@pytest.mark.parametrize("method,path,body", NEW_ROUTES)
def test_every_extension_route_is_404_while_supervision_is_off(client, auth, monkeypatch, method, path, body):
    # MUTATION: drop `dependencies=[Depends(_processes_enabled)]` from any one
    # route and its case goes red.
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", False)
    kwargs = {"headers": auth}
    if body is not None:
        kwargs["json"] = body
    r = getattr(client, method)(path, **kwargs)
    # The gate's own answer, not a 404 from behind it ("not installed",
    # "no workspace") that would pass for the wrong reason.
    assert r.status_code == 404 and r.json() == {"detail": "Not found"}


def test_routes_round_trip_when_enabled(client, auth, ext, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    _propose(ext, "ws-o", "python-tool")
    r = client.get("/workspaces/ws-o/proposals/0.1.0/manifest", headers=auth)
    assert r.status_code == 200, r.text
    got = r.json()
    manifest = json.loads(base64.b64decode(got["manifest"]))
    assert manifest["id"] == "ws-o" and got["tag"] == "proposal/0.1.0"

    install = {
        "workspaceId": "ws-o",
        "version": "0.1.0",
        "commit": got["commit"],
        "tree": got["tree"],
        "runtime": "python312",
        "entrypoint": "tool.py",
        "memoryMb": 64,
        "token": TOKEN,
    }
    # The body is closed: an extra key (an env var, an argv) is refused.
    assert client.post("/extensions/ws-o/install", json={**install, "env": {"X": "1"}}, headers=auth).status_code == 422
    assert client.post("/extensions/ws-o/install", json={**install, "token": "not-a-dxt"}, headers=auth).status_code == 422
    r = client.post("/extensions/ws-o/install", json=install, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["running"] is True

    rpc = client.post("/extensions/ws-o/rpc", json={"jsonrpc": "2.0", "id": 7, "method": "tools/list"}, headers=auth)
    assert rpc.status_code == 200 and rpc.json()["result"]["tools"][0]["name"] == "word_count"
    assert client.get("/extensions/ws-o", headers=auth).json()["running"] is True
    assert client.get("/extensions/budget", headers=auth).json()["installedMb"] == 64
    assert client.delete("/extensions/ws-o/process", headers=auth).json()["state"] == "stopped"
    assert client.delete("/extensions/ws-o", headers=auth).json()["uninstalled"] is True
    assert client.get("/extensions/ws-o", headers=auth).status_code == 404
    assert client.post("/extensions/Bad_Slug/rpc", json={}, headers=auth).status_code in (400, 404)


def test_extension_routes_need_the_bearer(client, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    assert client.get("/extensions/budget").status_code == 401
    assert client.post("/extensions/ws-a/rpc", json={}).status_code == 401
