"""WARP-2896 (ADR-056 §6.2) — the operations a workshop run performs on its
workspace: read, search, diff, log, write, commit, run, propose.

Each is a plain function over one checkout under gitstore.WORK_DIR. The
orchestrator route (apps/orchestrator/src/routes/workspace.ts) is where the
ACTOR is resolved and "this run owns this workspace" is enforced; by the time
a request reaches here it is a trusted internal call. What this module still
enforces on its own, because a defence that lives in one place is one bug
from gone:

  * every path stays inside the checkout (realpath, not string prefix);
  * `.git/` is never read or written through the file operations;
  * `run` executes ONLY an allow-listed argv (npm test, npm run build,
    pytest, ruff, tsc) — the orchestrator refuses anything else before the
    request is made, and this end refuses it again;
  * output is capped and the cap is REPORTED, never silently sliced.

`write` is idempotent (same bytes twice is one state). `commit` and `run`
are not — the orchestrator's replay guard keeps a resumed run from
re-dispatching them silently.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import gitstore
from gitstore import Author, StoreError, git, must

MAX_READ_BYTES = 256 * 1024
MAX_WRITE_BYTES = 1024 * 1024
MAX_SEARCH_HITS = 200
MAX_LOG_ENTRIES = 100
MAX_DIFF_BYTES = 256 * 1024
RUN_DEFAULT_TIMEOUT_MS = 120_000
RUN_MAX_TIMEOUT_MS = 600_000
RUN_OUTPUT_CAP_BYTES = 256 * 1024
# What a run's stdout/stderr is kept as, per workspace, for the dashboard's
# /output view. Ignored by git (DEFAULT_IGNORE covers .workspace/).
LAST_RUN_FILE = Path(".workspace") / "last-run.json"
MANIFEST_FILE = "extension-manifest.json"

_REL_PATH = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_./ -]{0,255}$")
_ARG = re.compile(r"^[A-Za-z0-9_./=:@,+-]{1,128}$")
_SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")

# The run allow-list. argv must START with one of these prefixes, verbatim;
# whatever follows is checked against _ARG. The values are what actually
# executes — bare names are never resolved through the caller's PATH.
RUN_COMMANDS: dict[tuple[str, ...], list[str]] = {
    ("npm", "test"): ["/usr/local/bin/npm", "test"],
    ("npm", "run", "build"): ["/usr/local/bin/npm", "run", "build"],
    ("pytest",): [sys.executable, "-m", "pytest"],
    ("ruff",): [sys.executable, "-m", "ruff"],
    ("tsc",): ["/usr/local/bin/tsc"],
}

RUN_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",
    "LC_ALL": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONIOENCODING": "utf-8",
    "NO_COLOR": "1",
    "CI": "1",
    "npm_config_update_notifier": "false",
    "npm_config_fund": "false",
    "npm_config_audit": "false",
}


def _checkout(workspace_id: str) -> Path:
    work = gitstore.work_path(workspace_id)
    if not work.is_dir():
        raise StoreError(404, f"no workspace {workspace_id}")
    _follow_repository(work)
    return work


def _follow_repository(work: Path) -> None:
    """The bare repository is the truth and the checkout follows it.

    An owner may push to `<id>.git` from outside over /git/ (the ticket's AC)
    while nothing here is watching; without this, the checkout would keep
    working from the commit it last saw and the run's next `commit` would be
    refused at push time as a non-fast-forward — after the run had already
    written on top of stale files. So every operation first fast-forwards the
    checkout onto `origin/work`. Fast-forward ONLY: a checkout that has moved
    ahead, or has uncommitted work, while the repository also moved is a
    divergence the run must hear about as a 409, never a merge nobody asked
    for. The fetch is local (origin is a path on the same volume).
    """
    must(git(["fetch", "-q", "origin", gitstore.WORK_BRANCH], work), "fetch")
    head = must(git(["rev-parse", "HEAD"], work), "rev-parse").stdout.strip()
    remote = must(git(["rev-parse", f"origin/{gitstore.WORK_BRANCH}"], work), "rev-parse").stdout.strip()
    if head == remote:
        return
    # The checkout is ahead (a commit whose push failed earlier): nothing to
    # follow; the next commit pushes again.
    if git(["merge-base", "--is-ancestor", remote, head], work).returncode == 0:
        return
    behind = git(["merge-base", "--is-ancestor", head, remote], work).returncode == 0
    dirty = bool(git(["status", "--porcelain"], work).stdout.strip())
    if not behind or dirty:
        raise StoreError(
            409,
            "the repository moved under this workspace (a push over /git/ while work was in progress); "
            "the checkout is not fast-forwarded over uncommitted or diverged work — start a new run",
        )
    must(git(["merge", "-q", "--ff-only", f"origin/{gitstore.WORK_BRANCH}"], work), "fast-forward")


def _inside(work: Path, rel: str) -> Path:
    """Resolve `rel` under the checkout; refuse escapes and the .git dir."""
    if not _REL_PATH.match(rel or "") or rel.startswith("/") or "\\" in rel:
        raise StoreError(400, "path must be a relative path inside the workspace")
    parts = Path(rel).parts
    if ".." in parts or ".git" in parts:
        raise StoreError(400, "path must be a relative path inside the workspace")
    root = work.resolve()
    target = (work / rel).resolve()
    try:
        inner = target.relative_to(root)
    except ValueError as exc:
        raise StoreError(400, "path must be a relative path inside the workspace") from exc
    if ".git" in inner.parts:
        raise StoreError(400, "path must be a relative path inside the workspace")
    return target


# ── reads ───────────────────────────────────────────────────────────────────


def read(workspace_id: str, path: str) -> dict[str, Any]:
    work = _checkout(workspace_id)
    target = _inside(work, path)
    if target.is_dir():
        entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir() if p.name != ".git")
        return {"path": path, "kind": "directory", "entries": entries[:500], "truncated": len(entries) > 500}
    if not target.is_file():
        raise StoreError(404, f"no such file: {path}")
    data = target.read_bytes()
    truncated = len(data) > MAX_READ_BYTES
    text = data[:MAX_READ_BYTES].decode("utf-8", "replace")
    return {"path": path, "kind": "file", "content": text, "bytes": len(data), "truncated": truncated}


def search(workspace_id: str, pattern: str, glob: str | None = None) -> dict[str, Any]:
    work = _checkout(workspace_id)
    if not pattern or len(pattern) > 256:
        raise StoreError(400, "pattern must be 1–256 characters")
    if glob is not None and not _REL_PATH.match(glob.replace("*", "x")):
        raise StoreError(400, "glob must be a relative path pattern")
    args = ["grep", "-n", "-I", "--no-color", "-e", pattern, "--", *([glob] if glob else [])]
    cp = git(args, work)
    if cp.returncode not in (0, 1):
        raise StoreError(400, f"search failed: {cp.stderr.strip()[:200]}")
    hits = []
    for line in cp.stdout.splitlines():
        file, _, rest = line.partition(":")
        lineno, _, text = rest.partition(":")
        try:
            hits.append({"path": file, "line": int(lineno), "text": text[:400]})
        except ValueError:
            continue
    return {"pattern": pattern, "hits": hits[:MAX_SEARCH_HITS], "truncated": len(hits) > MAX_SEARCH_HITS}


def diff(workspace_id: str, base: str | None = None) -> dict[str, Any]:
    """Uncommitted changes against HEAD, or `base..HEAD` when a base ref is given."""
    work = _checkout(workspace_id)
    if base is not None and not re.match(r"^[A-Za-z0-9_./-]{1,64}$", base):
        raise StoreError(400, "base must be a ref name or commit")
    if base:
        cp = git(["diff", "--no-color", "--stat=120", "-p", f"{base}..HEAD", "--"], work)
    else:
        must(git(["add", "-A", "-N", "--", "."], work), "intent-to-add")
        cp = git(["diff", "--no-color", "--stat=120", "-p", "HEAD", "--"], work)
    if cp.returncode != 0:
        raise StoreError(400, f"diff failed: {cp.stderr.strip()[:200]}")
    text = cp.stdout
    truncated = len(text.encode("utf-8")) > MAX_DIFF_BYTES
    if truncated:
        text = text.encode("utf-8")[:MAX_DIFF_BYTES].decode("utf-8", "ignore")
    return {"base": base or "HEAD", "diff": text, "truncated": truncated}


def log(workspace_id: str, limit: int = 20) -> dict[str, Any]:
    work = _checkout(workspace_id)
    limit = max(1, min(int(limit), MAX_LOG_ENTRIES))
    cp = must(git(["log", f"--max-count={limit}", "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%D"], work), "log")
    entries = []
    for line in cp.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) < 4:
            continue
        commit, author, date, subject = parts[:4]
        refs = [r.strip() for r in (parts[4] if len(parts) > 4 else "").split(",") if r.strip()]
        entries.append({"commit": commit, "author": author, "date": date, "subject": subject, "refs": refs})
    return {"entries": entries}


# ── writes ──────────────────────────────────────────────────────────────────


def write(workspace_id: str, path: str, content: str) -> dict[str, Any]:
    """Idempotent: writing the same bytes reports changed=False."""
    work = _checkout(workspace_id)
    target = _inside(work, path)
    data = content.encode("utf-8")
    if len(data) > MAX_WRITE_BYTES:
        raise StoreError(413, f"content exceeds {MAX_WRITE_BYTES} bytes")
    if target.is_dir():
        raise StoreError(400, f"{path} is a directory")
    before = target.read_bytes() if target.is_file() else None
    if before == data:
        return {"path": path, "bytes": len(data), "changed": False}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"path": path, "bytes": len(data), "changed": True}


def commit(workspace_id: str, message: str, author: Author) -> dict[str, Any]:
    """Stage everything, commit, push to the bare repo. Nothing to commit is
    not an error: the answer carries changed=False and the current HEAD."""
    work = _checkout(workspace_id)
    message = (message or "").strip()
    if not message or len(message) > 2000:
        raise StoreError(400, "message must be 1–2000 characters")
    must(git(["add", "-A"], work), "stage")
    if not git(["status", "--porcelain"], work).stdout.strip():
        head = must(git(["rev-parse", "HEAD"], work), "rev-parse").stdout.strip()
        return {"commit": head, "changed": False}
    must(git(["commit", "-q", "-m", message], work, author=author), "commit")
    head = must(git(["rev-parse", "HEAD"], work), "rev-parse").stdout.strip()
    must(git(["push", "-q", "origin", gitstore.WORK_BRANCH], work), "push")
    return {"commit": head, "changed": True}


# ── run ─────────────────────────────────────────────────────────────────────


def resolve_run_argv(argv: list[str]) -> list[str]:
    """The allow-list. Returns the executable argv or raises StoreError(400)."""
    if not argv or len(argv) > 16:
        raise StoreError(400, "argv must have 1–16 entries")
    for prefix, exe in RUN_COMMANDS.items():
        if tuple(argv[: len(prefix)]) == prefix:
            rest = argv[len(prefix) :]
            for a in rest:
                if not _ARG.match(a) or a.startswith("/") or ".." in a:
                    raise StoreError(400, f"argument not allowed: {a[:40]!r}")
            return [*exe, *rest]
    allowed = ", ".join(" ".join(p) for p in RUN_COMMANDS)
    raise StoreError(400, f"command not allowed; the workspace can run: {allowed}")


# The child's resource ceilings, set by a wrapper that then exec()s the real
# command — not a `preexec_fn`, which forks a threaded server (this process
# serves requests from a thread pool) and is unsafe for exactly that reason.
# The wrapper is stdlib-only, isolated (-I -S), and replaces itself with the
# command so the pid the server holds IS the command's pid.
#
# No RLIMIT_AS on purpose: V8 reserves gigabytes of virtual address space it
# never touches (the pointer-compression cage), so an address-space cap that
# would mean anything to a Python test kills `tsc` and `npm test` at start.
# Memory is the container's `mem_limit`; this caps process fan-out and file
# size below what the container does (`pids_limit`, 128 by default).
#
# RLIMIT_NPROC is a per-UID ceiling, not a per-tree one: the kernel refuses a
# fork when the UID's TOTAL task count (this service's own threads, its git
# children, and the run's tree) is at the limit — but only for processes that
# carry the limit, so it is the run's fan-out that fails, never the service.
# 64 leaves a `npm test` at cpus=1 (node + one vitest worker + esbuild) tens
# of tasks of headroom below the container's 128; a run that hits it sees
# `EAGAIN` / "Resource temporarily unavailable" in its own output.
_LIMIT_WRAPPER = """
import os, resource, sys
for r, v in ((resource.RLIMIT_NPROC, 64), (resource.RLIMIT_FSIZE, 64 * 1024 * 1024)):
    try:
        resource.setrlimit(r, (v, v))
    except (ValueError, OSError):
        pass
os.execv(sys.argv[1], sys.argv[1:])
"""


def _with_limits(exe: list[str]) -> list[str]:
    if os.name != "posix":  # a Windows dev checkout: no rlimits, run it plainly
        return exe
    return [sys.executable, "-I", "-S", "-c", _LIMIT_WRAPPER, *exe]


def run(workspace_id: str, argv: list[str], timeout_ms: int | None = None) -> dict[str, Any]:
    work = _checkout(workspace_id)
    exe = resolve_run_argv(argv)
    timeout_ms = max(1000, min(int(timeout_ms or RUN_DEFAULT_TIMEOUT_MS), RUN_MAX_TIMEOUT_MS))
    env = dict(RUN_ENV)
    if sys.platform == "win32":  # dev checkout only; the image is Linux
        env["PATH"] = os.environ.get("PATH", "")
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
        env["HOME"] = os.environ.get("TEMP", "")
    started = time.monotonic()
    timed_out = False
    try:
        proc = subprocess.Popen(
            _with_limits(exe),
            cwd=str(work),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
    except OSError as exc:
        raise StoreError(500, f"could not start {argv[0]}: {exc}") from exc
    try:
        out, err = proc.communicate(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        timed_out = True
    duration_ms = int((time.monotonic() - started) * 1000)

    def cap(b: bytes) -> tuple[str, bool]:
        return b[:RUN_OUTPUT_CAP_BYTES].decode("utf-8", "replace"), len(b) > RUN_OUTPUT_CAP_BYTES

    stdout, out_trunc = cap(out or b"")
    stderr, err_trunc = cap(err or b"")
    result = {
        "argv": argv,
        # What actually ran — the allow-list's hardcoded executable, so a
        # reader of the record (and the live proof) sees the path, not a name
        # that PATH might have resolved elsewhere.
        "executable": exe[0],
        "exitCode": None if timed_out else proc.returncode,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "stdout": stdout,
        "stderr": stderr,
        "truncated": out_trunc or err_trunc,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    record = work / LAST_RUN_FILE
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def last_run(workspace_id: str) -> dict[str, Any] | None:
    work = _checkout(workspace_id)
    record = work / LAST_RUN_FILE
    if not record.is_file():
        return None
    try:
        return json.loads(record.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


# ── propose ─────────────────────────────────────────────────────────────────


# The manifest schema (WARP-2900 H1): apps/orchestrator/src/services/
# extension-manifest.ts and docs/schemas/extension-manifest.schema.json.
# Propose writes that shape; the orchestrator's strict parser is the judge at
# promote, so a manifest a run left wrong is refused THERE with its reason,
# not silently repaired here. What propose does force: the identity fields,
# `kind` and `egress` — a run cannot propose anything but an extension that
# reaches nothing outside the box.
DEFAULT_MEMORY_MB = 256
# The #2247-era shape (`provides.routines`, `footprint`) — still what an
# existing box's templates.git holds, because templates are never re-seeded
# over an operator's commits.
_LEGACY_KEYS = ("footprint",)


def infer_runtime(work: Path) -> tuple[str, str] | None:
    """(runtime, entrypoint) from what the checkout holds, for a manifest
    that names neither. None when nothing says which."""
    if (work / "package.json").is_file() or (work / "tsconfig.json").is_file():
        return "node20", "dist/index.js"
    if (work / "tool.py").is_file():
        return "python312", "tool.py"
    return None


def manifest_defaults(
    workspace_id: str,
    name: str,
    version: str,
    runtime: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """The extension-manifest.json a proposal leaves behind when the checkout
    has none. `egress` is the literal none and `kind` the literal extension —
    the verifier refuses anything else."""
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "id": workspace_id,
        "name": name,
        "version": version,
        "kind": "extension",
        "provides": {"tools": [], "routineDrafts": [], "proposedGrants": []},
        "resources": {"memoryMb": DEFAULT_MEMORY_MB, "processes": 1},
        "egress": "none",
    }
    if runtime is not None:
        manifest["runtime"], manifest["entrypoint"] = runtime
    return manifest


def normalize_manifest(existing: dict[str, Any], defaults: dict[str, Any]) -> dict[str, Any]:
    """Carry a checkout's manifest into the current shape. Unknown keys are
    KEPT (the orchestrator refuses them at promote, legibly); the legacy
    `footprint` / empty `provides.routines` are migrated; the identity fields
    are forced from `defaults`. `kind` and `egress` are forced by propose()."""
    manifest = {k: v for k, v in existing.items() if k not in _LEGACY_KEYS}
    footprint = existing.get("footprint")
    provides = existing.get("provides")
    provides = dict(provides) if isinstance(provides, dict) else {}
    if provides.get("routines") == []:
        del provides["routines"]
    for key in ("tools", "routineDrafts", "proposedGrants"):
        if not isinstance(provides.get(key), list):
            provides[key] = []
    manifest["provides"] = provides
    resources = manifest.get("resources")
    resources = dict(resources) if isinstance(resources, dict) else {}
    if "memoryMb" not in resources:
        legacy_mb = footprint.get("memoryMb") if isinstance(footprint, dict) else None
        resources["memoryMb"] = legacy_mb if isinstance(legacy_mb, int) else DEFAULT_MEMORY_MB
    resources["processes"] = 1
    manifest["resources"] = resources
    for key in ("runtime", "entrypoint"):
        if key not in manifest and key in defaults:
            manifest[key] = defaults[key]
    for key in ("schemaVersion", "id", "name", "version"):
        manifest[key] = defaults[key]
    return manifest


def propose(workspace_id: str, name: str, version: str, summary: str, author: Author) -> dict[str, Any]:
    """Write/refresh the manifest, commit, tag `proposal/<version>`, push
    both. The tag is what the review surface (slice I) picks up; a second
    proposal of the same version is refused, not overwritten."""
    work = _checkout(workspace_id)
    name = (name or "").strip()
    if not name or len(name) > 80:
        raise StoreError(400, "name must be 1–80 characters")
    if not _SEMVER.match(version or ""):
        raise StoreError(400, "version must be semver (e.g. 0.1.0)")
    summary = (summary or "").strip()
    if not summary or len(summary) > 2000:
        raise StoreError(400, "summary must be 1–2000 characters")
    tag = f"proposal/{version}"
    if git(["rev-parse", "-q", "--verify", f"refs/tags/{tag}"], work).returncode == 0:
        raise StoreError(409, f"{tag} already exists; bump the version")

    manifest_path = work / MANIFEST_FILE
    defaults = manifest_defaults(workspace_id, name, version, infer_runtime(work))
    manifest = defaults
    if manifest_path.is_file():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                manifest = normalize_manifest(existing, defaults)
        except (json.JSONDecodeError, OSError):
            pass
    manifest["kind"] = "extension"
    manifest["egress"] = "none"
    manifest["summary"] = summary
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    must(git(["add", "-A"], work), "stage")
    if git(["status", "--porcelain"], work).stdout.strip():
        must(git(["commit", "-q", "-m", f"propose {name} {version}\n\n{summary}"], work, author=author), "commit")
    head = must(git(["rev-parse", "HEAD"], work), "rev-parse").stdout.strip()
    must(git(["tag", "-a", tag, "-m", summary, head], work, author=author), "tag")
    must(git(["push", "-q", "origin", gitstore.WORK_BRANCH, f"refs/tags/{tag}"], work), "push")
    # `kind` says what was proposed. Only "extension" exists today; a
    # connector draft (WARP-2899) answers with its own kind and no manifest,
    # and the orchestrator lists that as not promotable.
    return {"kind": "extension", "commit": head, "tag": tag, "manifest": manifest}
