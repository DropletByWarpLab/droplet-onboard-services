"""WARP-2900 (ADR-056 slice H2) — the first-party MCP host for a python312
extension.

An extension is a module that exports plain functions (the template's
``run(input)``); it is NOT an MCP server, and the sandbox has no network to
install an MCP SDK into it. This shim is the server: stdlib only, baked into
the image, started by the supervisor as ``python host.py <extension-dir>``.

It speaks MCP's JSON-RPC over plain HTTP (POST /mcp, ``application/json``
responses, no SSE) and ONLY on the loopback address inside the sandbox
container. The orchestrator never dials it: the sandbox relays to it
(extensions.py ``relay``), so nothing else on ``droplet-internal`` can reach
an extension at all.

What it serves comes from the verified manifest, not from the code:
``tools/list`` is ``provides.tools`` (name, description, inputSchema — no
annotations, so a tool cannot label itself read-only on the wire), and
``tools/call`` calls the tool's declared ``export`` with the arguments.

Every request must carry ``X-Droplet-Relay-Key`` equal to the key the
sandbox generated for this start (env ``DROPLET_EXT_RELAY_KEY``); an unset
key refuses everything. Another process in the container that connects to
the port without it gets a 401.
"""

from __future__ import annotations

import hmac
import importlib.util
import json
import os
import sys
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LOOPBACK = "127.0.0.1"
PROTOCOL_VERSION = "2025-06-18"
MANIFEST_FILE = "extension-manifest.json"
MAX_REQUEST_BYTES = 1024 * 1024
RELAY_KEY_HEADER = "X-Droplet-Relay-Key"


class Extension:
    """The manifest and the loaded entrypoint module of one extension dir."""

    def __init__(self, ext_dir: str):
        self.dir = os.path.realpath(ext_dir)
        with open(os.path.join(self.dir, MANIFEST_FILE), encoding="utf-8") as fh:
            self.manifest: dict[str, Any] = json.load(fh)
        entry = os.path.realpath(os.path.join(self.dir, self.manifest["entrypoint"]))
        if not entry.startswith(self.dir + os.sep):
            raise SystemExit("the entrypoint must be inside the extension directory")
        if self.dir not in sys.path:
            sys.path.insert(0, self.dir)
        spec = importlib.util.spec_from_file_location("droplet_extension_entry", entry)
        if spec is None or spec.loader is None:
            raise SystemExit(f"cannot load {self.manifest['entrypoint']}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.tools = {t["name"]: t for t in self.manifest["provides"]["tools"]}

    def listing(self) -> list[dict[str, Any]]:
        return [
            {"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
            for t in self.manifest["provides"]["tools"]
        ]

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = self.tools.get(name)
        if tool is None:
            raise KeyError(name)
        fn: Callable[[dict[str, Any]], Any] | None = getattr(self.module, tool["export"], None)
        if not callable(fn):
            return _tool_error(f"export {tool['export']} is not a function")
        try:
            result = fn(arguments)
        except Exception as exc:  # noqa: BLE001 — the extension's own failure, reported, never raised
            return _tool_error(f"{type(exc).__name__}: {exc}")
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}


def _tool_error(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle(ext: Extension, msg: Any) -> dict[str, Any] | None:
    """One JSON-RPC message → its response, or None for a notification."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return _error(None, -32600, "invalid request")
    if "id" not in msg:
        return None
    msg_id, method = msg["id"], msg["method"]
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    if method == "initialize":
        result: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": ext.manifest["id"], "version": ext.manifest["version"]},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": ext.listing()}
    elif method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            result = ext.call(str(name), arguments)
        except KeyError:
            return _error(msg_id, -32602, f"unknown tool: {name}")
    else:
        return _error(msg_id, -32601, f"method not found: {method}")
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def make_server(ext: Extension, port: int, relay_key: str) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:  # stdout/stderr go nowhere
            return

        def _send(self, status: int, body: dict[str, Any] | None) -> None:
            data = b"" if body is None else json.dumps(body).encode("utf-8")
            self.send_response(status)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            if self.path != "/mcp":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self.close_connection = True
                self._send(413 if length > 0 else 400, {"error": "bad request size"})
                return
            # Read the body before answering, even a refusal: a reply sent
            # over unread bytes resets the connection instead of delivering.
            raw = self.rfile.read(length)
            given = self.headers.get(RELAY_KEY_HEADER, "").encode("utf-8", "replace")
            if not relay_key or not hmac.compare_digest(given, relay_key.encode("utf-8")):
                self._send(401, {"error": "unauthorized"})
                return
            try:
                msg = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send(400, _error(None, -32700, "parse error"))
                return
            response = handle(ext, msg)
            if response is None:
                self._send(202, None)
            else:
                self._send(200, response)

        def do_GET(self) -> None:
            self._send(405, {"error": "POST /mcp only"})

    return ThreadingHTTPServer((LOOPBACK, port), Handler)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: host.py <extension-dir>", file=sys.stderr)
        return 2
    port = int(os.environ["DROPLET_EXT_PORT"])
    server = make_server(Extension(argv[1]), port, os.environ.get("DROPLET_EXT_RELAY_KEY", ""))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
