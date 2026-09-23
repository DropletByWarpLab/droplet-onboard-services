"""WARP-2896 (ADR-056 §6.2) — the box's git store: bare repositories on a
named volume, a checkout per workspace, and `git http-backend` over smart
HTTP for the orchestrator to proxy.

A STORE, NOT A FORGE. ADR-010 rejected Gitea/Forgejo for PM; Forgejo is
GPL-3.0-or-later (out under the permissive-only rule) and Gitea duplicates
PM, users and 200 MB of UI. `git` is invoked as an executable (GPLv2), never
linked — the same standing as git on the box today.

Layout (two volumes, see docker-compose.yml):
    REPOS_DIR     /var/lib/workspace-git      <id>.git, templates.git  — backed up
    WORK_DIR      /var/lib/workspace          <id>/ working checkouts  — rebuildable

The bare repo is the truth: every commit a workspace makes is pushed to it
straight away, so the backup set (WARP-2675) always holds the latest state
and a lost checkout is a `git clone` away.

`templates.git` is seeded at service start from the templates baked into the
image (`extensions/templates/` in the repo), only when absent — an operator's
later commits to it are never overwritten. On every later start a template
DIRECTORY the image has and the store does not is added in its own commit
(WARP-2899: an existing box gains `rest-profile`); one the store has is never
touched.

A workspace leaves the box only as a `git bundle` an owner downloads
(WARP-2899), built here from the local bare repo: nothing is dialled.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
from pathlib import Path
from typing import Any

REPOS_DIR = Path(os.getenv("SANDBOX_REPOS_DIR", "/var/lib/workspace-git"))
WORK_DIR = Path(os.getenv("SANDBOX_WORK_DIR", "/var/lib/workspace"))
TEMPLATES_SRC = Path(os.getenv("SANDBOX_TEMPLATES_SRC", "/app/templates"))

WORKSPACE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TEMPLATES_REPO = "templates"
WORK_BRANCH = "work"
GIT_TIMEOUT_S = 60
# The export ceiling — the same 64 MB the /git transport accepts for a push.
MAX_BUNDLE_BYTES = 64 * 1024 * 1024
BUNDLE_TIMEOUT_S = 120
MAX_SHOW_BYTES = 1024 * 1024
# The refs a reader may name: the working branch, or a proposal tag. Closed on
# purpose — the ref is interpolated into a `<ref>:<path>` object name.
REF_RE = re.compile(r"^(work|proposal/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$")

# Nothing from the service's environment reaches git: no token, no HOME
# surprises, no proxy variables. A Windows dev checkout needs its own PATH and
# SYSTEMROOT for git.exe to start at all.
#
# Both config files git would read on its own are closed, not just the system
# one: HOME here is the SAME /tmp a `workspace_run` child gets (workspace.py
# RUN_ENV), so an allow-listed `npm test` could write /tmp/.gitconfig and have
# every later git call here honour it — `uploadpack.packObjectsHook` and
# friends are exactly the keys that turn a fetch into code execution.
# `http.receivepack` was already safe (GIT_CONFIG_* env beats every file);
# GIT_CONFIG_GLOBAL=/dev/null makes the rest safe the same way. Git for
# Windows maps /dev/null to NUL itself.
GIT_ENV: dict[str, str] = {
    "PATH": os.environ.get("PATH", "") if sys.platform == "win32" else "/usr/local/bin:/usr/bin:/bin",
    "HOME": os.environ.get("TEMP", "/tmp") if sys.platform == "win32" else "/tmp",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
    "LC_ALL": "C.UTF-8",
}
if sys.platform == "win32":
    GIT_ENV["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")

SYSTEM_AUTHOR = ("Droplet", "droplet@droplet.local")
Author = tuple[str, str]


class StoreError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def check_id(workspace_id: str) -> str:
    if not WORKSPACE_ID.match(workspace_id or ""):
        raise StoreError(400, "workspace id must match ^[a-z0-9][a-z0-9-]{0,63}$")
    return workspace_id


def bare_path(workspace_id: str) -> Path:
    return REPOS_DIR / f"{check_id(workspace_id)}.git"


def work_path(workspace_id: str) -> Path:
    return WORK_DIR / check_id(workspace_id)


def git(
    args: list[str],
    cwd: Path,
    *,
    author: Author | None = None,
    timeout: int = GIT_TIMEOUT_S,
    binary: bool = False,
) -> subprocess.CompletedProcess:
    env = dict(GIT_ENV)
    if author:
        name, email = author
        env.update(
            GIT_AUTHOR_NAME=name,
            GIT_AUTHOR_EMAIL=email,
            GIT_COMMITTER_NAME=name,
            GIT_COMMITTER_EMAIL=email,
        )
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=not binary,
        encoding=None if binary else "utf-8",
        errors=None if binary else "replace",
        timeout=timeout,
        check=False,
    )


def must(cp: subprocess.CompletedProcess, what: str) -> subprocess.CompletedProcess:
    if cp.returncode != 0:
        err = cp.stderr if isinstance(cp.stderr, str) else (cp.stderr or b"").decode("utf-8", "replace")
        out = cp.stdout if isinstance(cp.stdout, str) else (cp.stdout or b"").decode("utf-8", "replace")
        lines = (err or out).strip().splitlines()
        detail = lines[-1] if lines else f"exit {cp.returncode}"
        raise StoreError(500, f"{what}: {detail[:200]}")
    return cp


def ensure_dirs() -> None:
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)


def _rmtree(path: Path) -> None:
    """rmtree that copes with git's read-only object files (Windows dev checkouts)."""

    def _writable(func, target, _exc):
        # Owner read+write is all an unlink needs; the entry is gone a line later.
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
        func(target)

    shutil.rmtree(path, onexc=_writable)


# ── templates ───────────────────────────────────────────────────────────────


def seed_templates() -> bool:
    """Create `templates.git` from the image's templates if it does not exist.
    Returns True when it seeded, False when the repo was already there or
    the image carries no templates."""
    ensure_dirs()
    bare = REPOS_DIR / f"{TEMPLATES_REPO}.git"
    if bare.exists():
        return False
    if not TEMPLATES_SRC.is_dir():
        return False
    staging = WORK_DIR / ".seed-templates"
    if staging.exists():
        _rmtree(staging)
    shutil.copytree(TEMPLATES_SRC, staging)
    must(git(["init", "--bare", "-q", "-b", "main", str(bare)], REPOS_DIR), "init templates.git")
    try:
        must(git(["init", "-q", "-b", "main"], staging), "init staging")
        must(git(["add", "-A"], staging), "stage templates")
        must(git(["commit", "-q", "-m", "templates: seeded from the image"], staging, author=SYSTEM_AUTHOR), "commit templates")
        must(git(["push", "-q", str(bare), "main:main"], staging), "push templates")
    except StoreError:
        _rmtree(bare)
        raise
    finally:
        _rmtree(staging)
    return True


def sync_templates() -> list[str]:
    """Add every template directory the image carries and `templates.git`
    lacks, one commit each. Never modifies a directory the store already has
    — its operator's commits are theirs. Returns the names added."""
    bare = REPOS_DIR / f"{TEMPLATES_REPO}.git"
    if not bare.exists() or not TEMPLATES_SRC.is_dir():
        return []
    present = set(list_templates())
    missing = sorted(
        p.name for p in TEMPLATES_SRC.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name not in present
    )
    if not missing:
        return []
    staging = WORK_DIR / ".sync-templates"
    # Best-effort by design: a full or failing volume (copytree, rmtree)
    # surfaces as a StoreError the lifespan logs, never as an OSError that
    # would keep the sandbox from starting.
    try:
        ensure_dirs()
        if staging.exists():
            _rmtree(staging)
        try:
            must(git(["clone", "-q", "-b", "main", str(bare), str(staging)], WORK_DIR), "clone templates.git")
            for name in missing:
                shutil.copytree(TEMPLATES_SRC / name, staging / name)
                must(git(["add", "-A", "--", name], staging), "stage template")
                must(
                    git(["commit", "-q", "-m", f"templates: add {name} from the image"], staging, author=SYSTEM_AUTHOR),
                    "commit template",
                )
            must(git(["push", "-q", "origin", "main:main"], staging), "push templates")
        finally:
            if staging.exists():
                _rmtree(staging)
    except (OSError, shutil.Error, subprocess.SubprocessError) as exc:
        raise StoreError(500, f"sync templates: {exc}") from exc
    return missing


def list_templates() -> list[str]:
    bare = REPOS_DIR / f"{TEMPLATES_REPO}.git"
    if not bare.exists():
        return []
    cp = git(["ls-tree", "-d", "--name-only", "main"], bare)
    if cp.returncode != 0:
        return []
    return sorted(line.strip() for line in cp.stdout.splitlines() if line.strip() and not line.startswith("."))


def _extract_template(template: str, into: Path) -> None:
    templates_bare = REPOS_DIR / f"{TEMPLATES_REPO}.git"
    cp = git(["archive", "--format=tar", f"main:{template}"], templates_bare, binary=True)
    if cp.returncode != 0:
        raise StoreError(500, "could not read the template")
    with tarfile.open(fileobj=io.BytesIO(cp.stdout), mode="r:") as tar:
        # Python 3.12's data filter refuses links, devices and paths that
        # escape `into` — the template is our own content, but the store must
        # not depend on that.
        tar.extractall(into, filter="data")


# ── workspaces ──────────────────────────────────────────────────────────────

DEFAULT_IGNORE = "node_modules/\n__pycache__/\n.workspace/\ndist/\n"


def create_workspace(workspace_id: str, template: str | None, author: Author) -> dict[str, Any]:
    """A new bare repo + a checkout on the `work` branch, optionally
    populated from one template directory of templates.git."""
    ensure_dirs()
    bare = bare_path(workspace_id)
    work = work_path(workspace_id)
    if bare.exists() or work.exists():
        raise StoreError(409, f"workspace {workspace_id} already exists")
    if template is not None:
        available = list_templates()
        if template not in available:
            raise StoreError(400, f"unknown template {template!r}; available: {', '.join(available) or 'none'}")
    must(git(["init", "--bare", "-q", "-b", WORK_BRANCH, str(bare)], REPOS_DIR), "init repo")
    try:
        work.mkdir(parents=True)
        must(git(["init", "-q", "-b", WORK_BRANCH], work), "init checkout")
        must(git(["remote", "add", "origin", str(bare)], work), "add origin")
        if template:
            _extract_template(template, work)
        else:
            (work / "README.md").write_text(f"# {workspace_id}\n", encoding="utf-8")
        if not (work / ".gitignore").exists():
            (work / ".gitignore").write_text(DEFAULT_IGNORE, encoding="utf-8")
        must(git(["add", "-A"], work), "stage")
        subject = f"workspace {workspace_id}: created" + (f" from template {template}" if template else "")
        must(git(["commit", "-q", "-m", subject], work, author=author), "initial commit")
        must(git(["push", "-q", "-u", "origin", WORK_BRANCH], work), "push")
    except Exception:
        for p in (bare, work):
            if p.exists():
                _rmtree(p)
        raise
    return status(workspace_id)


def status(workspace_id: str) -> dict[str, Any]:
    work = work_path(workspace_id)
    if not work.exists():
        raise StoreError(404, f"no workspace {workspace_id}")
    head = must(git(["rev-parse", "HEAD"], work), "rev-parse").stdout.strip()
    branch = must(git(["rev-parse", "--abbrev-ref", "HEAD"], work), "branch").stdout.strip()
    dirty = bool(git(["status", "--porcelain"], work).stdout.strip())
    tags = git(["tag", "--list", "--sort=-creatordate"], work).stdout.split()
    return {"id": workspace_id, "branch": branch, "head": head, "dirty": dirty, "tags": tags[:20]}


def _bare_or_404(workspace_id: str) -> Path:
    bare = bare_path(workspace_id)
    if not bare.is_dir():
        raise StoreError(404, f"no workspace {workspace_id}")
    return bare


def _qualified(ref: str) -> str:
    if not REF_RE.match(ref or ""):
        raise StoreError(400, "ref must be work or proposal/<semver>")
    return f"refs/heads/{ref}" if ref == WORK_BRANCH else f"refs/tags/{ref}"


def _git_stdout_capped(args: list[str], cwd: Path, cap: int, timeout: int) -> bytes:
    """git's stdout, read as it streams: the child is killed the moment it
    passes `cap` bytes (413) or `timeout` seconds (504), so an oversized
    export is never held whole in the sandbox's memory."""
    proc = subprocess.Popen(
        ["git", *args], cwd=str(cwd), env=dict(GIT_ENV), stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    stderr: list[bytes] = []
    drain = threading.Thread(target=lambda: stderr.append(proc.stderr.read() if proc.stderr else b""), daemon=True)
    drain.start()
    expired = threading.Event()

    def _expire() -> None:
        expired.set()
        proc.kill()

    timer = threading.Timer(timeout, _expire)
    timer.start()
    chunks: list[bytes] = []
    total = 0
    over = False
    try:
        assert proc.stdout is not None
        while chunk := proc.stdout.read(65_536):
            total += len(chunk)
            if total > cap:
                over = True
                proc.kill()
                break
            chunks.append(chunk)
    finally:
        timer.cancel()
        returncode = proc.wait()
        drain.join(timeout=5)
    if over:
        raise StoreError(413, f"the workspace exceeds the {cap // (1024 * 1024)} MB export ceiling")
    if expired.is_set():
        raise StoreError(504, "the export took too long")
    if returncode != 0:
        lines = b"".join(stderr).decode("utf-8", "replace").strip().splitlines()
        raise StoreError(500, f"bundle: {(lines[-1] if lines else f'exit {returncode}')[:200]}")
    return b"".join(chunks)


def bundle(workspace_id: str) -> tuple[bytes, str]:
    """The workspace as a `git bundle`: the `work` branch, every proposal/*
    tag, and HEAD when it names `work` — nothing else a /git push may have
    left in the bare repo. Built from the local bare repo and returned on
    stdout — no temp file for a run child (same UID, HOME=/tmp) to swap.
    Returns the bytes and the head of `work`."""
    bare = _bare_or_404(workspace_id)
    head = must(git(["rev-parse", f"refs/heads/{WORK_BRANCH}"], bare), "rev-parse").stdout.strip()
    tags = must(git(["for-each-ref", "--format=%(refname)", "refs/tags/proposal/"], bare), "list proposals").stdout.split()
    refs = [f"refs/heads/{WORK_BRANCH}", *tags]
    if git(["symbolic-ref", "-q", "HEAD"], bare).stdout.strip() == f"refs/heads/{WORK_BRANCH}":
        refs.insert(0, "HEAD")
    body = _git_stdout_capped(["bundle", "create", "-", *refs], bare, MAX_BUNDLE_BYTES, BUNDLE_TIMEOUT_S)
    return body, head


def ref_exists(workspace_id: str, ref: str) -> bool:
    bare = _bare_or_404(workspace_id)
    return git(["rev-parse", "-q", "--verify", f"{_qualified(ref)}^{{commit}}"], bare).returncode == 0


def show_at(workspace_id: str, ref: str, path: str) -> str | None:
    """One file of the bare repo at `ref` (work, or a proposal tag), or None
    when the path is not there. 404 for an unknown workspace or ref."""
    bare = _bare_or_404(workspace_id)
    qualified = _qualified(ref)
    if not ref_exists(workspace_id, ref):
        raise StoreError(404, f"no {ref} in workspace {workspace_id}")
    cp = git(["cat-file", "blob", f"{qualified}:{path}"], bare, binary=True)
    if cp.returncode != 0:
        return None
    return cp.stdout[:MAX_SHOW_BYTES].decode("utf-8", "replace")


def delete_workspace(workspace_id: str) -> bool:
    bare = bare_path(workspace_id)
    work = work_path(workspace_id)
    existed = bare.exists() or work.exists()
    for p in (bare, work):
        if p.exists():
            _rmtree(p)
    return existed


# ── smart HTTP ──────────────────────────────────────────────────────────────
#
# `git http-backend` is a CGI program. The orchestrator proxies
# /git/<repo>.git/* here (session-authenticated, actor resolved, push
# permission decided THERE); this end runs the CGI with the environment it
# expects. Whether a push may proceed is an explicit input — git's own
# default ("receive-pack on when REMOTE_USER is set") is never relied on.

_REPO_PATH = re.compile(r"^/[a-z0-9][a-z0-9-]{0,63}\.git(/.*)?$")


def http_backend(
    *,
    method: str,
    path_info: str,
    query: str,
    content_type: str | None,
    content_encoding: str | None,
    body: bytes,
    remote_user: str,
    allow_push: bool,
) -> tuple[int, dict[str, str], bytes]:
    if not _REPO_PATH.match(path_info):
        return 404, {"content-type": "text/plain"}, b"not a repository\n"
    env = dict(GIT_ENV)
    env.update(
        GIT_PROJECT_ROOT=str(REPOS_DIR),
        GIT_HTTP_EXPORT_ALL="1",
        PATH_INFO=path_info,
        REQUEST_METHOD=method,
        QUERY_STRING=query or "",
        REMOTE_USER=remote_user or "",
        REMOTE_ADDR="127.0.0.1",
        SERVER_PROTOCOL="HTTP/1.1",
        GATEWAY_INTERFACE="CGI/1.1",
        CONTENT_LENGTH=str(len(body)),
        # Explicit both ways. http-backend's default would ENABLE push the
        # moment REMOTE_USER is set — which it always is here.
        GIT_CONFIG_COUNT="1",
        GIT_CONFIG_KEY_0="http.receivepack",
        GIT_CONFIG_VALUE_0="true" if allow_push else "false",
    )
    if content_type:
        env["CONTENT_TYPE"] = content_type
    if content_encoding:
        env["HTTP_CONTENT_ENCODING"] = content_encoding
    cp = subprocess.run(
        ["git", "http-backend"],
        input=body,
        env=env,
        capture_output=True,
        timeout=120,
        check=False,
    )
    raw = cp.stdout
    head, sep, payload = raw.partition(b"\r\n\r\n")
    if not sep:
        head, sep, payload = raw.partition(b"\n\n")
    headers: dict[str, str] = {}
    status_code = 200
    for line in head.decode("latin-1").splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip().lower(), v.strip()
        if k == "status":
            try:
                status_code = int(v.split()[0])
            except (ValueError, IndexError):
                status_code = 500
        else:
            headers[k] = v
    return status_code, headers, payload
