"""WARP-2895 (ADR-056 §6.3, ADR-047 §4) — services/sandbox.

ONE hardened execution service, on the first internal-only network in the
compose file, with three customers over time: routine `transform` / `when`
steps (this ticket), workshop runs (slice G) and extension processes (slice H,
through the supervision seam below). One service, one hardening table — two
sandboxes with two tables is how one of them drifts.

What this process is
--------------------
A thin HTTP front over ``subprocess``. It holds no credential but its own
bearer, reaches no database, mounts no socket, and — by the compose file, not
by anything here — can dial nothing: the container sits on ``droplet-internal``
(``internal: true``) and nowhere else. Its registered egress is NONE
(docs/security/allowed-egress.yaml), and that absence is the whole reason
customer-written code is safe to run here.

The API
-------
    GET  /health                       no auth
    POST /transform                    { code, inputs, timeoutMs, outputCapBytes }
                                       → { output } | { error }
    POST /processes                    slice H's seam; gated, see supervisor.py
    GET  /processes/{id}
    DELETE /processes/{id}

Every `/transform` is ONE child process (runner.py), killed on completion or
at the deadline. The deadline is enforced HERE and by the orchestrator caller
(sandbox.client.ts) — a service-only timeout fails open if the service itself
hangs. The output cap is reported when hit, never silently sliced: a
summarizer that quietly received half its facts writes a confident, wrong
briefing (ROUTINES brief §4.4).

Auth: bearer ``SANDBOX_SERVICE_TOKEN``, fail-closed (503 on every non-/health
route when unset) — the doc-render / web-fetch posture, deliberately without a
dev escape.
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

import supervisor

SANDBOX_SERVICE_TOKEN = os.getenv("SANDBOX_SERVICE_TOKEN", "").strip()

AUTH_EXEMPT_PATHS = frozenset({"/health"})

RUNNER = Path(__file__).resolve().parent / "runner.py"

# Ceilings the request may ask for, never exceed. The orchestrator passes its
# own (config SANDBOX_TRANSFORM_TIMEOUT_MS / SANDBOX_OUTPUT_CAP_BYTES); these
# are what the service will honour at most, whatever the caller says.
MAX_TIMEOUT_MS = int(os.getenv("SANDBOX_MAX_TIMEOUT_MS", "60000"))
MAX_OUTPUT_CAP_BYTES = int(os.getenv("SANDBOX_MAX_OUTPUT_CAP_BYTES", str(4 * 1024 * 1024)))
MAX_CODE_CHARS = 64_000
MAX_INPUTS_BYTES = 4 * 1024 * 1024
# Per-child address-space ceiling, inside the container's mem_limit.
CHILD_MAX_MEMORY_BYTES = int(os.getenv("SANDBOX_CHILD_MAX_MEMORY_BYTES", str(256 * 1024 * 1024)))
# Scratch for the child. tmpfs in compose; the platform temp dir under pytest.
SCRATCH_DIR = os.getenv("SANDBOX_SCRATCH_DIR") or ("/tmp" if os.path.isdir("/tmp") else tempfile.gettempdir())

# The child's whole environment. Nothing from this process leaks down —
# no token, no service URLs, no locale surprises.
CHILD_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONIOENCODING": "utf-8",
    "LC_ALL": "C.UTF-8",
    "HOME": SCRATCH_DIR,
}


def require_bearer(request: Request) -> None:
    """Reject requests without a matching ``Authorization: Bearer <token>``.

    Fails CLOSED when no token is configured: an unset SANDBOX_SERVICE_TOKEN
    (a failed secret injection at deploy) yields 503 on every non-/health
    route rather than leaving a code-execution service open on the internal
    network. No *_ALLOW_NO_AUTH escape, on purpose.
    """
    if request.url.path in AUTH_EXEMPT_PATHS:
        return
    if not SANDBOX_SERVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="sandbox auth is not configured (SANDBOX_SERVICE_TOKEN unset)",
        )
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), SANDBOX_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


class TransformRequest(BaseModel):
    code: str = Field(min_length=1, max_length=MAX_CODE_CHARS)
    inputs: dict[str, Any] = Field(default_factory=dict)
    timeoutMs: int = Field(default=10_000, ge=100, le=MAX_TIMEOUT_MS)
    outputCapBytes: int = Field(default=256_000, ge=1_024, le=MAX_OUTPUT_CAP_BYTES)


app = FastAPI(
    title="Droplet Sandbox Service",
    version="1.0.0",
    dependencies=[Depends(require_bearer)],
)


@app.get("/health")
async def health():
    return {"status": "ok", "processes": supervisor.SUPERVISION_ENABLED}


def _read_capped(stream, cap: int) -> tuple[bytes, bool]:
    """Read at most ``cap + 1`` bytes so the excess is DETECTED, not buffered."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(min(65_536, cap + 1 - total))
        if not chunk:
            return b"".join(chunks), False
        chunks.append(chunk)
        total += len(chunk)
        if total > cap:
            return b"".join(chunks), True


def run_transform(req: TransformRequest) -> dict[str, Any]:
    """One child process, one deadline, one output cap. Pure function of the
    request so the tests can call it without the HTTP layer."""
    inputs_json = json.dumps(req.inputs)
    if len(inputs_json.encode("utf-8")) > MAX_INPUTS_BYTES:
        return {"error": f"inputs exceed {MAX_INPUTS_BYTES} bytes"}
    payload = json.dumps(
        {"code": req.code, "inputs": req.inputs, "maxMemoryBytes": CHILD_MAX_MEMORY_BYTES},
    ).encode("utf-8")

    deadline = time.monotonic() + req.timeoutMs / 1000
    try:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-S", "-B", str(RUNNER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=SCRATCH_DIR,
            env=CHILD_ENV,
            close_fds=True,
        )
    except OSError as exc:
        return {"error": f"could not start the transform process: {exc}"}

    stdout_data = b""
    exceeded = False
    stderr_data = b""

    def _feed():
        try:
            assert proc.stdin is not None
            proc.stdin.write(payload)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def _drain_stderr():
        nonlocal stderr_data
        assert proc.stderr is not None
        stderr_data, _ = _read_capped(proc.stderr, 16_384)

    feeder = threading.Thread(target=_feed, daemon=True)
    drainer = threading.Thread(target=_drain_stderr, daemon=True)
    feeder.start()
    drainer.start()

    reader_result: dict[str, Any] = {}

    def _read_stdout():
        assert proc.stdout is not None
        data, over = _read_capped(proc.stdout, req.outputCapBytes)
        reader_result["data"] = data
        reader_result["over"] = over

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()
    reader.join(timeout=max(0.0, deadline - time.monotonic()))
    timed_out = reader.is_alive()

    if timed_out or reader_result.get("over"):
        proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    reader.join(timeout=1)
    drainer.join(timeout=1)

    if timed_out:
        return {"error": f"transform exceeded {req.timeoutMs} ms"}
    stdout_data = reader_result.get("data", b"")
    exceeded = bool(reader_result.get("over"))
    if exceeded:
        return {"error": f"output exceeded {req.outputCapBytes} bytes"}

    try:
        result = json.loads(stdout_data.decode("utf-8")) if stdout_data.strip() else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        result = None
    if isinstance(result, dict) and ("output" in result or "error" in result):
        if "error" in result:
            return {"error": str(result["error"])}
        return {"output": result["output"]}

    # The child died without answering — a MemoryError past what runner.py
    # could catch, a kill by the pid ceiling, a segfault. Say what we know.
    tail = stderr_data.decode("utf-8", "replace").strip().splitlines()[-3:]
    detail = " | ".join(tail) if tail else f"exit {proc.returncode}"
    return {"error": f"transform process failed: {detail}"}


@app.post("/transform")
async def transform(req: TransformRequest):
    # Off the event loop: the child is blocking by design.
    import anyio

    return await anyio.to_thread.run_sync(run_transform, req)


# ── Slice H's seam: long-lived, supervised processes ───────────────────────
#
# Not exposed to any tool in this ticket. Gated by SANDBOX_PROCESS_SUPERVISION;
# off, every route here is 404 so nothing on the box can even discover it.


def _processes_enabled() -> None:
    if not supervisor.SUPERVISION_ENABLED:
        raise HTTPException(status_code=404, detail="Not found")


class StartProcessRequest(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,31}$")
    argv: list[str] = Field(min_length=1, max_length=16)
    cwd: str | None = None
    restart: supervisor.RestartPolicy = "on-failure"
    maxRestarts: int = Field(default=3, ge=0, le=20)


@app.post("/processes", dependencies=[Depends(_processes_enabled)])
async def start_process(req: StartProcessRequest):
    try:
        return supervisor.SUPERVISOR.start(
            req.id, req.argv, cwd=req.cwd, restart=req.restart, max_restarts=req.maxRestarts, env=CHILD_ENV,
        )
    except supervisor.SupervisorError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@app.get("/processes/{proc_id}", dependencies=[Depends(_processes_enabled)])
async def process_status(proc_id: str):
    status = supervisor.SUPERVISOR.status(proc_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No such process")
    return status


@app.delete("/processes/{proc_id}", dependencies=[Depends(_processes_enabled)])
async def stop_process(proc_id: str):
    status = supervisor.SUPERVISOR.stop(proc_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No such process")
    return status
