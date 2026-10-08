"""Archive import validates hostile inputs before creating a real Git repo."""
from __future__ import annotations

import io
import os
import stat
import tarfile
import zipfile

import pytest

import archive_import
import supervisor
from gitstore import StoreError


def zipped(files):
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files:
            entry = zipfile.ZipInfo(name)
            entry.filename = name  # preserve hostile separator bytes on Windows
            archive.writestr(entry, content)
    body.seek(0)
    return body


def tarred(files, *, link=None):
    body = io.BytesIO()
    with tarfile.open(fileobj=body, mode="w:gz") as archive:
        for name, content in files:
            entry = tarfile.TarInfo(name)
            entry.mode = 0o777
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
        if link:
            entry = tarfile.TarInfo("link")
            entry.type = link
            entry.linkname = "/etc/passwd"
            archive.addfile(entry)
    body.seek(0)
    return body


@pytest.mark.parametrize("format", ["zip", "tar.gz"])
def test_first_commit_keeps_vendored_and_built_ignored_assets(store, tmp_path, format):
    files = [(".gitignore", b"dist/\nnode_modules/\n"), ("dist/index.html", b"<h1>Imported UI</h1>"),
             ("node_modules/local/index.js", b"export default 1;"), ("bin/start", b"#!/bin/sh\n"), ("server.py", b"print(1)")]
    body = zipped(files) if format == "zip" else tarred(files)
    result = archive_import.import_workspace("shop", format, body, ("\u00c6sa", "asa@example.test"))
    assert result["dirty"] is False
    bare = store.bare_path("shop")
    assert store.git(["rev-list", "--count", "work"], bare).stdout.strip() == "1"
    assert "\u00c6sa" in store.git(["show", "-s", "--format=%an", "work"], bare).stdout
    paths = store.git(["ls-tree", "-r", "--name-only", "work"], bare).stdout
    assert "dist/index.html" in paths and "node_modules/local/index.js" in paths
    tree = store.git(["rev-parse", "work^{tree}"], bare).stdout.strip()
    target = tmp_path / "installed"
    store.export_commit("shop", result["head"], tree, target)
    assert (target / "dist/index.html").read_bytes() == b"<h1>Imported UI</h1>"
    if os.name == "posix":
        assert stat.S_IMODE((store.work_path("shop") / "server.py").stat().st_mode) == 0o644
        if format == "tar.gz":
            assert stat.S_IMODE((store.work_path("shop") / "bin/start").stat().st_mode) == 0o755


@pytest.mark.parametrize("name", ["../leak", "/absolute", "C:/drive", "a\\escape", ".git/config", "dir/.GiT/config", ".workspace/run", "a/../escape", "NUL.txt", "a.", "a\nheader"])
@pytest.mark.parametrize("format", ["zip", "tar.gz"])
def test_unsafe_paths_leave_no_repository(store, name, format):
    body = zipped([(name, b"bad")]) if format == "zip" else tarred([(name, b"bad")])
    with pytest.raises(StoreError) as refused:
        archive_import.import_workspace("shop", format, body, ("A", "a@b.test"))
    assert refused.value.status == 400
    assert not store.bare_path("shop").exists() and not store.work_path("shop").exists()
    assert not list(store.WORK_DIR.glob(".archive-import-*"))


@pytest.mark.parametrize("kind", [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE])
def test_tar_links_and_devices_refused(store, kind):
    with pytest.raises(StoreError, match="links and special"):
        archive_import.import_workspace("shop", "tar.gz", tarred([], link=kind), ("A", "a@b.test"))


def test_zip_symlink_and_duplicate_alias_refused(store):
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w") as archive:
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "/etc/passwd")
    body.seek(0)
    with pytest.raises(StoreError, match="links"):
        archive_import.import_workspace("shop", "zip", body, ("A", "a@b.test"))
    with pytest.raises(StoreError, match="duplicate"):
        archive_import.import_workspace("shop", "zip", zipped([("a", b"one"), ("A", b"two")]), ("A", "a@b.test"))


def test_bomb_count_and_unpacked_caps_before_repo_creation(store, monkeypatch):
    monkeypatch.setattr(archive_import, "MAX_UNPACKED_BYTES", 8)
    with pytest.raises(StoreError) as error:
        archive_import.import_workspace("shop", "zip", zipped([("index.html", b"x" * 9)]), ("A", "a@b.test"))
    assert error.value.status == 413
    monkeypatch.setattr(archive_import, "MAX_ENTRIES", 1)
    with pytest.raises(StoreError) as error:
        archive_import.import_workspace("shop", "zip", zipped([("a", b""), ("b", b"")]), ("A", "a@b.test"))
    assert error.value.status == 413
    assert not store.bare_path("shop").exists()


def test_duplicate_existing_workspace_is_preserved(store):
    store.create_workspace("shop", None, ("A", "a@b.test"))
    head = store.status("shop")["head"]
    with pytest.raises(StoreError) as error:
        archive_import.import_workspace("shop", "zip", zipped([("a", b"x")]), ("A", "a@b.test"))
    assert error.value.status == 409 and store.status("shop")["head"] == head


def test_large_pax_metadata_is_refused_before_reading_its_body(tmp_path):
    body = io.BytesIO()
    with tarfile.open(fileobj=body, mode="w:gz") as archive:
        entry = tarfile.TarInfo("metadata")
        entry.type = tarfile.XHDTYPE
        entry.size = 65_537
        archive.addfile(entry, io.BytesIO(b"x" * entry.size))
    body.seek(0)
    with pytest.raises(StoreError) as error:
        archive_import.unpack(body, "tar.gz", tmp_path)
    assert error.value.status == 413


def test_http_import_bearer_gate_limit_and_cleanup(store, client, auth, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    body = zipped([("index.html", b"ok")]).getvalue()
    url = "/workspaces/shop/import?format=zip"
    headers = {**auth, "x-droplet-author-name": "A", "x-droplet-author-email": "a%40b.test"}
    assert client.post(url, content=body).status_code == 401
    assert client.post(url, headers=auth, content=body).status_code == 400
    assert client.post("/workspaces/Bad_ID/import?format=zip", headers=headers, content=body).status_code == 400
    monkeypatch.setattr(archive_import, "MAX_ARCHIVE_BYTES", len(body) - 1)
    assert client.post(url, headers=headers, content=body).status_code == 413
    assert not store.bare_path("shop").exists()
    monkeypatch.setattr(archive_import, "MAX_ARCHIVE_BYTES", len(body))
    assert client.post(url, headers=headers, content=body).status_code == 200
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", False)
    assert client.post("/workspaces/other/import?format=zip", headers=headers, content=body).status_code == 404
