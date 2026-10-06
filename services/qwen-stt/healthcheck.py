"""Probe the loaded model through Wyoming; used by compose readiness."""
import json
import socket

with socket.create_connection(("127.0.0.1", 10300), timeout=3) as sock:
    sock.sendall(b'{"type":"describe"}\n')
    response = json.loads(sock.makefile("rb").readline(8192))
    if response.get("type") != "info" or not response.get("data", {}).get("asr"):
        raise SystemExit(1)
