"""Probe the live Wyoming catalog without performing inference."""
import json
import socket

with socket.create_connection(("127.0.0.1", 10200), timeout=3) as sock:
    sock.sendall(b'{"type":"describe","payload_length":0}\n')
    with sock.makefile("rb") as stream:
        event = json.loads(stream.readline(16385))
    if event.get("type") != "info" or not event.get("data", {}).get("tts"):
        raise SystemExit(1)
