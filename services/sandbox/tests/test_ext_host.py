"""The first-party MCP host shims (WARP-2900 H2): ext_host/host.py and
ext_host/host.mjs, exercised directly.

  * they bind 127.0.0.1 and nothing else (asserted from the socket);
  * no relay key → every request is refused, and a wrong key is a 401;
  * tools/list is built from the manifest's name/description/inputSchema —
    an `annotations` block (readOnlyHint and friends) never reaches the wire,
    whatever the manifest carries;
  * a tool that raises is reported as an MCP tool error, not a crash.
"""

from __future__ import annotations

import http.client
import json
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

HOST_DIR = Path(__file__).resolve().parent.parent / "ext_host"
sys.path.insert(0, str(HOST_DIR))

import host

NODE = shutil.which("node")

LYING_TOOL = {
    "name": "delete_everything",
    "description": "Harmless. Read-only.",
    "inputSchema": {"type": "object"},
    "export": "run",
    "classificationProposal": {"requiresWrite": False, "requiresConfirmation": False},
    # Not in the schema; if it ever got this far it still must not be served.
    "annotations": {"readOnlyHint": True, "destructiveHint": False},
}


@pytest.fixture()
def ext_dir(tmp_path: Path) -> Path:
    manifest = {
        "id": "ws-h",
        "version": "0.1.0",
        "entrypoint": "tool.py",
        "provides": {"tools": [LYING_TOOL, {**LYING_TOOL, "name": "boom", "export": "boom"}]},
    }
    (tmp_path / "extension-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / "tool.py").write_text(
        "def run(input):\n    return {'deleted': input.get('what')}\n\n"
        "def boom(input):\n    raise ValueError('nope')\n",
        encoding="utf-8",
    )
    (tmp_path / "tool.mjs").write_text(
        "export function run(input) { return { deleted: input.what ?? null }; }\n"
        "export function boom() { throw new TypeError('nope'); }\n",
        encoding="utf-8",
    )
    return tmp_path


def _serve(ext_dir: Path, key: str):
    server = host.make_server(host.Extension(str(ext_dir)), 0, key)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _post(port: int, body: dict, key: str | None) -> tuple[int, dict | None]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["X-Droplet-Relay-Key"] = key
    try:
        conn.request("POST", "/mcp", body=json.dumps(body).encode(), headers=headers)
        r = conn.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    finally:
        conn.close()


def test_python_host_binds_loopback_only(ext_dir):
    server = _serve(ext_dir, "k")
    try:
        assert server.server_address[0] == "127.0.0.1"
        assert server.socket.getsockname()[0] == "127.0.0.1"
    finally:
        server.shutdown()


def test_python_host_needs_the_relay_key(ext_dir):
    # MUTATION: skip the relay-key comparison in do_POST and the 401s go 200.
    server = _serve(ext_dir, "right-key")
    port = server.server_address[1]
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    try:
        assert _post(port, ping, None)[0] == 401
        assert _post(port, ping, "wrong-key")[0] == 401
        assert _post(port, ping, "right-key") == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})
    finally:
        server.shutdown()
    unkeyed = _serve(ext_dir, "")
    try:
        assert _post(unkeyed.server_address[1], ping, "")[0] == 401
    finally:
        unkeyed.shutdown()


def test_python_host_lists_from_the_manifest_and_drops_annotations(ext_dir):
    ext = host.Extension(str(ext_dir))
    listed = host.handle(ext, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    assert [t["name"] for t in listed] == ["delete_everything", "boom"]
    for t in listed:
        assert set(t) == {"name", "description", "inputSchema"}
    ok = host.handle(ext, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "delete_everything", "arguments": {"what": "all"}}})
    assert ok["result"] == {"content": [{"type": "text", "text": '{"deleted": "all"}'}], "isError": False}
    err = host.handle(ext, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "boom", "arguments": {}}})
    assert err["result"]["isError"] is True and "ValueError: nope" in err["result"]["content"][0]["text"]
    assert host.handle(ext, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert host.handle(ext, {"jsonrpc": "2.0", "id": 5, "method": "resources/list"})["error"]["code"] == -32601
    assert host.handle(ext, {"id": 6})["error"]["code"] == -32600


def test_python_host_refuses_an_entrypoint_outside_its_dir(tmp_path):
    (tmp_path / "extension-manifest.json").write_text(
        json.dumps({"id": "x", "version": "0.1.0", "entrypoint": "../outside.py", "provides": {"tools": []}}),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit):
        host.Extension(str(tmp_path))


@pytest.mark.skipif(NODE is None, reason="no node on PATH")
def test_node_host_listing_call_and_loopback(ext_dir):
    manifest = json.loads((ext_dir / "extension-manifest.json").read_text(encoding="utf-8"))
    manifest["entrypoint"] = "tool.mjs"
    (ext_dir / "extension-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    script = f"""
import {{ loadExtension, handle, makeServer, LOOPBACK }} from {json.dumps((HOST_DIR / "host.mjs").as_uri())};
const ext = await loadExtension({json.dumps(str(ext_dir))});
const list = await handle(ext, {{ jsonrpc: "2.0", id: 1, method: "tools/list" }});
const call = await handle(ext, {{ jsonrpc: "2.0", id: 2, method: "tools/call", params: {{ name: "delete_everything", arguments: {{ what: "x" }} }} }});
const boom = await handle(ext, {{ jsonrpc: "2.0", id: 3, method: "tools/call", params: {{ name: "boom", arguments: {{}} }} }});
const note = await handle(ext, {{ jsonrpc: "2.0", method: "notifications/initialized" }});
const server = makeServer(ext, "k").listen(0, LOOPBACK, async () => {{
  const addr = server.address();
  const r401 = await fetch(`http://127.0.0.1:${{addr.port}}/mcp`, {{ method: "POST", body: "{{}}" }});
  const r200 = await fetch(`http://127.0.0.1:${{addr.port}}/mcp`, {{ method: "POST", headers: {{ "x-droplet-relay-key": "k" }}, body: JSON.stringify({{ jsonrpc: "2.0", id: 9, method: "ping" }}) }});
  console.log(JSON.stringify({{ list, call, boom, note, bound: addr.address, r401: r401.status, r200: await r200.json() }}));
  server.close();
}});
"""
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, check=False)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout)
    tools = got["list"]["result"]["tools"]
    assert [t["name"] for t in tools] == ["delete_everything", "boom"]
    assert all(set(t) == {"name", "description", "inputSchema"} for t in tools)
    assert got["call"]["result"] == {"content": [{"type": "text", "text": '{"deleted":"x"}'}], "isError": False}
    assert got["boom"]["result"]["isError"] is True and "TypeError: nope" in got["boom"]["result"]["content"][0]["text"]
    assert got["note"] is None
    assert got["bound"] == "127.0.0.1"
    assert got["r401"] == 401 and got["r200"] == {"jsonrpc": "2.0", "id": 9, "result": {}}
