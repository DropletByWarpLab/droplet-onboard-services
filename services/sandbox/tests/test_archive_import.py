"""Archive import validates hostile inputs before creating a real Git repo."""
from __future__ import annotations

import io
import os
import stat
import struct
import subprocess
import tarfile
import threading
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


def test_zip_preflight_counts_the_directory_zipfile_will_allocate(tmp_path, monkeypatch):
    # ZipFile adjusts central-directory offsets for prepended data. The EOCD
    # can point at a different, smaller fake directory in that prefix.
    original = bytearray(zipped([("a", b"one"), ("b", b"two")]).getvalue())
    end = len(original) - 22
    directory_size = struct.unpack_from("<L", original, end + 12)[0]
    fake = bytearray(b"PK\x01\x02" + b"\0" * 42)
    struct.pack_into("<H", fake, 28, directory_size - 46)
    fake.extend(b"x" * (directory_size - 46))
    struct.pack_into("<HH", original, end + 8, 1, 1)
    struct.pack_into("<L", original, end + 16, 0)
    body = io.BytesIO(fake + original)
    # The underlying parser actually sees two entries, despite EOCD count 1.
    with zipfile.ZipFile(body) as parsed:
        assert len(parsed.infolist()) == 2
    body.seek(0)
    monkeypatch.setattr(archive_import, "MAX_ENTRIES", 1)

    def must_not_allocate(*args, **kwargs):
        pytest.fail("ZipFile allocated entries before bounded preflight refused them")

    monkeypatch.setattr(archive_import.zipfile, "ZipFile", must_not_allocate)
    with pytest.raises(StoreError) as refused:
        archive_import.unpack(body, "zip", tmp_path)
    assert refused.value.status in {400, 413}


def test_zip_with_legitimate_prepended_data_imports_normally(store):
    body = io.BytesIO(b"self-extracting-prefix\n" + zipped([("index.html", b"ok")]).getvalue())
    result = archive_import.import_workspace("shop", "zip", body, ("A", "a@b.test"))
    assert result["dirty"] is False
    assert (store.work_path("shop") / "index.html").read_bytes() == b"ok"


@pytest.mark.parametrize("footer_in_comment", [False, True])
def test_zip64_metadata_cannot_override_bounded_preflight(tmp_path, monkeypatch, footer_in_comment):
    original = zipped([("a", b"one"), ("b", b"two")]).getvalue()
    end = len(original) - 22
    size, start = struct.unpack_from("<LL", original, end + 12)
    fake = bytearray(b"PK\x01\x02" + b"\0" * 42)
    struct.pack_into("<H", fake, 28, 152)
    fake.extend(b"x" * 76)
    # The classic directory claims one entry and absorbs the ZIP64 footer
    # as its name. ZipFile uses the 64-bit size/count/offset instead, allocating
    # the two real entries and a third header BEFORE our old post-open cap.
    zip64 = struct.pack("<4sQ2H2L4Q", b"PK\x06\x06", 44, 45, 45, 0, 0, 3, 3, size + len(fake), start)
    locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, end + len(fake), 1)
    classic = bytearray(original[end:])
    struct.pack_into("<HH", classic, 8, 1, 1)
    struct.pack_into("<LL", classic, 12, len(fake) + len(zip64) + len(locator), start + size)
    body_bytes = original[:end] + fake + zip64 + locator + classic
    if footer_in_comment:
        outer = bytearray(zipped([("outer", b"ok")]).getvalue())
        struct.pack_into("<H", outer, len(outer) - 2, len(body_bytes))
        body_bytes = outer + body_bytes
    body = io.BytesIO(body_bytes)
    with zipfile.ZipFile(body) as parsed:
        assert len(parsed.infolist()) == 3
    body.seek(0)
    monkeypatch.setattr(archive_import, "MAX_ENTRIES", 1)

    def must_not_allocate(*args, **kwargs):
        pytest.fail("ZIP64 overrides reached ZipFile allocation")

    monkeypatch.setattr(archive_import.zipfile, "ZipFile", must_not_allocate)
    with pytest.raises(StoreError) as refused:
        archive_import.unpack(body, "zip", tmp_path)
    assert refused.value.status in {400, 413}


def test_oversized_imported_manifest_is_refused_before_loading_its_blob(store, monkeypatch):
    archive_import.import_workspace("shop", "zip", zipped([("extension-manifest.json", b"x" * 9)]), ("A", "a@b.test"))
    work = store.work_path("shop")
    store.must(store.git(["tag", "proposal/0.1.0"], work), "tag")
    store.must(store.git(["push", "origin", "refs/tags/proposal/0.1.0"], work), "push")
    monkeypatch.setattr(store, "MAX_MANIFEST_BYTES", 8)
    real_git = store.git

    def no_oversized_blob(args, *rest, **kwargs):
        if args[:2] == ["cat-file", "blob"]:
            pytest.fail("oversized manifest was loaded before its byte ceiling was checked")
        return real_git(args, *rest, **kwargs)

    monkeypatch.setattr(store, "git", no_oversized_blob)
    with pytest.raises(StoreError) as refused:
        store.read_at_tag("shop", "proposal/0.1.0")
    assert refused.value.status == 413


def test_regular_create_and_import_have_one_owner_and_preserve_the_winner(store, monkeypatch):
    import gitstore

    started, release, imported = threading.Event(), threading.Event(), threading.Event()
    real_git = gitstore.git
    results, errors = {}, {}

    def pause_regular_init(args, *rest, **kwargs):
        if threading.current_thread().name == "regular-create" and args[:2] == ["init", "--bare"]:
            started.set()
            assert release.wait(10), "test did not release regular creation"
        return real_git(args, *rest, **kwargs)

    monkeypatch.setattr(gitstore, "git", pause_regular_init)

    def create():
        try:
            results["create"] = store.create_workspace("shop", None, ("A", "a@b.test"))
        except (StoreError, OSError, AssertionError) as exc:
            errors["create"] = exc

    def do_import():
        try:
            results["import"] = archive_import.import_workspace("shop", "zip", zipped([("app.py", b"pass")]), ("B", "b@b.test"))
        except (StoreError, OSError, AssertionError) as exc:
            errors["import"] = exc
        finally:
            imported.set()

    creator = threading.Thread(target=create, name="regular-create")
    importer = threading.Thread(target=do_import, name="archive-create")
    creator.start()
    try:
        assert started.wait(10)
        importer.start()
        imported.wait(5)
    finally:
        release.set()
        creator.join(10)
        if importer.ident is not None:
            importer.join(10)
    assert not creator.is_alive() and not importer.is_alive()
    assert len(results) == 1
    assert len(errors) == 1
    winner = next(iter(results.values()))
    assert store.status("shop")["head"] == winner["head"]
    assert store.bare_path("shop").is_dir() and store.work_path("shop").is_dir()
    refused = next(iter(errors.values()))
    assert isinstance(refused, StoreError) and refused.status == 409


@pytest.mark.parametrize("creator", ["regular", "archive"])
@pytest.mark.parametrize("step", ["init", "commit", "push"])
def test_failed_creation_removes_only_its_own_repository(store, monkeypatch, creator, step):
    real_git = store.git

    def fail_selected_step(args, *rest, **kwargs):
        if args[0] == step:
            return subprocess.CompletedProcess(args, 1, "", "injected failure")
        return real_git(args, *rest, **kwargs)

    monkeypatch.setattr(store, "git", fail_selected_step)
    with pytest.raises(StoreError, match="injected failure"):
        if creator == "regular":
            store.create_workspace("shop", None, ("A", "a@b.test"))
        else:
            archive_import.import_workspace("shop", "zip", zipped([("app.py", b"pass")]), ("A", "a@b.test"))
    assert not store.bare_path("shop").exists() and not store.work_path("shop").exists()
    assert not list(store.WORK_DIR.glob(".archive-import-*"))


@pytest.mark.parametrize("creator", ["regular", "archive"])
def test_creation_cannot_take_over_a_checkout_claimed_after_precheck(store, monkeypatch, creator):
    real_git = store.git
    foreign = store.work_path("shop")

    def claim_checkout_during_init(args, *rest, **kwargs):
        result = real_git(args, *rest, **kwargs)
        if args[:2] == ["init", "--bare"]:
            foreign.mkdir()
        return result

    monkeypatch.setattr(store, "git", claim_checkout_during_init)
    with pytest.raises(StoreError) as refused:
        if creator == "regular":
            store.create_workspace("shop", None, ("A", "a@b.test"))
        else:
            archive_import.import_workspace("shop", "zip", zipped([("app.py", b"pass")]), ("A", "a@b.test"))
    assert refused.value.status == 409
    assert foreign.is_dir() and not list(foreign.iterdir())
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
