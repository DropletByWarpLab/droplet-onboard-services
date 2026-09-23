"""WARP-2895 — the process-supervision seam for ADR-056 slice H.

An extension in v1 (WARP-2900) is a directory in the box's store, run as a
long-lived process in THIS container, on the internal network, speaking MCP
over HTTP to the orchestrator and nothing else. This module is the seam that
starts, watches and stops such a process — it exists now so slice H does not
grow a second service with a second hardening table.

Gated off by default (``SANDBOX_PROCESS_SUPERVISION`` unset or ``0``): the
routes in main.py answer 404 until an operator turns it on, and no tool in the
registry reaches them at all.

What it does NOT decide: which code is legitimate. That is slice H's signed
statement and install path (extensions.py); this module runs what it is
handed, closed in shape (``resolve_argv``), under a process-level ceiling and
a stripped environment.

The ceiling (WARP-2900 H2 fixed the seam as WARP-2895 merged it)
------------------------------------------------------------------
The limits are set by a stdlib-only wrapper that then ``exec()``s the real
command — the workspace ``run`` shape (workspace.py ``_with_limits``), NOT a
``preexec_fn``: this server answers requests from a thread pool, and
``preexec_fn`` in a threaded process is unsafe. The pid the supervisor holds
is the command's own pid, because the wrapper replaces itself.

* NO ``RLIMIT_AS``. V8 reserves gigabytes of virtual address space it never
  touches (the pointer-compression cage), so the 256 MB address-space cap
  WARP-2895 set killed every Node process at start. Python fares no better
  as a SERVER: under a 64 MB cap the host shim cannot start a request thread
  (each reserves an 8 MB stack and glibc a 64 MB malloc arena — measured on
  Linux, "can't start new thread"). An address-space cap is not a memory
  budget, so none is set. What bounds an extension's memory instead: a node
  child's heap is capped with ``--max-old-space-size=<memoryMb>``; every
  install is accounted against the container's cgroup limit before it
  starts (extensions.py ``budget``); and the container's ``mem_limit`` is
  the hard ceiling. A per-extension RSS cap needs cgroup delegation, which
  this ``cap_drop: ALL`` container does not have.
* NO ``RLIMIT_NPROC`` by default (``SANDBOX_PROCESS_MAX_PROCS`` sets one).
  It is a per-UID ceiling, and without a user-namespace remap uid 1000 in
  this container IS uid 1000 in every other container and on the host: the
  kernel counts all of their tasks against it. WARP-2895's 16 starved node's
  own threads; 64 still refused the python host shim a request thread on a
  machine whose uid 1000 ran other workloads (measured under WSL2: "can't
  start new thread", served once the ceiling was lifted). Process fan-out is
  bounded by the container's ``pids_limit`` (a per-cgroup count, the right
  tool) instead.
* ``RLIMIT_FSIZE`` 64 MiB, the workspace value.

Environment
-----------
Every child starts from the caller's base environment (main.py ``CHILD_ENV``:
PATH, locale, HOME — no token, no service URL). An extension additionally
gets ``extra_env``, whose KEYS are an allowlist (``EXTRA_ENV_KEYS``): its id,
its loopback port, its call-back bearer, the relay key its host shim checks,
and the orchestrator URL. Any other key is refused with a 400, so no caller
can hand a child ``SANDBOX_SERVICE_TOKEN`` or any other secret by name.

Restart policy: ``never`` | ``on-failure`` (non-zero exit, up to
``max_restarts``) | ``always`` (up to ``max_restarts``). Exit state is
explicit — ``running`` | ``exited`` | ``failed`` | ``stopped`` — never
inferred from a missing pid.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal

SUPERVISION_ENABLED = os.getenv("SANDBOX_PROCESS_SUPERVISION", "0").strip() in {"1", "true", "yes"}

RestartPolicy = Literal["never", "on-failure", "always"]


class SupervisorError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status

# What a supervised process may BE. The request names an interpreter by its
# bare name and an entrypoint; this module resolves the interpreter to one of
# the two the image ships and confines the entrypoint to the extensions root
# (or to one of the first-party host shims baked into the image). `shell=False`
# everywhere, so no argument is ever interpreted by a shell — but a seam that
# would exec whatever it was handed is still the wrong shape for a service
# whose callers include code the box's owner wrote, so the shape is closed
# here and extensions.py narrows it further.
INTERPRETERS: dict[str, str] = {
    "python": os.getenv("SANDBOX_PYTHON_BIN", "/usr/local/bin/python"),
    "python3": os.getenv("SANDBOX_PYTHON_BIN", "/usr/local/bin/python"),
    "node": os.getenv("SANDBOX_NODE_BIN", "/usr/local/bin/node"),
}
NODE_INTERPRETERS = frozenset({"node"})
EXTENSIONS_DIR = os.path.realpath(os.getenv("SANDBOX_EXTENSIONS_DIR", "/var/lib/workspace-ext"))
# The first-party MCP host shims (ext_host/). An extension's own code is a
# module the shim imports; the shim is what the supervisor runs.
HOST_SHIMS_DIR = os.path.realpath(str(Path(__file__).resolve().parent / "ext_host"))
HOST_SHIMS = frozenset(os.path.join(HOST_SHIMS_DIR, name) for name in ("host.mjs", "host.py"))
_ARG_PATTERN = re.compile(r"^[A-Za-z0-9_./=:@%+-]{1,256}$")

# The only environment keys a caller may add to a child's base environment.
EXTRA_ENV_KEYS = frozenset(
    {
        "DROPLET_EXT_ID",
        "DROPLET_EXT_PORT",
        "DROPLET_EXT_TOKEN",
        "DROPLET_EXT_RELAY_KEY",
        "DROPLET_ORCHESTRATOR_URL",
    }
)
_ENV_VALUE = re.compile(r"^[A-Za-z0-9_./:=@+-]{0,512}$")


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def resolve_argv(argv: list[str], cwd: str | None) -> tuple[list[str], str]:
    """Turn a request's argv into the one this module will run, or raise.

    - argv[0] must be a bare interpreter name from INTERPRETERS (never a path);
    - argv[1] (the entrypoint) must resolve under EXTENSIONS_DIR — a relative
      path is taken from `cwd`, which must itself be under EXTENSIONS_DIR —
      or be exactly one of the image's host shims (HOST_SHIMS);
    - every further argument must match a conservative charset (no
      whitespace, no quotes, no shell metacharacters — not that a shell is
      ever involved).
    """
    if not argv:
        raise SupervisorError(400, "argv is empty")
    interpreter = INTERPRETERS.get(argv[0])
    if interpreter is None:
        raise SupervisorError(400, f"argv[0] must be one of {sorted(INTERPRETERS)}")
    base = os.path.realpath(cwd) if cwd else EXTENSIONS_DIR
    if not _inside(base, EXTENSIONS_DIR):
        raise SupervisorError(400, "cwd must be inside the extensions directory")
    if len(argv) < 2:
        raise SupervisorError(400, "argv needs an entrypoint after the interpreter")
    entry = os.path.realpath(os.path.join(base, argv[1]))
    if not _inside(entry, EXTENSIONS_DIR) and entry not in HOST_SHIMS:
        raise SupervisorError(400, "the entrypoint must be inside the extensions directory")
    for arg in argv[2:]:
        if not _ARG_PATTERN.match(arg):
            raise SupervisorError(400, "an argument carries characters this seam does not pass")
    return [interpreter, entry, *argv[2:]], base


def check_extra_env(extra_env: dict[str, str] | None) -> dict[str, str]:
    """The allowlist. Returns a copy, or raises SupervisorError(400)."""
    extra = dict(extra_env or {})
    unknown = sorted(set(extra) - EXTRA_ENV_KEYS)
    if unknown:
        raise SupervisorError(400, f"environment keys not allowed for a supervised process: {unknown}")
    for key, value in extra.items():
        if not isinstance(value, str) or not _ENV_VALUE.match(value):
            raise SupervisorError(400, f"environment value for {key} carries characters this seam does not pass")
    return extra


CHILD_MAX_MEMORY_BYTES = int(os.getenv("SANDBOX_CHILD_MAX_MEMORY_BYTES", str(256 * 1024 * 1024)))
# Per-UID across containers; 0 = not set (see the module docstring).
CHILD_MAX_PROCS = int(os.getenv("SANDBOX_PROCESS_MAX_PROCS", "0"))
CHILD_MAX_FILE_BYTES = 64 * 1024 * 1024

# argv: [nproc, fsize, executable, *args]
_LIMIT_WRAPPER = """
import os, resource, sys
nproc, fsize = int(sys.argv[1]), int(sys.argv[2])
limits = [(resource.RLIMIT_FSIZE, fsize)]
if nproc > 0:
    limits.append((resource.RLIMIT_NPROC, nproc))
for r, v in limits:
    try:
        resource.setrlimit(r, (v, v))
    except (ValueError, OSError):
        pass
os.execv(sys.argv[3], sys.argv[3:])
"""


def with_limits(exe: list[str], *, posix: bool | None = None) -> list[str]:
    """The exec wrapper around `exe`: process fan-out and file size, nothing else."""
    if not (os.name == "posix" if posix is None else posix):
        return exe  # a Windows dev checkout: no rlimits, run it plainly
    return [
        sys.executable, "-I", "-S", "-c", _LIMIT_WRAPPER,
        str(CHILD_MAX_PROCS), str(CHILD_MAX_FILE_BYTES),
        *exe,
    ]


def limited_command(
    argv0: str, resolved: list[str], memory_mb: int | None, *, posix: bool | None = None
) -> list[str]:
    """What is actually exec'd for a resolved argv: the limits wrapper, and
    for node a heap cap of the budget (``memory_mb``, else the child default)."""
    if argv0 in NODE_INTERPRETERS:
        budget_mb = memory_mb or CHILD_MAX_MEMORY_BYTES // (1024 * 1024)
        exe = [resolved[0], f"--max-old-space-size={max(16, budget_mb)}", *resolved[1:]]
        return with_limits(exe, posix=posix)
    return with_limits(resolved, posix=posix)


class _Entry:
    def __init__(self, proc_id: str, argv: list[str], cwd: str | None, restart: RestartPolicy, max_restarts: int, env: dict):
        self.id = proc_id
        self.argv = argv
        self.cwd = cwd
        self.restart = restart
        self.max_restarts = max_restarts
        self.env = env
        self.proc: subprocess.Popen | None = None
        self.state: str = "starting"
        self.restarts = 0
        self.started_at = time.time()
        self.exit_code: int | None = None
        self.stop_requested = False

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "pid": self.proc.pid if self.proc and self.state == "running" else None,
            "restarts": self.restarts,
            "exitCode": self.exit_code,
            "startedAt": self.started_at,
            "restartPolicy": self.restart,
        }


class Supervisor:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._lock = threading.Lock()

    def _spawn(self, entry: _Entry) -> None:
        # No preexec_fn: the limits are the wrapper's job (limited_command).
        entry.proc = subprocess.Popen(
            entry.argv,
            cwd=entry.cwd,
            env=entry.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        entry.state = "running"
        entry.started_at = time.time()
        threading.Thread(target=self._watch, args=(entry,), daemon=True).start()

    def _watch(self, entry: _Entry) -> None:
        assert entry.proc is not None
        code = entry.proc.wait()
        with self._lock:
            entry.exit_code = code
            if entry.stop_requested:
                entry.state = "stopped"
                return
            wants_restart = entry.restart == "always" or (entry.restart == "on-failure" and code != 0)
            if wants_restart and entry.restarts < entry.max_restarts:
                entry.restarts += 1
                try:
                    self._spawn(entry)
                    return
                except OSError:
                    entry.state = "failed"
                    return
            entry.state = "exited" if code == 0 else "failed"

    def start(
        self,
        proc_id: str,
        argv: list[str],
        *,
        cwd: str | None,
        restart: RestartPolicy,
        max_restarts: int,
        env: dict,
        extra_env: dict[str, str] | None = None,
        memory_mb: int | None = None,
    ) -> dict[str, Any]:
        resolved_argv, resolved_cwd = resolve_argv(argv, cwd)
        child_env = {**env, **check_extra_env(extra_env)}
        command = limited_command(argv[0], resolved_argv, memory_mb)
        with self._lock:
            existing = self._entries.get(proc_id)
            if existing and existing.state == "running":
                raise SupervisorError(409, f"process {proc_id} is already running")
            entry = _Entry(proc_id, command, resolved_cwd, restart, max_restarts, child_env)
            try:
                self._spawn(entry)
            except OSError as exc:
                raise SupervisorError(400, f"could not start {proc_id}: {exc}") from exc
            self._entries[proc_id] = entry
            return entry.snapshot()

    def status(self, proc_id: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._entries.get(proc_id)
            return entry.snapshot() if entry else None

    def forget(self, proc_id: str) -> None:
        """Drop a non-running entry (uninstall)."""
        with self._lock:
            entry = self._entries.get(proc_id)
            if entry is not None and entry.state != "running":
                del self._entries[proc_id]

    def stop(self, proc_id: str, grace_s: float = 5.0) -> dict[str, Any] | None:
        with self._lock:
            entry = self._entries.get(proc_id)
            if entry is None:
                return None
            entry.stop_requested = True
            proc = entry.proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=grace_s)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=grace_s)
        # Let the watcher record the final state.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self._lock:
                if entry.state in {"stopped", "exited", "failed"}:
                    break
            time.sleep(0.02)
        with self._lock:
            if entry.state == "running":
                entry.state = "stopped"
            return entry.snapshot()


SUPERVISOR = Supervisor()
