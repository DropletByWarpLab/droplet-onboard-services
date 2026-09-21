"""The git store and the workspace operations (WARP-2896, ADR-056 slice G).

Real git, real checkouts, real child processes — the store is a thin layer
over the git executable and the tests exercise exactly that layer. The two
security properties this file pins:

  * every file operation stays inside the checkout (and out of .git/);
  * `run` executes nothing but the allow-list, and the smart-HTTP backend
    refuses a push unless the orchestrator said the actor may push — git's
    own default would ENABLE push the moment REMOTE_USER is set.
"""

from __future__ import annotations

import json
import sys

import pytest

import workspace
from gitstore import StoreError

ALICE = ("Alice", "alice@example.test")
AUTHOR = {"name": ALICE[0], "email": ALICE[1]}


# ── the store ───────────────────────────────────────────────────────────────


def test_templates_seed_once_and_never_overwrite(store):
    # The fixture seeded. A second start finds the repo and leaves it alone.
    assert store.seed_templates() is False
    assert store.list_templates() == ["python-tool", "typescript-tool"]


def test_git_reads_no_config_file_a_run_child_could_have_planted(store, tmp_path, monkeypatch):
    # HOME for the store's git is the same /tmp a `workspace_run` child gets, so
    # a planted $HOME/.gitconfig would otherwise steer every later git call —
    # `uploadpack.packObjectsHook` turns a fetch into code execution. Both
    # file layers are closed: GIT_CONFIG_NOSYSTEM for /etc, GIT_CONFIG_GLOBAL
    # for ~/.gitconfig. Mutation: drop GIT_CONFIG_GLOBAL from GIT_ENV and the
    # planted value is read back.
    home = tmp_path / "home"
    home.mkdir()
    (home / ".gitconfig").write_text("[uploadpack]\n\tpackObjectsHook = /tmp/planted\n", encoding="utf-8")
    monkeypatch.setitem(store.GIT_ENV, "HOME", str(home))
    cp = store.git(["config", "--get", "uploadpack.packObjectsHook"], cwd=store.REPOS_DIR)
    assert cp.returncode == 1, cp.stdout
    assert cp.stdout.strip() == ""


def test_create_from_template_is_a_real_checkout_with_the_bare_as_origin(store):
    st = store.create_workspace("ws-a", "python-tool", ALICE)
    assert st["branch"] == "work" and st["dirty"] is False and st["tags"] == []
    work = store.work_path("ws-a")
    assert (work / "tool.py").is_file()
    assert (work / "extension-manifest.json").is_file()
    assert (work / ".gitignore").read_text().startswith("__pycache__/")
    origin = store.git(["remote", "get-url", "origin"], work).stdout.strip()
    assert origin == str(store.bare_path("ws-a"))
    # The bare repo already has the initial commit — the backup set is current.
    bare_head = store.git(["rev-parse", "work"], store.bare_path("ws-a")).stdout.strip()
    assert bare_head == st["head"]


def test_create_without_template_and_the_error_shapes(store):
    st = store.create_workspace("ws-b", None, ALICE)
    assert (store.work_path("ws-b") / "README.md").read_text() == "# ws-b\n"
    assert st["dirty"] is False
    with pytest.raises(StoreError) as dup:
        store.create_workspace("ws-b", None, ALICE)
    assert dup.value.status == 409
    with pytest.raises(StoreError) as bad_tpl:
        store.create_workspace("ws-c", "no-such-template", ALICE)
    assert bad_tpl.value.status == 400 and "python-tool" in str(bad_tpl.value)
    with pytest.raises(StoreError) as bad_id:
        store.create_workspace("../escape", None, ALICE)
    assert bad_id.value.status == 400
    with pytest.raises(StoreError) as missing:
        store.status("ws-nope")
    assert missing.value.status == 404
    # A failed create leaves nothing behind.
    assert not store.bare_path("ws-c").exists() and not store.work_path("ws-c").exists()


def test_delete_removes_both_halves(store):
    store.create_workspace("ws-d", None, ALICE)
    assert store.delete_workspace("ws-d") is True
    assert not store.bare_path("ws-d").exists() and not store.work_path("ws-d").exists()
    assert store.delete_workspace("ws-d") is False


# ── file operations ─────────────────────────────────────────────────────────


def test_read_search_write_diff_commit_log_round_trip(store):
    store.create_workspace("ws-e", "python-tool", ALICE)
    r = workspace.read("ws-e", "tool.py")
    assert r["kind"] == "file" and "def run(" in r["content"] and r["truncated"] is False
    d = workspace.read("ws-e", ".")
    assert d["kind"] == "directory" and "tool.py" in d["entries"] and ".git" not in d["entries"]

    hits = workspace.search("ws-e", "def run")
    assert [h["path"] for h in hits["hits"]] == ["tool.py"] and hits["hits"][0]["line"] > 0

    w1 = workspace.write("ws-e", "notes/plan.md", "# plan\n")
    w2 = workspace.write("ws-e", "notes/plan.md", "# plan\n")
    assert w1 == {"path": "notes/plan.md", "bytes": 7, "changed": True}
    assert w2["changed"] is False  # idempotent

    diff = workspace.diff("ws-e")
    assert "notes/plan.md" in diff["diff"] and "+# plan" in diff["diff"]
    assert store.status("ws-e")["dirty"] is True

    c1 = workspace.commit("ws-e", "add the plan", ALICE)
    assert c1["changed"] is True
    c2 = workspace.commit("ws-e", "nothing to do", ALICE)
    assert c2 == {"commit": c1["commit"], "changed": False}
    assert workspace.diff("ws-e")["diff"] == ""
    # ...and the bare repo has it.
    assert store.git(["rev-parse", "work"], store.bare_path("ws-e")).stdout.strip() == c1["commit"]

    log = workspace.log("ws-e", 5)
    assert [e["subject"] for e in log["entries"]] == ["add the plan", "workspace ws-e: created from template python-tool"]
    assert log["entries"][0]["author"] == "Alice"

    since = workspace.diff("ws-e", log["entries"][1]["commit"])
    assert "+# plan" in since["diff"]


@pytest.mark.parametrize(
    "path",
    [
        "../outside.txt",
        "/etc/passwd",
        ".git/config",
        ".git/hooks/pre-commit",
        "notes/../../x",
        "a\\b",
        "",
    ],
)
def test_paths_are_confined_to_the_checkout(store, path):
    # MUTATION: drop the realpath check in workspace._inside and
    # "notes/../../x" resolves outside; drop the .git guard and a write to
    # .git/hooks/pre-commit runs on the next commit.
    store.create_workspace("ws-f", None, ALICE)
    for op in (lambda: workspace.read("ws-f", path), lambda: workspace.write("ws-f", path, "x")):
        with pytest.raises(StoreError) as exc:
            op()
        assert exc.value.status in (400, 404)


def test_symlink_inside_the_checkout_cannot_reach_out(store, tmp_path):
    if sys.platform == "win32":
        pytest.skip("symlinks need a privilege on Windows dev boxes")
    store.create_workspace("ws-g", None, ALICE)
    secret = tmp_path / "secret.txt"
    secret.write_text("s3cret")
    (store.work_path("ws-g") / "link").symlink_to(secret)
    with pytest.raises(StoreError):
        workspace.read("ws-g", "link")


def test_write_is_capped_and_read_reports_truncation(store, monkeypatch):
    store.create_workspace("ws-h", None, ALICE)
    with pytest.raises(StoreError) as exc:
        workspace.write("ws-h", "big.txt", "x" * (workspace.MAX_WRITE_BYTES + 1))
    assert exc.value.status == 413
    monkeypatch.setattr(workspace, "MAX_READ_BYTES", 8)
    workspace.write("ws-h", "long.txt", "0123456789")
    r = workspace.read("ws-h", "long.txt")
    assert r["truncated"] is True and r["content"] == "01234567" and r["bytes"] == 10


# ── run ─────────────────────────────────────────────────────────────────────


def test_run_allow_list_is_closed_in_shape():
    # MUTATION: pass argv straight to Popen and every refusal below goes
    # green-for-the-wrong-reason.
    r = workspace.resolve_run_argv
    for argv in (
        ["bash", "-c", "id"],
        ["python", "evil.py"],
        ["npm", "install", "left-pad"],
        ["npm", "run", "start"],
        ["npm"],
        ["pytest", "; rm -rf /"],
        ["pytest", "../../etc"],
        ["tsc", "/etc/passwd"],
        ["ruff", "check", "$(id)"],
        [],
    ):
        with pytest.raises(StoreError) as exc:
            r(argv)
        assert exc.value.status == 400, argv
    assert r(["pytest", "-q"]) == [sys.executable, "-m", "pytest", "-q"]
    assert r(["ruff", "check", "."]) == [sys.executable, "-m", "ruff", "check", "."]
    assert r(["npm", "test"]) == ["/usr/local/bin/npm", "test"]
    assert r(["npm", "run", "build"]) == ["/usr/local/bin/npm", "run", "build"]
    assert r(["tsc", "--noEmit", "-p", "."]) == ["/usr/local/bin/tsc", "--noEmit", "-p", "."]


def test_run_executes_pytest_in_the_checkout_and_records_the_output(store):
    store.create_workspace("ws-i", "python-tool", ALICE)
    res = workspace.run("ws-i", ["pytest", "-q"], 120_000)
    assert res["exitCode"] == 0, res["stdout"] + res["stderr"]
    assert "2 passed" in res["stdout"]
    assert res["timedOut"] is False and res["truncated"] is False
    # The record names what ACTUALLY ran — the allow-list's executable, never
    # a bare name PATH resolved.
    assert res["executable"] == sys.executable
    assert workspace.last_run("ws-i")["argv"] == ["pytest", "-q"]
    # The record is not part of the tree: nothing to commit after a run.
    assert store.status("ws-i")["dirty"] is False

    workspace.write("ws-i", "test_tool.py", "def test_boom():\n    assert 1 == 2\n")
    res = workspace.run("ws-i", ["pytest", "-q"], 120_000)
    assert res["exitCode"] == 1 and "1 failed" in res["stdout"]


def test_run_lints_with_ruff(store):
    store.create_workspace("ws-j", "python-tool", ALICE)
    res = workspace.run("ws-j", ["ruff", "check", "."], 60_000)
    assert res["exitCode"] == 0, res["stdout"] + res["stderr"]


def test_run_times_out_and_says_so(store, monkeypatch):
    store.create_workspace("ws-k", "python-tool", ALICE)
    workspace.write("ws-k", "test_slow.py", "import time\n\ndef test_slow():\n    time.sleep(30)\n")
    res = workspace.run("ws-k", ["pytest", "-q", "test_slow.py"], 1000)
    assert res["timedOut"] is True and res["exitCode"] is None


def test_run_refuses_a_disallowed_command_before_starting_anything(store):
    store.create_workspace("ws-l", None, ALICE)
    with pytest.raises(StoreError) as exc:
        workspace.run("ws-l", ["bash", "-c", "touch pwned"], 1000)
    assert exc.value.status == 400
    assert not (store.work_path("ws-l") / "pwned").exists()
    assert workspace.last_run("ws-l") is None


# ── the checkout follows the repository ─────────────────────────────────────


def _push_from_outside(store, workspace_id: str, tmp_path, filename: str, content: str) -> str:
    """What an owner does over /git/: clone the bare repo elsewhere, commit,
    push `work`. Returns the new head. The sandbox's checkout knows nothing."""
    clone = tmp_path / f"outside-{workspace_id}-{filename.replace('/', '_')}"
    store.must(store.git(["clone", "-q", "-b", "work", str(store.bare_path(workspace_id)), str(clone)], tmp_path), "clone")
    (clone / filename).write_text(content, encoding="utf-8", newline="")
    store.must(store.git(["add", "-A"], clone), "add")
    store.must(store.git(["commit", "-q", "-m", f"outside: {filename}"], clone, author=("Owner", "owner@example.test")), "commit")
    store.must(store.git(["push", "-q", "origin", "work"], clone), "push")
    return store.must(store.git(["rev-parse", "HEAD"], clone), "rev-parse").stdout.strip()


def test_an_outside_push_is_seen_by_the_next_operation(store, tmp_path):
    # Mutation: drop the fetch/fast-forward in _follow_repository → read 404s
    # and the commit below is refused at push as a non-fast-forward.
    store.create_workspace("ws-m", "python-tool", ALICE)
    head = _push_from_outside(store, "ws-m", tmp_path, "PUSHED.md", "# from outside\n")
    r = workspace.read("ws-m", "PUSHED.md")
    assert r["content"] == "# from outside\n"
    assert workspace.log("ws-m", 1)["entries"][0]["commit"].startswith(head[:12])
    # And the run can keep committing on top of it.
    workspace.write("ws-m", "AFTER.md", "after\n")
    c = workspace.commit("ws-m", "after the outside push", ALICE)
    assert c["changed"] is True
    bare_head = store.git(["rev-parse", "work"], store.bare_path("ws-m")).stdout.strip()
    assert bare_head == c["commit"]


def test_an_outside_push_over_uncommitted_work_is_a_409_not_a_merge(store, tmp_path):
    store.create_workspace("ws-n", "python-tool", ALICE)
    workspace.write("ws-n", "draft.md", "half done\n")  # dirty checkout, a run mid-edit
    _push_from_outside(store, "ws-n", tmp_path, "PUSHED.md", "# from outside\n")
    with pytest.raises(StoreError) as exc:
        workspace.read("ws-n", "draft.md")
    assert exc.value.status == 409 and "moved under" in str(exc.value)
    # Nothing was merged or lost: the draft is still there, untouched.
    assert (store.work_path("ws-n") / "draft.md").read_text(encoding="utf-8") == "half done\n"
    assert not (store.work_path("ws-n") / "PUSHED.md").exists()


def test_a_checkout_ahead_of_the_repository_is_left_alone(store, monkeypatch):
    # A commit whose push failed earlier: HEAD is ahead, origin/work is an
    # ancestor. That is not divergence — the next commit pushes again.
    store.create_workspace("ws-o", "python-tool", ALICE)
    work = store.work_path("ws-o")
    (work / "AHEAD.md").write_text("ahead\n", encoding="utf-8", newline="")
    store.must(store.git(["add", "-A"], work), "add")
    store.must(store.git(["commit", "-q", "-m", "local only"], work, author=ALICE), "commit")
    r = workspace.read("ws-o", "AHEAD.md")
    assert r["content"] == "ahead\n"
    c = workspace.commit("ws-o", "nothing new", ALICE)
    assert c["changed"] is False


# ── propose ─────────────────────────────────────────────────────────────────


def test_propose_writes_the_manifest_tags_and_pushes(store):
    store.create_workspace("ws-m", "typescript-tool", ALICE)
    workspace.write("ws-m", "src/index.ts", "export const run = () => 1;\n")
    p = workspace.propose("ws-m", "Word counter", "0.1.0", "Counts words.", ALICE)
    assert p["tag"] == "proposal/0.1.0"
    m = p["manifest"]
    assert m["id"] == "ws-m" and m["name"] == "Word counter" and m["version"] == "0.1.0"
    assert m["egress"] == "none" and m["summary"] == "Counts words."
    on_disk = json.loads((store.work_path("ws-m") / "extension-manifest.json").read_text())
    assert on_disk == m
    assert store.status("ws-m")["tags"] == ["proposal/0.1.0"] and store.status("ws-m")["dirty"] is False
    # The tag reached the bare repo — that is what the review surface reads.
    bare_tags = store.git(["tag", "--list"], store.bare_path("ws-m")).stdout.split()
    assert bare_tags == ["proposal/0.1.0"]
    # Same version twice is refused, not overwritten.
    with pytest.raises(StoreError) as exc:
        workspace.propose("ws-m", "Word counter", "0.1.0", "again", ALICE)
    assert exc.value.status == 409
    for bad in ("1", "v1.0.0", "1.0", "latest"):
        with pytest.raises(StoreError):
            workspace.propose("ws-m", "x", bad, "s", ALICE)


def test_propose_never_lets_egress_through(store):
    # MUTATION: drop the `manifest["egress"] = "none"` line and a manifest a
    # run edited to `egress: "*"` is proposed as-is.
    store.create_workspace("ws-n", "python-tool", ALICE)
    workspace.write("ws-n", "extension-manifest.json", json.dumps({"schemaVersion": 1, "egress": "*", "extra": True}))
    p = workspace.propose("ws-n", "Leaky", "0.2.0", "tries to phone home", ALICE)
    assert p["manifest"]["egress"] == "none" and p["manifest"]["extra"] is True


# ── smart HTTP ──────────────────────────────────────────────────────────────


def _refs(store, repo: str, service: str, allow_push: bool, user: str = "alice"):
    return store.http_backend(
        method="GET",
        path_info=f"/{repo}.git/info/refs",
        query=f"service={service}",
        content_type=None,
        content_encoding=None,
        body=b"",
        remote_user=user,
        allow_push=allow_push,
    )


def test_http_backend_serves_fetch_and_gates_push_on_the_orchestrators_word(store):
    store.create_workspace("ws-o", None, ALICE)
    code, headers, body = _refs(store, "ws-o", "git-upload-pack", allow_push=False)
    assert code == 200, body
    assert headers["content-type"] == "application/x-git-upload-pack-advertisement"
    assert body.startswith(b"001e# service=git-upload-pack")
    assert b"refs/heads/work" in body

    # MUTATION: drop GIT_CONFIG_* from http_backend's env and this passes for
    # the wrong reason — http-backend enables receive-pack by itself whenever
    # REMOTE_USER is set, which it always is here.
    code, _, body = _refs(store, "ws-o", "git-receive-pack", allow_push=False)
    assert code == 403, body

    code, headers, body = _refs(store, "ws-o", "git-receive-pack", allow_push=True)
    assert code == 200, body
    assert headers["content-type"] == "application/x-git-receive-pack-advertisement"


def test_http_backend_refuses_paths_outside_the_store(store):
    for path in ("/../etc/passwd", "/ws-o", "/x/../templates.git/info/refs", "/.git/info/refs"):
        code, _, _ = store.http_backend(
            method="GET", path_info=path, query="", content_type=None, content_encoding=None,
            body=b"", remote_user="alice", allow_push=False,
        )
        assert code == 404, path
    code, _, _ = _refs(store, "no-such-repo", "git-upload-pack", allow_push=False)
    assert code == 404


# ── the HTTP layer ──────────────────────────────────────────────────────────


def test_routes_round_trip_through_the_service(client, auth, store):
    assert client.get("/workspaces/templates", headers=auth).json() == {"templates": ["python-tool", "typescript-tool"]}
    r = client.post("/workspaces", json={"id": "ws-p", "template": "python-tool", "author": AUTHOR}, headers=auth)
    assert r.status_code == 200, r.text
    assert client.post("/workspaces", json={"id": "ws-p", "author": AUTHOR}, headers=auth).status_code == 409
    assert client.post("/workspaces", json={"id": "Bad Id", "author": AUTHOR}, headers=auth).status_code == 422
    assert client.get("/workspaces/ws-p", headers=auth).json()["branch"] == "work"
    assert client.get("/workspaces/ws-zz", headers=auth).status_code == 404

    assert client.post("/workspaces/ws-p/read", json={"path": "tool.py"}, headers=auth).json()["kind"] == "file"
    assert client.post("/workspaces/ws-p/read", json={"path": "../x"}, headers=auth).status_code == 400
    assert client.post("/workspaces/ws-p/write", json={"path": "a.txt", "content": "hi"}, headers=auth).json()["changed"] is True
    assert client.post("/workspaces/ws-p/search", json={"pattern": "hi"}, headers=auth).json()["hits"] == []  # untracked
    assert client.post("/workspaces/ws-p/commit", json={"message": "a", "author": AUTHOR}, headers=auth).json()["changed"] is True
    assert client.post("/workspaces/ws-p/search", json={"pattern": "hi"}, headers=auth).json()["hits"][0]["path"] == "a.txt"
    assert len(client.post("/workspaces/ws-p/log", json={"limit": 1}, headers=auth).json()["entries"]) == 1
    assert client.post("/workspaces/ws-p/diff", json={}, headers=auth).json()["diff"] == ""
    assert client.get("/workspaces/ws-p/output", headers=auth).json() == {"lastRun": None}
    assert client.post("/workspaces/ws-p/run", json={"argv": ["bash", "-c", "id"]}, headers=auth).status_code == 400
    p = client.post(
        "/workspaces/ws-p/propose",
        json={"name": "N", "version": "0.1.0", "summary": "s", "author": AUTHOR},
        headers=auth,
    )
    assert p.status_code == 200 and p.json()["tag"] == "proposal/0.1.0"
    assert client.delete("/workspaces/ws-p", headers=auth).json() == {"id": "ws-p", "deleted": True}
    assert client.delete("/workspaces/ws-p", headers=auth).status_code == 404


def test_every_workspace_route_needs_the_bearer(client, store):
    assert client.get("/workspaces/templates").status_code == 401
    assert client.post("/workspaces", json={"id": "ws-q", "author": AUTHOR}).status_code == 401
    assert client.get("/git/ws-q.git/info/refs?service=git-upload-pack").status_code == 401


def test_git_route_needs_an_actor_and_forwards_the_push_decision(client, auth, store):
    store.create_workspace("ws-r", None, ALICE)
    url = "/git/ws-r.git/info/refs?service=git-receive-pack"
    assert client.get(url, headers=auth).status_code == 401  # no X-Droplet-Git-User
    denied = client.get(url, headers={**auth, "X-Droplet-Git-User": "bob"})
    assert denied.status_code == 403
    allowed = client.get(url, headers={**auth, "X-Droplet-Git-User": "alice", "X-Droplet-Git-Push": "1"})
    assert allowed.status_code == 200
    assert allowed.headers["content-type"] == "application/x-git-receive-pack-advertisement"
    fetch = client.get("/git/ws-r.git/info/refs?service=git-upload-pack", headers={**auth, "X-Droplet-Git-User": "bob"})
    assert fetch.status_code == 200 and fetch.content.startswith(b"001e# service=git-upload-pack")
