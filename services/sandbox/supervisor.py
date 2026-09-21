"""WARP-2895 — the process-supervision seam for ADR-056 slice H.

An extension in v1 (WARP-2900) is a directory in the box's store, run as a
long-lived process in THIS container, on the internal network, speaking MCP
over HTTP to the orchestrator and nothing else. This module is the seam that
starts, watches and stops such a process — it exists now so slice H does not
grow a second service with a second hardening table.

Gated off by default (``SANDBOX_PROCESS_SUPERVISION`` unset or ``0``): the
routes in main.py answer 404 until an operator turns it on, and no tool in the
registry reaches them at all in this ticket.

What it does NOT decide: which argv is legitimate. That is slice H's manifest
verifier and install path; this module runs what it is handed, under the same
process-level ceiling as a transform (RLIMIT_NPROC / RLIMIT_AS via
``preexec_fn``) and the same stripped environment.

Restart policy: ``never`` | ``on-failure`` (non-zero exit, up to
``max_restarts``) | ``always`` (up to ``max_restarts``). Exit state is
explicit — ``running`` | ``exited`` | ``failed`` | ``stopped`` — never
inferred from a missing pid.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from typing import Any, Literal

try:  # POSIX only; the container is Linux.
    import resource
except ImportError:  # pragma: no cover
    resource = None  # type: ignore[assignment]

SUPERVISION_ENABLED = os.getenv("SANDBOX_PROCESS_SUPERVISION", "0").strip() in {"1", "true", "yes"}

RestartPolicy = Literal["never", "on-failure", "always"]


class SupervisorError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status

# What a supervised process may BE. The request names an interpreter by its
# bare name and an entrypoint; this module resolves the interpreter to one of
# the two the image ships and confines the entrypoint to the extensions root.
# `shell=False` everywhere, so no argument is ever interpreted by a shell —
# but a seam that would exec whatever it was handed is still the wrong shape
# for a service whose callers include code the box's owner wrote, so the
# shape is closed here and slice H's manifest verifier narrows it further.
INTERPRETERS: dict[str, str] = {
    "python": os.getenv("SANDBOX_PYTHON_BIN", "/usr/local/bin/python"),
    "python3": os.getenv("SANDBOX_PYTHON_BIN", "/usr/local/bin/python"),
    "node": os.getenv("SANDBOX_NODE_BIN", "/usr/local/bin/node"),
}
EXTENSIONS_DIR = os.path.realpath(os.getenv("SANDBOX_EXTENSIONS_DIR", "/ext"))
_ARG_PATTERN = re.compile(r"^[A-Za-z0-9_./=:@%+-]{1,256}$")


def resolve_argv(argv: list[str], cwd: str | None) -> tuple[list[str], str]:
    """Turn a request's argv into the one this module will run, or raise.

    - argv[0] must be a bare interpreter name from INTERPRETERS (never a path);
    - argv[1] (the entrypoint) must resolve under EXTENSIONS_DIR — a relative
      path is taken from `cwd`, which must itself be under EXTENSIONS_DIR;
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
    if base != EXTENSIONS_DIR and not base.startswith(EXTENSIONS_DIR + os.sep):
        raise SupervisorError(400, "cwd must be inside the extensions directory")
    if len(argv) < 2:
        raise SupervisorError(400, "argv needs an entrypoint after the interpreter")
    entry = os.path.realpath(os.path.join(base, argv[1]))
    if entry != EXTENSIONS_DIR and not entry.startswith(EXTENSIONS_DIR + os.sep):
        raise SupervisorError(400, "the entrypoint must be inside the extensions directory")
    for arg in argv[2:]:
        if not _ARG_PATTERN.match(arg):
            raise SupervisorError(400, "an argument carries characters this seam does not pass")
    return [interpreter, entry, *argv[2:]], base

CHILD_MAX_MEMORY_BYTES = int(os.getenv("SANDBOX_CHILD_MAX_MEMORY_BYTES", str(256 * 1024 * 1024)))
# A long-lived server may fork workers; give it a small allowance, not zero.
CHILD_MAX_PROCS = int(os.getenv("SANDBOX_PROCESS_MAX_PROCS", "16"))




def _limits() -> None:
    if resource is None:  # pragma: no cover
        return
    try:
        resource.setrlimit(resource.RLIMIT_AS, (CHILD_MAX_MEMORY_BYTES, CHILD_MAX_MEMORY_BYTES))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (CHILD_MAX_PROCS, CHILD_MAX_PROCS))
    except (ValueError, OSError):
        pass


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
        entry.proc = subprocess.Popen(
            entry.argv,
            cwd=entry.cwd,
            env=entry.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            **({"preexec_fn": _limits} if os.name == "posix" else {}),
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

    def start(self, proc_id: str, argv: list[str], *, cwd: str | None, restart: RestartPolicy, max_restarts: int, env: dict) -> dict[str, Any]:
        resolved_argv, resolved_cwd = resolve_argv(argv, cwd)
        with self._lock:
            existing = self._entries.get(proc_id)
            if existing and existing.state == "running":
                raise SupervisorError(409, f"process {proc_id} is already running")
            entry = _Entry(proc_id, resolved_argv, resolved_cwd, restart, max_restarts, env)
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
