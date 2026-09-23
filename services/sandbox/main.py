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
    GET  /workspaces/{id}/proposals/{version}/manifest
                                       WARP-2900 H2, gated like /processes:
    GET  /extensions                   extensions.py (list, install, relay,
    GET  /extensions/budget            stop, uninstall) and the proposal a
    GET  /extensions/{slug}            promote reads from the bare repository
    POST /extensions/{slug}/install
    POST /extensions/{slug}/rpc
    DELETE /extensions/{slug}/process
    DELETE /extensions/{slug}
    POST /workspaces                   slice G (WARP-2896): the git store, see
    GET  /workspaces/templates         gitstore.py + workspace.py
    GET|DELETE /workspaces/{id}
    POST /workspaces/{id}/{read,search,diff,log,write,commit,run,propose}
    GET  /workspaces/{id}/output
    ANY  /git/{repo}.git/...           `git http-backend`, proxied by the orchestrator

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

import base64
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

import extensions
import gitstore
import supervisor
import workspace

SANDBOX_SERVICE_TOKEN = os.getenv("SANDBOX_SERVICE_TOKEN", "").strip()

# prctl(2) option: PR_SET_DUMPABLE.
PR_SET_DUMPABLE = 4


def _make_undumpable(libc: Any = None) -> bool:
    """Mark this server process non-dumpable (WARP-2900).

    Installed extensions and workspace runs execute as this process's uid. A
    dumpable server lets any of them read SANDBOX_SERVICE_TOKEN from
    /proc/<pid>/environ (or /proc/<pid>/mem) and drive the whole sandbox API.
    Non-dumpable, those entries are root-owned and ptrace-protected for the
    same uid. Children are unaffected: execve resets the flag, so this does
    not stop one extension reading another's environment (see
    docs/security/extension-trust.md).
    """
    if libc is None:
        if not sys.platform.startswith("linux"):
            return False
        import ctypes

        try:
            libc = ctypes.CDLL(None, use_errno=True)
        except OSError:
            return False
    try:
        rc = libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except (AttributeError, OSError):
        rc = -1
    if rc != 0:
        print("[sandbox] WARNING: could not mark the server non-dumpable; a same-uid child can read its bearer", flush=True)
        return False
    return True


SERVER_UNDUMPABLE = _make_undumpable()

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


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # The git store's one boot-time job: templates.git exists after the
    # first start, and is never re-seeded over an operator's commits.
    try:
        seeded = gitstore.seed_templates()
        print(f"[sandbox] git store at {gitstore.REPOS_DIR} (templates {'seeded' if seeded else 'present'})", flush=True)
    except gitstore.StoreError as exc:
        print(f"[sandbox] git store: templates not seeded: {exc}", flush=True)
    yield


app = FastAPI(
    title="Droplet Sandbox Service",
    version="1.1.0",
    dependencies=[Depends(require_bearer)],
    lifespan=_lifespan,
)


@app.get("/health")
async def health():
    return {"status": "ok", "processes": supervisor.SUPERVISION_ENABLED, "workspaces": gitstore.REPOS_DIR.is_dir()}


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


# ── Slice H2 (WARP-2900): extensions ───────────────────────────────────────
#
# Gated exactly like /processes: off, every route here is 404. The
# orchestrator is the only caller; it has verified the signed statement and
# resolved the owner before it asks for an install. Nothing here takes an
# argv or an environment from the request: the argv is the runtime's host
# shim, and the environment is CHILD_ENV plus keys extensions.py sets.


class InstallExtensionRequest(BaseModel):
    # Any other key is refused (422): the request cannot smuggle an env var,
    # an argv or a path in under a name this model does not know.
    model_config = ConfigDict(extra="forbid")

    workspaceId: str = Field(pattern=gitstore.WORKSPACE_ID.pattern)
    version: str = Field(pattern=extensions.SEMVER.pattern, max_length=64)
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    tree: str = Field(pattern=r"^[0-9a-f]{40}$")
    runtime: str = Field(pattern=r"^(node20|python312)$")
    entrypoint: str = Field(min_length=1, max_length=256)
    memoryMb: int = Field(ge=extensions.MEMORY_MB_MIN, le=extensions.MEMORY_MB_MAX)
    token: str = Field(pattern=extensions.EXT_TOKEN.pattern)
    orchestratorUrl: str | None = Field(default=None, pattern=r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$", max_length=256)


def _ext(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except gitstore.StoreError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except supervisor.SupervisorError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git timed out") from exc


async def _ext_thread(fn, *args, **kwargs):
    import functools

    import anyio

    return await anyio.to_thread.run_sync(functools.partial(_ext, fn, *args, **kwargs))


@app.get("/workspaces/{workspace_id}/proposals/{version}/manifest", dependencies=[Depends(_processes_enabled)])
async def proposal_manifest(workspace_id: str, version: str):
    if not extensions.SEMVER.match(version):
        raise HTTPException(status_code=400, detail="version must be semver")
    tag = f"proposal/{version}"
    found = await _ext_thread(gitstore.read_at_tag, workspace_id, tag)
    manifest = found["manifest"]
    return {
        "workspaceId": workspace_id,
        "tag": tag,
        "commit": found["commit"],
        "tree": found["tree"],
        # Base64 of the exact committed bytes: what is digested and signed.
        "manifest": base64.b64encode(manifest).decode("ascii") if manifest is not None else None,
    }


@app.get("/extensions", dependencies=[Depends(_processes_enabled)])
async def extensions_listing():
    # The reconciler's other direction (review #2323): what this sandbox
    # holds and whether each process runs, so the orchestrator can stop one
    # whose row says it must not run.
    return {"extensions": extensions.listing()}


@app.get("/extensions/budget", dependencies=[Depends(_processes_enabled)])
async def extensions_budget():
    return extensions.budget()


@app.get("/extensions/{slug}", dependencies=[Depends(_processes_enabled)])
async def extension_status(slug: str):
    return await _ext_thread(extensions.status, slug)


@app.post("/extensions/{slug}/install", dependencies=[Depends(_processes_enabled)])
async def install_extension(slug: str, req: InstallExtensionRequest):
    return await _ext_thread(
        extensions.install,
        slug,
        workspace_id=req.workspaceId,
        version=req.version,
        commit=req.commit,
        tree=req.tree,
        runtime=req.runtime,
        entrypoint=req.entrypoint,
        memory_mb=req.memoryMb,
        token=req.token,
        base_env=CHILD_ENV,
        orchestrator_url=req.orchestratorUrl,
    )


MAX_RELAY_BODY_BYTES = 1024 * 1024


@app.post("/extensions/{slug}/rpc", dependencies=[Depends(_processes_enabled)])
async def relay_extension(slug: str, request: Request, timeoutMs: int | None = None):
    body = await request.body()
    if not body or len(body) > MAX_RELAY_BODY_BYTES:
        raise HTTPException(status_code=413 if body else 400, detail="a JSON-RPC body of 1 byte to 1 MiB")
    status_code, payload = await _ext_thread(extensions.relay, slug, body, timeoutMs)
    return Response(
        content=payload,
        status_code=status_code,
        media_type="application/json" if payload else None,
    )


@app.delete("/extensions/{slug}/process", dependencies=[Depends(_processes_enabled)])
async def stop_extension(slug: str):
    snap = await _ext_thread(extensions.stop, slug)
    if snap is None:
        raise HTTPException(status_code=404, detail=f"extension {slug} has no process")
    return snap


@app.delete("/extensions/{slug}", dependencies=[Depends(_processes_enabled)])
async def uninstall_extension(slug: str):
    return await _ext_thread(extensions.uninstall, slug)


# ── Slice G (WARP-2896): workspaces + the git store ────────────────────────
#
# Every route here is an internal call from the orchestrator, which has
# already resolved the human, checked the run owns the workspace and refused
# any argv outside the allow-list. This end validates shape, confines paths
# and refuses the allow-list a second time (workspace.py).


class WorkspaceAuthor(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)

    def pair(self) -> gitstore.Author:
        return (self.name, self.email)


class CreateWorkspaceRequest(BaseModel):
    id: str = Field(pattern=gitstore.WORKSPACE_ID.pattern)
    template: str | None = Field(default=None, max_length=64)
    author: WorkspaceAuthor


class ReadRequest(BaseModel):
    path: str = Field(min_length=1, max_length=256)


class SearchRequest(BaseModel):
    pattern: str = Field(min_length=1, max_length=256)
    glob: str | None = Field(default=None, max_length=256)


class DiffRequest(BaseModel):
    base: str | None = Field(default=None, max_length=64)


class LogRequest(BaseModel):
    limit: int = Field(default=20, ge=1, le=workspace.MAX_LOG_ENTRIES)


class WriteRequest(BaseModel):
    path: str = Field(min_length=1, max_length=256)
    content: str = Field(max_length=workspace.MAX_WRITE_BYTES)


class CommitRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    author: WorkspaceAuthor


class RunRequest(BaseModel):
    argv: list[str] = Field(min_length=1, max_length=16)
    timeoutMs: int = Field(default=workspace.RUN_DEFAULT_TIMEOUT_MS, ge=1000, le=workspace.RUN_MAX_TIMEOUT_MS)


class ProposeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    version: str = Field(min_length=5, max_length=64)
    summary: str = Field(min_length=1, max_length=2000)
    author: WorkspaceAuthor


def _store(fn, *args):
    try:
        return fn(*args)
    except gitstore.StoreError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git timed out") from exc


async def _in_thread(fn, *args):
    import anyio

    return await anyio.to_thread.run_sync(_store, fn, *args)


@app.get("/workspaces/templates")
async def list_templates():
    return {"templates": await _in_thread(gitstore.list_templates)}


@app.post("/workspaces")
async def create_workspace(req: CreateWorkspaceRequest):
    return await _in_thread(gitstore.create_workspace, req.id, req.template, req.author.pair())


@app.get("/workspaces/{workspace_id}")
async def workspace_status(workspace_id: str):
    return await _in_thread(gitstore.status, workspace_id)


@app.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str):
    existed = await _in_thread(gitstore.delete_workspace, workspace_id)
    if not existed:
        raise HTTPException(status_code=404, detail=f"no workspace {workspace_id}")
    return {"id": workspace_id, "deleted": True}


@app.post("/workspaces/{workspace_id}/read")
async def workspace_read(workspace_id: str, req: ReadRequest):
    return await _in_thread(workspace.read, workspace_id, req.path)


@app.post("/workspaces/{workspace_id}/search")
async def workspace_search(workspace_id: str, req: SearchRequest):
    return await _in_thread(workspace.search, workspace_id, req.pattern, req.glob)


@app.post("/workspaces/{workspace_id}/diff")
async def workspace_diff(workspace_id: str, req: DiffRequest):
    return await _in_thread(workspace.diff, workspace_id, req.base)


@app.post("/workspaces/{workspace_id}/log")
async def workspace_log(workspace_id: str, req: LogRequest):
    return await _in_thread(workspace.log, workspace_id, req.limit)


@app.post("/workspaces/{workspace_id}/write")
async def workspace_write(workspace_id: str, req: WriteRequest):
    return await _in_thread(workspace.write, workspace_id, req.path, req.content)


@app.post("/workspaces/{workspace_id}/commit")
async def workspace_commit(workspace_id: str, req: CommitRequest):
    return await _in_thread(workspace.commit, workspace_id, req.message, req.author.pair())


@app.post("/workspaces/{workspace_id}/run")
async def workspace_run(workspace_id: str, req: RunRequest):
    return await _in_thread(workspace.run, workspace_id, req.argv, req.timeoutMs)


@app.get("/workspaces/{workspace_id}/output")
async def workspace_output(workspace_id: str):
    return {"lastRun": await _in_thread(workspace.last_run, workspace_id)}


@app.post("/workspaces/{workspace_id}/propose")
async def workspace_propose(workspace_id: str, req: ProposeRequest):
    return await _in_thread(workspace.propose, workspace_id, req.name, req.version, req.summary, req.author.pair())


# The smart-HTTP transport. The orchestrator forwards /git/<repo>.git/* here
# with two headers it alone sets: X-Droplet-Git-User (the resolved actor) and
# X-Droplet-Git-Push (1 when that actor may push). Nothing else on the box
# can reach this route (compose network), so the headers are the contract.

MAX_GIT_BODY_BYTES = 64 * 1024 * 1024


@app.api_route("/git/{path:path}", methods=["GET", "POST"])
async def git_http(path: str, request: Request):
    body = await request.body()
    if len(body) > MAX_GIT_BODY_BYTES:
        raise HTTPException(status_code=413, detail="push too large")
    remote_user = request.headers.get("x-droplet-git-user", "").strip()
    allow_push = request.headers.get("x-droplet-git-push", "").strip() == "1"
    if not remote_user:
        raise HTTPException(status_code=401, detail="no actor")

    def _cgi():
        return gitstore.http_backend(
            method=request.method,
            path_info="/" + path,
            query=request.url.query,
            content_type=request.headers.get("content-type"),
            content_encoding=request.headers.get("content-encoding"),
            body=body,
            remote_user=remote_user,
            allow_push=allow_push,
        )

    import anyio

    try:
        status_code, headers, payload = await anyio.to_thread.run_sync(_cgi)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git http-backend timed out") from exc
    return Response(content=payload, status_code=status_code, headers=headers)
