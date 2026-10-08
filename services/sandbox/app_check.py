"""WARP-3906: a bounded, temporary HTTP smoke check before app promotion.

This is a workspace command, not an install: no bearer, callback, persistent
data directory or supervised process survives it. The container remains the
security boundary, as it is for the workspace's build and test commands.
"""

from __future__ import annotations

import http.client
import io
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import hosted_http
from gitstore import StoreError

MAX_TIMEOUT_MS = 30_000
BODY_CAP_BYTES = 2048
OUTPUT_CAP_BYTES = 64 * 1024
MANIFEST_CAP_BYTES = 256 * 1024
NODE_BIN = os.getenv("SANDBOX_NODE_BIN", "/usr/local/bin/node")
_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
_RESERVED = frozenset({".git", ".workspace", "_droplet"})


def _path(root: Path, relative: str, *, directory: bool = False) -> Path:
    if not isinstance(relative, str) or len(relative) > 256:
        raise StoreError(400, "app-check needs a confined relative app path")
    if directory and relative == ".":
        return root.resolve()
    parts = relative.split("/")
    if not parts or any(not _PATH_SEGMENT.fullmatch(p) or p in _RESERVED for p in parts):
        raise StoreError(400, "app-check needs a confined relative app path")
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise StoreError(400, "app-check does not follow app symlinks")
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise StoreError(400, "app-check path escapes the workspace") from exc
    return target


def _manifest(work: Path) -> tuple[dict[str, Any], str]:
    path = _path(work, "extension-manifest.json")
    if not path.is_file():
        raise StoreError(400, "app-check needs a regular extension-manifest.json file")
    try:
        with path.open("rb") as fh:
            raw = fh.read(MANIFEST_CAP_BYTES + 1)
        if len(raw) > MANIFEST_CAP_BYTES:
            raise StoreError(413, "app-check manifest exceeds 256 KiB")
        manifest = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StoreError(400, "app-check needs a readable extension-manifest.json") from exc
    if not isinstance(manifest, dict) or manifest.get("kind") != "app":
        raise StoreError(400, "app-check is only available for kind: app")
    runtime = manifest.get("runtime")
    if manifest.get("egress") != "none" or not isinstance(runtime, str) or runtime not in {"static", "node20", "python312"}:
        raise StoreError(400, "app-check needs a supported app runtime with egress: none")
    http = hosted_http.validate_http(manifest.get("http"), manifest["runtime"])
    health = http["health"]
    if health.startswith("//") or any(p in _RESERVED for p in health.split("/")):
        raise StoreError(400, "app-check health path must be local and unreserved")
    tools = manifest.get("provides", {}).get("tools") if isinstance(manifest.get("provides"), dict) else None
    if tools != []:
        raise StoreError(400, "an app cannot provide tools in v1")
    return manifest, health


def _static(work: Path, manifest: dict[str, Any], health: str) -> dict[str, Any]:
    http = manifest["http"]
    if "entrypoint" in manifest:
        raise StoreError(400, "a static app has no entrypoint")
    _path(work, http["dir"], directory=True)

    def read(path: str) -> dict[str, Any]:
        response = hosted_http.static_response(work, http, path)
        try:
            body = response.body.read(BODY_CAP_BYTES + 1) if response.body is not None else b""
            return {"path": path, "status": response.status, "body": body[:BODY_CAP_BYTES].decode("utf-8", "replace"),
                    "truncated": len(body) > BODY_CAP_BYTES}
        finally:
            response.close()

    return {"runtime": "static", "health": read(health), "root": read("/")}


class _Capture:
    """Drain bounded output without waiting for an escaped fork's pipe EOF."""

    def __init__(self, pipe: Any):
        self.pipe = pipe
        self.data = bytearray()
        self.truncated = False
        self.stop = threading.Event()
        os.set_blocking(pipe.fileno(), False)
        self.thread = threading.Thread(target=self._read, name=f"app-check-output-{id(self)}", daemon=True)
        self.thread.start()

    def _read(self) -> None:
        try:
            while not self.stop.is_set():
                chunk = self.pipe.read(8192)
                if chunk is None:
                    self.stop.wait(0.01)
                elif not chunk:
                    return
                else:
                    left = OUTPUT_CAP_BYTES - len(self.data)
                    self.data.extend(chunk[:left])
                    self.truncated = self.truncated or len(chunk) > left
        except (OSError, ValueError):
            self.truncated = True
        finally:
            self.pipe.close()

    def finish(self, deadline: float) -> str:
        self.thread.join(timeout=max(0.0, min(0.1, deadline - time.monotonic())))
        if self.thread.is_alive():
            self.truncated = True
            self.stop.set()
            self.thread.join(timeout=max(0.0, min(0.1, deadline - time.monotonic())))
        return bytes(self.data).decode("utf-8", "replace")


def _kill(proc: subprocess.Popen, deadline: float) -> None:
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif proc.poll() is None:
        proc.kill()
    try:
        proc.wait(timeout=max(0.01, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        pass


def _probe(port: int, path: str, deadline: float) -> dict[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("app-check exceeded its HTTP deadline")
    response = None
    try:
        response = hosted_http.proxy_response(port, "GET", path, "", {}, io.BytesIO(), 0, remaining)
        body = response.body.read(BODY_CAP_BYTES + 1) if response.body is not None else b""
        if response.expired.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("app-check exceeded its HTTP deadline")
        return {"path": path, "status": response.status, "body": body[:BODY_CAP_BYTES].decode("utf-8", "replace"),
                "truncated": len(body) > BODY_CAP_BYTES}
    except StoreError as exc:
        if exc.status == 504:
            raise TimeoutError(str(exc)) from exc
        if exc.status == 502:
            raise ConnectionError(str(exc)) from exc
        raise
    finally:
        if response is not None:
            response.close()


def run(work: Path, timeout_ms: int, *, env: dict[str, str],
        with_limits: Callable[[list[str]], list[str]]) -> dict[str, Any]:
    started = time.monotonic()
    budget_ms = max(1000, min(int(timeout_ms), MAX_TIMEOUT_MS))
    deadline = started + budget_ms / 1000
    # Cleanup is part of the same budget, including killing and reaping children.
    probe_deadline = deadline - min(0.5, budget_ms / 4000)
    manifest, health = _manifest(work)
    runtime = manifest["runtime"]
    facts: dict[str, Any] = {"runtime": runtime, "health": None, "root": None}
    timed_out = False
    error = ""
    stdout = stderr = ""
    truncated = False
    executable = "app-check"
    if runtime == "static":
        facts = _static(work, manifest, health)
    else:
        if "dir" in manifest["http"] or "spa" in manifest["http"]:
            raise StoreError(400, "process apps cannot declare a static directory or spa")
        entrypoint = _path(work, manifest.get("entrypoint"))
        if not entrypoint.is_file():
            raise StoreError(400, "app-check entrypoint is not a file")
        resources = manifest.get("resources")
        memory = resources.get("memoryMb") if isinstance(resources, dict) else None
        if type(memory) is not int or not 16 <= memory <= 4096:
            raise StoreError(400, "app-check needs a process memory budget of 16–4096 MB")
        if type(resources.get("processes")) is not int or resources["processes"] != 1:
            raise StoreError(400, "an app requires exactly one process")
        import extensions

        left = extensions.budget()["availableMb"]
        if memory > left:
            raise StoreError(409, f"app-check needs {memory} MB; only {left} MB remains in the sandbox")
        executable = NODE_BIN if runtime == "node20" else sys.executable
        command = [executable, *([f"--max-old-space-size={memory}"] if runtime == "node20" else []), str(entrypoint)]
        proc = None
        captures: list[_Capture] = []
        with tempfile.TemporaryDirectory(prefix="app-check-") as data_dir:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as bound:
                bound.bind(("127.0.0.1", 0))
                port = bound.getsockname()[1]
            child_env = {**env, "HOME": data_dir, "TMPDIR": data_dir, "TEMP": data_dir, "TMP": data_dir,
                         "PORT": str(port), "DROPLET_EXT_PORT": str(port), "DROPLET_EXT_ID": work.name,
                         "DROPLET_EXT_BASE_PATH": f"/{work.name}/", "DROPLET_EXT_DATA_DIR": data_dir}
            base_path = child_env["DROPLET_EXT_BASE_PATH"]
            try:
                proc = subprocess.Popen(with_limits(command), cwd=str(work), env=child_env,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        close_fds=True, start_new_session=True, bufsize=0)
                captures.append(_Capture(proc.stdout))
                captures.append(_Capture(proc.stderr))
                while time.monotonic() < probe_deadline:
                    if proc.poll() is not None:
                        error = f"app exited before its health check (exit {proc.returncode})"
                        break
                    try:
                        facts["health"] = _probe(port, base_path + health.lstrip("/"), probe_deadline)
                        if 200 <= facts["health"]["status"] < 300:
                            facts["bindingVerified"] = hosted_http.assert_loopback_listener(port)
                            break
                    except (OSError, http.client.HTTPException):
                        pass  # the server may still be starting
                    time.sleep(min(0.025, max(0.0, probe_deadline - time.monotonic())))
                else:
                    timed_out = True
                if not timed_out and not error:
                    try:
                        facts["root"] = _probe(port, base_path, probe_deadline)
                    except (OSError, http.client.HTTPException) as exc:
                        timed_out = time.monotonic() >= probe_deadline
                        error = f"app root probe failed: {exc}"
            except StoreError as exc:
                error = str(exc)
            except (OSError, RuntimeError) as exc:
                error = f"could not start app: {exc}"
            finally:
                if proc is not None:
                    _kill(proc, deadline)
                if captures:
                    output = [c.finish(deadline) for c in captures]
                    stdout, stderr = (output + [""])[:2]
                    truncated = any(c.truncated for c in captures)
                if proc is not None:
                    for pipe in (proc.stdout, proc.stderr):
                        if pipe is not None and not any(c.pipe is pipe for c in captures):
                            pipe.close()
    passed = not error and not timed_out and all(isinstance(facts[key], dict) and 200 <= facts[key]["status"] < 300 for key in ("health", "root"))
    report = json.dumps(facts, ensure_ascii=False) + "\n"
    combined = (report + stdout).encode("utf-8")
    stderr_bytes = (error + ("\n" if error and stderr else "") + stderr).encode("utf-8")
    truncated = truncated or len(combined) > OUTPUT_CAP_BYTES or len(stderr_bytes) > OUTPUT_CAP_BYTES or any(
        facts[key].get("truncated", False) for key in ("health", "root") if isinstance(facts[key], dict))
    return {"argv": ["app-check"], "executable": executable, "exitCode": None if timed_out else (0 if passed else 1),
            "timedOut": timed_out, "durationMs": int((time.monotonic() - started) * 1000),
            "stdout": combined[:OUTPUT_CAP_BYTES].decode("utf-8", "replace"),
            "stderr": stderr_bytes[:OUTPUT_CAP_BYTES].decode("utf-8", "replace"),
            "truncated": truncated, "appCheck": facts,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
