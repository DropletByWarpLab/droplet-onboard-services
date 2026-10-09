"""WARP-2900 (ADR-056 slice H2) — install, run, relay to, stop and uninstall
an extension in this container.

The orchestrator has already verified the signed statement (commit + tree +
manifest digest) and resolved the owner before it calls here. This module
still refuses on its own what it can check, because a guard that lives in one
place is one bug from gone:

  * the commit it exports must have the tree the statement names
    (gitstore.export_commit), so the store cannot be rewritten under a
    signed statement;
  * the exported manifest must name the runtime and entrypoint the caller
    claims, and the entrypoint must stay inside the extension dir;
  * the memory the manifest asks for must fit what is left of the
    container's budget after every other installed extension and the
    transform child's ceiling.

Install, step by step
---------------------
  1. ``git archive <commit>`` into ``<EXTENSIONS_DIR>/<slug>/<version>``
     (tree checked first; tarfile's data filter refuses links out);
  2. node20 with a tsconfig.json: ``tsc -p .`` with the image's global tsc,
     through the supervisor's limits wrapper, with a timeout — no network,
     nothing installed;
  3. the whole dir is made read-only and owner-only (files 0400, dirs 0500);
  4. a free loopback port from ``SANDBOX_EXTENSION_PORT_RANGE``;
  5. the runtime's first-party host shim (ext_host/) is started under the
     supervisor: NEVER restarted by it, the manifest's memory budget, and an
     environment of the base CHILD_ENV plus the allowlisted extension keys
     (id, port, the orchestrator call-back bearer, the relay key);
  6. ready when the shim answers a relayed ``ping``.

No supervisor restart (review #2323): the installed dir belongs to the uid
every workspace ``run`` child also runs as, so a run could rewrite it and
kill the process, and a supervisor restart would then run the rewrite under
the extension's bearer without re-verifying anything. A dead extension comes
back only through ``install`` — the orchestrator's reconciler calls it, a
bounded number of times — which re-exports the signed commit, after the
orchestrator has re-verified the statement and rotated the bearer.

The orchestrator never dials an extension: ``relay`` does, on 127.0.0.1, with
a timeout and an output cap that is REPORTED when hit, never a silent slice.

What is installed lives in this process's memory. A sandbox restart forgets
it; the orchestrator's reconciler notices (``status`` 404) and installs again
from the store, re-verifying the statement and rotating the bearer first. The
reconciler also reads ``listing`` and stops a process whose extension should
not be running (a disable whose stop failed, an install that outlived the
orchestrator's timeout).
"""

from __future__ import annotations

import hmac
import http.client
import io
import json
import os
import re
import secrets
import socket
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import gitstore
import hosted_http
import supervisor
from gitstore import StoreError

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,26}$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
ENTRYPOINT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$")
EXT_TOKEN = re.compile(r"^dxt_[A-Za-z0-9_-]{20,128}$")
MEMORY_MB_MIN, MEMORY_MB_MAX = 16, 4096

# runtime → (interpreter name in supervisor.INTERPRETERS, host shim file)
RUNTIMES: dict[str, tuple[str, str]] = {
    "node20": ("node", "host.mjs"),
    "python312": ("python", "host.py"),
}

TSC_ARGV: list[str] = [os.getenv("SANDBOX_TSC_BIN", "/usr/local/bin/tsc")]
BUILD_TIMEOUT_S = int(os.getenv("SANDBOX_EXTENSION_BUILD_TIMEOUT_S", "180"))
BUILD_OUTPUT_TAIL = 4000
READY_TIMEOUT_S = float(os.getenv("SANDBOX_EXTENSION_READY_TIMEOUT_S", "15"))
RELAY_DEFAULT_TIMEOUT_MS = 30_000
RELAY_MAX_TIMEOUT_MS = 120_000
RELAY_OUTPUT_CAP_BYTES = int(os.getenv("SANDBOX_EXTENSION_OUTPUT_CAP_BYTES", str(1024 * 1024)))


def _port_range() -> range:
    raw = os.getenv("SANDBOX_EXTENSION_PORT_RANGE", "18000-18999")
    lo, _, hi = raw.partition("-")
    return range(int(lo), int(hi) + 1)


PORT_RANGE = _port_range()

# The memory budget. The container's cgroup limit when it can be read,
# else SANDBOX_MEMORY_LIMIT_MB (compose's mem_limit default, 512m).
CGROUP_MEMORY_FILES = (
    Path("/sys/fs/cgroup/memory.max"),  # cgroup v2
    Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),  # cgroup v1
)
FALLBACK_MEMORY_MB = int(os.getenv("SANDBOX_MEMORY_LIMIT_MB", "512"))
# A transform child may use up to its own ceiling at any moment; that much
# is never handed to an extension.
TRANSFORM_HEADROOM_MB = supervisor.CHILD_MAX_MEMORY_BYTES // (1024 * 1024)

BUILD_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",
    "LC_ALL": "C.UTF-8",
    "NO_COLOR": "1",
    "CI": "1",
}


def _dev_env(env: dict[str, str]) -> dict[str, str]:
    """A Windows dev checkout needs PATH and SYSTEMROOT for a child to start
    (sockets fail without SYSTEMROOT); the image is Linux and never takes this."""
    if sys.platform != "win32":
        return env
    return {
        **env,
        "PATH": os.environ.get("PATH", ""),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
        "HOME": os.environ.get("TEMP", ""),
    }


@dataclass
class Installed:
    slug: str
    workspace_id: str
    version: str
    runtime: str
    directory: Path
    port: int
    relay_key: str
    memory_mb: int
    kind: str = "extension"
    http: dict[str, Any] | None = None
    serving: bool = False

    def public(self) -> dict[str, Any]:
        snap = None if self.runtime == "static" else supervisor.SUPERVISOR.status(proc_id(self.slug))
        return {
            "slug": self.slug,
            "workspaceId": self.workspace_id,
            "version": self.version,
            "runtime": self.runtime,
            "memoryMb": self.memory_mb,
            "port": self.port,
            "process": snap,
            "running": self.serving if self.runtime == "static" else bool(snap and snap["state"] == "running"),
            "kind": self.kind,
        }


_installed: dict[str, Installed] = {}
_lock = threading.Lock()


def proc_id(slug: str) -> str:
    return f"ext-{slug}"


def extensions_root() -> Path:
    # Read at call time: tests re-point supervisor.EXTENSIONS_DIR.
    return Path(supervisor.EXTENSIONS_DIR)


# Words a fixed route under /extensions/ already owns: GET /extensions/budget
# is declared before GET /extensions/{slug}, so an extension with this slug
# could never be asked for its status (the orchestrator reserves it too).
RESERVED_SLUGS = frozenset({"budget"})


def check_slug(slug: str) -> str:
    if not SLUG.match(slug or ""):
        raise StoreError(400, "extension slug must match ^[a-z0-9][a-z0-9-]{0,26}$")
    if slug in RESERVED_SLUGS:
        raise StoreError(400, f"extension slug {slug!r} is reserved")
    return slug


# ── the memory budget ───────────────────────────────────────────────────────


def _cgroup_limit_mb() -> int | None:
    for path in CGROUP_MEMORY_FILES:
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if raw == "max" or not raw.isdigit():
            continue
        value = int(raw)
        # cgroup v1 reports "unlimited" as a huge number.
        if value >= 1 << 60:
            continue
        return value // (1024 * 1024)
    return None


# Supervisor states whose process holds (or is about to hold) its memory.
_LIVE_STATES = frozenset({"starting", "running"})


def _holds_memory(slug: str) -> bool:
    snap = supervisor.SUPERVISOR.status(proc_id(slug))
    return bool(snap and snap["state"] in _LIVE_STATES)


def budget(excluding: str | None = None) -> dict[str, Any]:
    """Memory left for one more extension. Only a process that is running
    counts: a disabled (stopped) or dead extension stays in ``_installed`` for
    its status, but holds nothing."""
    cgroup = _cgroup_limit_mb()
    ceiling = cgroup if cgroup is not None else FALLBACK_MEMORY_MB
    with _lock:
        entries = [(s, e.memory_mb) for s, e in _installed.items() if s != excluding]
    installed = sum(mb for s, mb in entries if _holds_memory(s))
    available = max(0, ceiling - TRANSFORM_HEADROOM_MB - installed)
    return {
        "ceilingMb": ceiling,
        "source": "cgroup" if cgroup is not None else "env",
        "transformHeadroomMb": TRANSFORM_HEADROOM_MB,
        "installedMb": installed,
        "availableMb": available,
    }


# ── the filesystem ──────────────────────────────────────────────────────────


def _make_readonly(root: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):
                os.chmod(p, stat.S_IRUSR)
        for name in dirnames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):
                os.chmod(p, stat.S_IRUSR | stat.S_IXUSR)
    os.chmod(root, stat.S_IRUSR | stat.S_IXUSR)


def _remove_tree(root: Path) -> None:
    """Undo _make_readonly (a read-only dir cannot lose its entries), then remove."""
    if not root.exists():
        return
    os.chmod(root, stat.S_IRWXU)
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):
                os.chmod(p, stat.S_IRWXU)
        for name in filenames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):
                os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
    gitstore._rmtree(root)


def _inside(root: Path, rel: str) -> Path:
    if not ENTRYPOINT.match(rel or ""):
        raise StoreError(400, "entrypoint must be a relative path with no '.' or '..' segment")
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, rel))
    if not target.startswith(base + os.sep):
        raise StoreError(400, "entrypoint must stay inside the extension directory")
    return Path(target)


# ── install ─────────────────────────────────────────────────────────────────


def _build(directory: Path) -> None:
    """tsc -p . for a node20 extension that carries a tsconfig.json."""
    cmd = supervisor.with_limits([*TSC_ARGV, "-p", "."])
    try:
        cp = subprocess.run(
            cmd,
            cwd=str(directory),
            env=_dev_env(dict(BUILD_ENV)),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=BUILD_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise StoreError(422, f"the TypeScript build exceeded {BUILD_TIMEOUT_S} s") from exc
    except OSError as exc:
        raise StoreError(500, f"could not start tsc: {exc}") from exc
    if cp.returncode != 0:
        out = (cp.stdout or b"").decode("utf-8", "replace") + (cp.stderr or b"").decode("utf-8", "replace")
        raise StoreError(422, f"the TypeScript build failed: {out.strip()[-BUILD_OUTPUT_TAIL:]}")


def _pick_port(taken: set[int]) -> int:
    for port in PORT_RANGE:
        if port in taken:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise StoreError(503, "no free loopback port left in SANDBOX_EXTENSION_PORT_RANGE")


def install(
    slug: str,
    *,
    workspace_id: str,
    version: str,
    commit: str,
    tree: str,
    runtime: str,
    entrypoint: str | None,
    memory_mb: int,
    token: str | None,
    base_env: dict[str, str],
    orchestrator_url: str | None = None,
    kind: str = "extension",
    http: dict[str, Any] | None = None,
) -> dict[str, Any]:
    check_slug(slug)
    gitstore.check_id(workspace_id)
    if not SEMVER.match(version or ""):
        raise StoreError(400, "version must be semver")
    if kind not in {"extension", "app"} or runtime not in {*RUNTIMES, "static"}:
        raise StoreError(400, "unsupported extension kind or runtime")
    is_app = kind == "app"
    if is_app:
        http = hosted_http.validate_http(http, runtime)
        if runtime == "static" and entrypoint is not None:
            raise StoreError(400, "a static app has no entrypoint")
        if token is not None or orchestrator_url is not None:
            raise StoreError(400, "an app receives no orchestrator credential or callback URL")
    elif runtime == "static" or http is not None:
        raise StoreError(400, "static runtime and http are app-only")
    if not isinstance(memory_mb, int) or not MEMORY_MB_MIN <= memory_mb <= MEMORY_MB_MAX:
        raise StoreError(400, f"memoryMb must be {MEMORY_MB_MIN}–{MEMORY_MB_MAX}")
    if not is_app and not EXT_TOKEN.match(token or ""):
        raise StoreError(400, "token must be a dxt_ extension bearer")
    left = budget(excluding=slug)
    process_memory_mb = 0 if runtime == "static" else memory_mb
    if process_memory_mb > left["availableMb"]:
        raise StoreError(
            409,
            f"memoryMb {memory_mb} does not fit: {left['availableMb']} MB left of {left['ceilingMb']} MB "
            f"({left['installedMb']} MB installed, {left['transformHeadroomMb']} MB kept for transforms)",
        )

    # A reinstall (enable, a new version, the reconciler) replaces the old
    # process and directory.
    stop(slug)
    root = extensions_root()
    slug_dir = root / slug
    directory = slug_dir / version
    _remove_tree(directory)
    slug_dir.mkdir(parents=True, exist_ok=True)
    try:
        gitstore.export_commit(workspace_id, commit, tree, directory)
        try:
            manifest = json.loads((directory / gitstore.MANIFEST_PATH).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise StoreError(409, "the exported commit carries no readable extension-manifest.json") from exc
        if not isinstance(manifest, dict):
            raise StoreError(409, "the exported manifest must be an object")
        if (manifest.get("runtime") != runtime or manifest.get("entrypoint") != entrypoint
                or manifest.get("kind") != kind):
            raise StoreError(409, "the exported manifest does not name the runtime and entrypoint asked for")
        if is_app:
            if not isinstance(manifest.get("provides"), dict) or manifest["provides"].get("tools") != []:
                raise StoreError(409, "an app must not provide tools")
            resources = manifest.get("resources")
            if (not isinstance(resources, dict) or type(resources.get("processes")) is not int
                    or resources["processes"] != 1):
                raise StoreError(409, "an app must declare exactly one process")
            if (manifest.get("http") != http or resources.get("memoryMb") != memory_mb
                    or manifest.get("egress") != "none"):
                raise StoreError(409, "the exported app manifest disagrees with its HTTP, budget or egress request")
        if runtime == "node20" and (directory / "tsconfig.json").is_file():
            _build(directory)
        if runtime == "static":
            hosted_http.static_root(directory, http)
        else:
            entry = _inside(directory, entrypoint)
            if not entry.is_file():
                raise StoreError(422, f"entrypoint {entrypoint} does not exist after the build")
        _make_readonly(directory)
    except Exception:
        _remove_tree(directory)
        raise

    with _lock:
        taken = {e.port for s, e in _installed.items() if s != slug}
    port = 0 if runtime == "static" else _pick_port(taken)
    relay_key = secrets.token_urlsafe(32)
    extra_env = {
        "DROPLET_EXT_ID": slug,
        "DROPLET_EXT_PORT": str(port),
    }
    if is_app:
        data = Path(os.getenv("SANDBOX_EXTENSIONS_DATA_DIR", "/var/lib/workspace-ext-data")) / slug
        root_data = data.parent.resolve()
        if data.is_symlink() or data.resolve() != root_data / slug:
            raise StoreError(409, "app data directory must stay inside its volume")
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        data.chmod(0o700)
        extra_env.update({"PORT": str(port), "DROPLET_EXT_BASE_PATH": f"/{slug}/",
                          "DROPLET_EXT_DATA_DIR": data.resolve().as_posix()})
    else:
        extra_env.update({"DROPLET_EXT_TOKEN": token, "DROPLET_EXT_RELAY_KEY": relay_key})
        if orchestrator_url:
            extra_env["DROPLET_ORCHESTRATOR_URL"] = orchestrator_url
    if runtime != "static":
        interpreter, shim = RUNTIMES[runtime]
        argv = [interpreter, entrypoint] if is_app else [interpreter, os.path.join(supervisor.HOST_SHIMS_DIR, shim), "."]
        try:
            supervisor.SUPERVISOR.start(
                proc_id(slug), argv, cwd=str(directory), restart="never", max_restarts=0,
                env=_dev_env(dict(base_env)), extra_env=extra_env, memory_mb=memory_mb,
            )
        except supervisor.SupervisorError as exc:
            raise StoreError(exc.status, str(exc)) from exc
    entry_rec = Installed(slug, workspace_id, version, runtime, directory, port, relay_key,
                          process_memory_mb, kind, http, serving=runtime == "static")
    with _lock:
        _installed[slug] = entry_rec
    try:
        ready = _wait_ready(entry_rec)
    except Exception:
        stop(slug)
        raise
    if not ready:
        stop(slug)
        raise StoreError(502, f"extension {slug} did not answer on its loopback port within {READY_TIMEOUT_S:g} s")
    return {**entry_rec.public(), **({"relayKey": relay_key} if is_app else {})}


def _post(entry: Installed, body: bytes, timeout_s: float) -> tuple[int, bytes, bool]:
    """POST to the extension's shim. Returns (status, body, over_cap). A
    plain loopback connection: no proxy variable can redirect it."""
    conn = http.client.HTTPConnection("127.0.0.1", entry.port, timeout=timeout_s)
    try:
        conn.request(
            "POST",
            "/mcp",
            body=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Droplet-Relay-Key": entry.relay_key,
            },
        )
        resp = conn.getresponse()
        data = resp.read(RELAY_OUTPUT_CAP_BYTES + 1)
        return resp.status, data[:RELAY_OUTPUT_CAP_BYTES], len(data) > RELAY_OUTPUT_CAP_BYTES
    finally:
        conn.close()


def _wait_ready(entry: Installed) -> bool:
    if entry.kind == "app":
        deadline = time.monotonic() + READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if not entry.public()["running"]:
                return False
            ready = False
            try:
                if entry.runtime == "static":
                    response = hosted_http.static_response(entry.directory, entry.http, entry.http["health"])
                else:
                    response = hosted_http.proxy_response(entry.port, "GET", f"/{entry.slug}" + entry.http["health"], "", {},
                                                          io.BytesIO(), 0, min(2.0, deadline - time.monotonic()))
                try:
                    ready = 200 <= response.status < 300
                finally:
                    response.close()
            except StoreError:
                pass
            if ready:
                if entry.runtime != "static":
                    hosted_http.assert_loopback_listener(entry.port)
                return True
            time.sleep(0.1)
        return False
    ping = json.dumps({"jsonrpc": "2.0", "id": 0, "method": "ping"}).encode("utf-8")
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        snap = supervisor.SUPERVISOR.status(proc_id(entry.slug))
        if snap and snap["state"] in {"failed", "exited", "stopped"}:
            return False
        try:
            status, _, _ = _post(entry, ping, 2.0)
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(0.1)
    return False


# ── relay, status, stop, uninstall ──────────────────────────────────────────


def _get(slug: str) -> Installed:
    check_slug(slug)
    with _lock:
        entry = _installed.get(slug)
    if entry is None:
        raise StoreError(404, f"extension {slug} is not installed in this sandbox")
    return entry


def relay(slug: str, body: bytes, timeout_ms: int | None = None) -> tuple[int, bytes]:
    entry = _get(slug)
    if entry.kind != "extension":
        raise StoreError(400, "apps do not expose MCP RPC")
    timeout_ms = max(1000, min(int(timeout_ms or RELAY_DEFAULT_TIMEOUT_MS), RELAY_MAX_TIMEOUT_MS))
    try:
        status, data, over = _post(entry, body, timeout_ms / 1000)
    except TimeoutError as exc:
        raise StoreError(504, f"extension {slug} did not answer within {timeout_ms} ms") from exc
    except OSError as exc:
        raise StoreError(502, f"extension {slug} is not answering: {exc}") from exc
    if over:
        raise StoreError(502, f"extension {slug} answered more than {RELAY_OUTPUT_CAP_BYTES} bytes; nothing was relayed")
    if not 200 <= status < 300:
        # The status is the extension's choice (its code runs in the shim).
        # Relayed as-is, a 503 or a bare 404 would read at the orchestrator
        # as the sandbox's own "bearer not configured" / "supervision off".
        raise StoreError(502, f"extension {slug} answered HTTP {status}")
    return status, data


def status(slug: str) -> dict[str, Any]:
    return _get(slug).public()


def stop(slug: str) -> dict[str, Any] | None:
    check_slug(slug)
    with _lock:
        entry = _installed.get(slug)
        if entry and entry.runtime == "static":
            entry.serving = False
            return {"id": proc_id(slug), "state": "stopped", "pid": None, "exitCode": None}
    return supervisor.SUPERVISOR.stop(proc_id(slug))


def uninstall(slug: str, *, delete_data: bool = False) -> dict[str, Any]:
    check_slug(slug)
    supervisor.SUPERVISOR.stop(proc_id(slug))
    supervisor.SUPERVISOR.forget(proc_id(slug))
    with _lock:
        existed = _installed.pop(slug, None) is not None
    slug_dir = extensions_root() / slug
    existed = existed or slug_dir.exists()
    _remove_tree(slug_dir)
    if delete_data:
        # The orchestrator owns the typed confirmation; this internal call
        # must name the deletion explicitly. Default uninstall keeps data.
        data_root = Path(os.getenv("SANDBOX_EXTENSIONS_DATA_DIR", "/var/lib/workspace-ext-data")).resolve()
        data = data_root / slug
        if not data.is_symlink() and data.resolve() == data_root / slug:
            _remove_tree(data)
        else:
            raise StoreError(409, "app data directory must stay inside its volume")
    return {"slug": slug, "uninstalled": True, "existed": existed}


def installed_slugs() -> list[str]:
    with _lock:
        return sorted(_installed)


def listing() -> list[dict[str, Any]]:
    """Every extension this sandbox holds, and whether its process runs. The
    orchestrator's reconciler stops one whose row says it must not run."""
    out = []
    for slug in installed_slugs():
        entry = _get(slug)
        out.append({"slug": slug, "running": entry.public()["running"]})
    return out


def app_request(slug: str, relay_key: str, method: str, path: str, query: str,
                headers: dict[str, str], body, body_bytes: int,
                timeout_s: float = hosted_http.MAX_TIMEOUT_S) -> hosted_http.RelayResponse:
    entry = _get(slug)
    if entry.kind != "app":
        raise StoreError(400, "HTTP serving is app-only")
    if not relay_key or not relay_key.isascii() or not hmac.compare_digest(relay_key, entry.relay_key):
        raise StoreError(403, "app relay key refused")
    if not entry.public()["running"]:
        raise StoreError(503, "app is stopped")
    if entry.runtime == "static":
        return hosted_http.static_response(entry.directory, entry.http, path, method, headers)
    # The server sees the same base path the public gateway gives the app.
    return hosted_http.proxy_response(entry.port, method, f"/{slug}/" + path.lstrip("/"),
                                      query, headers, body, body_bytes, timeout_s)


def app_logs(slug: str, limit: int = 200, since: int | None = None) -> dict[str, Any]:
    entry = _get(slug)
    if entry.kind != "app":
        raise StoreError(400, "app logs are app-only")
    if entry.runtime == "static":
        return {"id": proc_id(slug), "output": "", "process": False,
                "note": "static apps have no process output"}
    logs = supervisor.SUPERVISOR.logs(proc_id(slug), limit=limit, since=since)
    return {**(logs or {"id": proc_id(slug), "output": ""}), "process": True}
