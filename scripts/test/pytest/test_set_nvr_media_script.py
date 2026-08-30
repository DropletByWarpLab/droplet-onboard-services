"""Hermetic tests for the NVR recordings-target write-back script (WARP-2099).

`NVR_MEDIA_SOURCE` decides where Frigate writes 24/7 camera footage. Until this
script existed nothing anywhere WROTE it, so every factory reset silently
reverted recordings to the boot disk — that is how a 2x2 TB RAID1 sat empty for
a month while `/` climbed to 94%.

The VALIDATION is the unit under test, because the failure mode being fixed is
a *silent* one: every rejected shape here is a shape that would otherwise end
with footage on the boot disk and nothing saying so.

Two guards carry the weight and both are asserted by mutation below:

  * an absolute path on the SAME FILESYSTEM AS `/` is refused. Note this is
    deliberately NOT a "is it a mountpoint" test — `/` and `/boot` are both
    mountpoints and both are exactly the disks footage must never reach.
  * a non-existent bind source is refused, because Docker would silently
    create an empty directory for it and record to the boot disk anyway.

Driven via subprocess with the .env path, the compose file, and the "root"
st_dev all redirected, so nothing here touches a real box and no second
physical filesystem is needed. Skipped automatically if `bash` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "host" / "droplet-set-nvr-media.sh"
SECRETS_LIB = REPO_ROOT / "scripts" / "lib" / "secrets.sh"
COMPOSE = REPO_ROOT / "docker" / "docker-compose.yml"
INSTALLER = REPO_ROOT / "scripts" / "install-device-bridge.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _run(target, env_file: Path, *, compose: Path | None = None,
         root_dev: str | None = None, extra: dict | None = None):
    env = dict(os.environ)
    env.update({
        "DROPLET_NVR_MEDIA_ENV_FILE": str(env_file),
        # Never let a test recreate a container.
        "DROPLET_NVR_MEDIA_SKIP_RECREATE": "1",
        "DROPLET_NVR_MEDIA_COMPOSE_FILE": str(compose if compose else COMPOSE),
    })
    if root_dev is not None:
        env["DROPLET_NVR_MEDIA_ROOT_DEV"] = root_dev
    if extra:
        env.update(extra)
    argv = [BASH, str(SCRIPT)]
    if target is not None:
        argv.append(target)
    return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)


def _off_root(path: Path) -> str:
    """A 'root device' value guaranteed to differ from `path`'s, so the script
    treats `path` as living on a non-root filesystem."""
    return str(os.stat(path).st_dev + 1)


def _on_root(path: Path) -> str:
    """A 'root device' equal to `path`'s — simulates a target on `/`."""
    return str(os.stat(path).st_dev)


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------

def test_script_exists_and_is_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_no_argument_is_refused(tmp_path):
    proc = _run(None, tmp_path / ".env")
    assert proc.returncode != 0
    assert "no recordings target" in proc.stderr


# --------------------------------------------------------------------------
# The boot-disk guards — the reason this ticket exists
# --------------------------------------------------------------------------

def test_path_on_the_root_filesystem_is_refused(tmp_path):
    """The headline guard: a path on `/` fills the boot disk and takes the
    appliance down. A plain mountpoint test would ACCEPT `/` itself."""
    env_file = tmp_path / ".env"
    target = tmp_path / "recordings"
    target.mkdir()
    proc = _run(str(target), env_file, root_dev=_on_root(target))
    assert proc.returncode != 0
    assert "ROOT filesystem" in proc.stderr
    assert not env_file.exists() or "NVR_MEDIA_SOURCE" not in env_file.read_text()


def test_nonexistent_path_is_refused(tmp_path):
    """Docker creates an empty dir for a missing bind source and records to the
    boot disk anyway — the exact silent failure being fixed."""
    env_file = tmp_path / ".env"
    proc = _run(str(tmp_path / "does-not-exist"), env_file,
                root_dev=_off_root(tmp_path))
    assert proc.returncode != 0
    assert "does not exist" in proc.stderr


def test_boot_filesystem_is_refused_even_when_off_root(tmp_path):
    """`/boot` is a separate device from `/` on every Droplet layout, so the
    st_dev test alone would wave it through."""
    if not Path("/boot").is_dir():
        pytest.skip("/boot not present in this environment")
    proc = _run("/boot", tmp_path / ".env", root_dev="999999")
    assert proc.returncode != 0
    assert "boot filesystem" in proc.stderr


def test_relative_path_is_refused(tmp_path):
    """Compose would read a relative source against the compose file's dir —
    i.e. inside the repo, on the boot disk."""
    proc = _run("some/relative/dir", tmp_path / ".env")
    assert proc.returncode != 0
    assert "neither an absolute path nor a valid volume name" in proc.stderr


def test_value_with_whitespace_is_refused(tmp_path):
    proc = _run("nvr data", tmp_path / ".env")
    assert proc.returncode != 0
    assert "whitespace" in proc.stderr


def test_newline_injection_cannot_add_a_second_env_key(tmp_path):
    """A LINE-based validator would pass this on its first line and let the
    second assignment land in .env."""
    env_file = tmp_path / ".env"
    proc = _run("nvrdata\nDEVICE_SECRET_KEY=pwned", env_file)
    assert proc.returncode != 0
    body = env_file.read_text(encoding="utf-8") if env_file.exists() else ""
    assert "pwned" not in body


# --------------------------------------------------------------------------
# Named-volume shape
# --------------------------------------------------------------------------

def test_declared_volume_name_is_accepted(tmp_path):
    env_file = tmp_path / ".env"
    proc = _run("nvrdata", env_file)
    assert proc.returncode == 0, proc.stderr
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in env_file.read_text(encoding="utf-8")


def test_undeclared_volume_name_is_refused(tmp_path):
    """An undefined volume makes `docker compose up` fail for the WHOLE stack —
    worse than the misconfiguration being fixed."""
    proc = _run("not-a-declared-volume", tmp_path / ".env")
    assert proc.returncode != 0
    assert "not declared" in proc.stderr


def test_nvrdata_is_actually_declared_in_the_real_compose_file():
    """Pins the default the compose seam falls back to; if `nvrdata` is ever
    renamed, the shipped default must be updated with it."""
    body = COMPOSE.read_text(encoding="utf-8")
    assert "\n  nvrdata:\n" in body


# --------------------------------------------------------------------------
# Write behaviour
# --------------------------------------------------------------------------

def test_offroot_path_is_accepted_and_written(tmp_path):
    env_file = tmp_path / ".env"
    target = tmp_path / "pool" / "nvr"
    target.mkdir(parents=True)
    proc = _run(str(target), env_file, root_dev=_off_root(target))
    assert proc.returncode == 0, proc.stderr
    assert f"NVR_MEDIA_SOURCE={target}\n" in env_file.read_text(encoding="utf-8")


def test_write_is_idempotent(tmp_path):
    env_file = tmp_path / ".env"
    _run("nvrdata", env_file)
    first = env_file.read_bytes()
    _run("nvrdata", env_file)
    assert env_file.read_bytes() == first, "re-run must be byte-identical"


def test_replaces_existing_key_in_place_and_keeps_neighbours(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "POSTGRES_PASSWORD=keepme\n"
        "NVR_MEDIA_SOURCE=/old/target\n"
        "JWT_SECRET=alsokeepme\n",
        encoding="utf-8",
    )
    proc = _run("nvrdata", env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in body
    assert "/old/target" not in body
    assert "POSTGRES_PASSWORD=keepme\n" in body
    assert "JWT_SECRET=alsokeepme\n" in body
    assert body.count("NVR_MEDIA_SOURCE=") == 1


def test_missing_trailing_newline_does_not_glue_keys(tmp_path):
    """An interrupted previous writer leaves .env without a trailing newline;
    appending blindly corrupts BOTH that key and ours."""
    env_file = tmp_path / ".env"
    env_file.write_text("JWT_SECRET=abc", encoding="utf-8")  # no trailing \n
    proc = _run("nvrdata", env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "JWT_SECRET=abc\n" in body
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in body


# --------------------------------------------------------------------------
# WARP-2522 — the write must go THROUGH a symlinked .env, literally
# --------------------------------------------------------------------------

# Symlink creation and `&`/`|` in directory names are POSIX-shaped; on a
# Windows checkout these would error in the fixture, not exercise the script.
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX-only fixture")


@posix_only
def test_env_symlink_survives_the_rewrite(tmp_path):
    """After relocate_secrets_to_data has run, the repo .env is a SYMLINK into
    the encrypted /data. The old tmp+mv rewrite unlinked it and dropped a
    plaintext secrets file on the unencrypted boot disk (the WARP-232
    regression class). The write must land THROUGH the link — the link
    survives and the bytes change at the link's REAL target."""
    real = tmp_path / "data" / "secrets.env"
    real.parent.mkdir()
    real.write_text(
        "JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=/old/target\n", encoding="utf-8"
    )
    link = tmp_path / ".env"
    link.symlink_to(real)

    proc = _run("nvrdata", link)
    assert proc.returncode == 0, proc.stderr
    assert link.is_symlink(), "the .env symlink was replaced by a plain file"
    body = real.read_text(encoding="utf-8")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in body
    assert "JWT_SECRET=keepme\n" in body
    assert "/old/target" not in body


@posix_only
def test_sed_hostile_target_value_lands_byte_exact(tmp_path):
    """`&` in a sed replacement splices in the matched text and `|` was the
    old expression's delimiter — an operator-supplied path containing either
    must land in .env byte-exact, neither corrupted nor a sed error."""
    env_file = tmp_path / ".env"
    env_file.write_text("NVR_MEDIA_SOURCE=/old/target\n", encoding="utf-8")
    target = tmp_path / "pool" / "a&b|c" / "nvr"
    target.mkdir(parents=True)

    proc = _run(str(target), env_file, root_dev=_off_root(target))
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"NVR_MEDIA_SOURCE={target}\n" in body
    assert body.count("NVR_MEDIA_SOURCE=") == 1


# --------------------------------------------------------------------------
# Provisioning always STATES the target (the ".env is never silent" AC)
# --------------------------------------------------------------------------

def test_generate_env_writes_the_key_explicitly():
    """A fresh install must not leave the key absent — absence is what let the
    compose `:-` default point at the boot disk with nothing recording it."""
    body = SECRETS_LIB.read_text(encoding="utf-8")
    assert "NVR_MEDIA_SOURCE=nvrdata" in body, \
        "generate_env() no longer writes NVR_MEDIA_SOURCE"


def test_migrate_env_backfills_the_key_for_existing_boxes():
    body = SECRETS_LIB.read_text(encoding="utf-8")
    assert "_migrate_ensure_key NVR_MEDIA_SOURCE" in body, \
        "migrate_env() no longer backfills NVR_MEDIA_SOURCE"


def test_scripts_tree_contains_a_writer_at_all():
    """WARP-2099's headline symptom: `grep -rn NVR_MEDIA_SOURCE scripts/`
    returned ZERO writes. Keep it non-zero."""
    hits = []
    for path in (REPO_ROOT / "scripts").rglob("*"):
        if path.is_file() and path.suffix in (".sh", ".py"):
            try:
                if "NVR_MEDIA_SOURCE" in path.read_text(encoding="utf-8", errors="ignore"):
                    hits.append(path)
            except OSError:
                pass
    assert hits, "no script in scripts/ references NVR_MEDIA_SOURCE"


def test_installer_installs_the_writer():
    """Leg 3 is inert on a real box unless the installer places it."""
    body = INSTALLER.read_text(encoding="utf-8")
    assert "droplet-set-nvr-media.sh" in body


# --------------------------------------------------------------------------
# Mutation checks — prove the guards are load-bearing, not decorative
# --------------------------------------------------------------------------

def test_mutation_removing_the_root_device_guard_breaks_a_test(tmp_path):
    """Neuter the st_dev comparison; the root-filesystem case must stop being
    refused. A guard whose removal changes nothing is a guard that never ran."""
    mutated = tmp_path / "mutated.sh"
    src = SCRIPT.read_text(encoding="utf-8")
    needle = 'if [ "$_root_dev" = "$_target_dev" ]; then'
    assert needle in src, "guard shape changed — update this mutation test"
    mutated.write_text(src.replace(needle, 'if false; then'), encoding="utf-8")

    env_file = tmp_path / ".env"
    target = tmp_path / "recordings"
    target.mkdir()
    env = dict(os.environ)
    env.update({
        "DROPLET_NVR_MEDIA_ENV_FILE": str(env_file),
        "DROPLET_NVR_MEDIA_SKIP_RECREATE": "1",
        "DROPLET_NVR_MEDIA_COMPOSE_FILE": str(COMPOSE),
        "DROPLET_NVR_MEDIA_ROOT_DEV": _on_root(target),
        # The mutant runs from tmp_path, so it cannot find scripts/lib/ from
        # its own location the way the in-tree script does — anchor it back
        # to the real repo (the script honors a REPO_ROOT override) so the
        # canonical _upsert_env_kv writer resolves (WARP-2522).
        "REPO_ROOT": str(REPO_ROOT),
    })
    proc = subprocess.run([BASH, str(mutated), str(target)],
                          env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, (
        "mutant should ACCEPT a root-filesystem target; if it still refuses, "
        "the real guard is not what rejects it"
    )


def test_mutation_removing_the_existence_check_changes_the_diagnostic(tmp_path):
    """Drop the `-d` check and the actionable "does not exist" refusal must
    disappear.

    Deliberately NOT asserting the mutant succeeds: `stat` also fails on a
    missing path, so the write is still blocked downstream. That makes the
    `-d` check defence-in-depth rather than the sole gate - so what this
    proves is that it is the check producing the diagnostic that names the
    real problem, instead of a generic "could not determine the filesystem".
    """
    mutated = tmp_path / "mutated.sh"
    src = SCRIPT.read_text(encoding="utf-8")
    needle = '[ -d "$TARGET" ] || die'
    assert needle in src, "existence check shape changed - update this test"
    mutated.write_text(src.replace(needle, ': || die'), encoding="utf-8")

    env = dict(os.environ)
    env.update({
        "DROPLET_NVR_MEDIA_ENV_FILE": str(tmp_path / ".env"),
        "DROPLET_NVR_MEDIA_SKIP_RECREATE": "1",
        "DROPLET_NVR_MEDIA_COMPOSE_FILE": str(COMPOSE),
        "DROPLET_NVR_MEDIA_ROOT_DEV": "999999",
        # Same repo re-anchoring as the mutation test above (WARP-2522).
        "REPO_ROOT": str(REPO_ROOT),
    })
    missing = str(tmp_path / "does-not-exist")
    real = subprocess.run([BASH, str(SCRIPT), missing], env=env,
                          capture_output=True, text=True, timeout=60)
    mut = subprocess.run([BASH, str(mutated), missing], env=env,
                         capture_output=True, text=True, timeout=60)
    assert "does not exist" in real.stderr
    assert "does not exist" not in mut.stderr, (
        "removing the -d check did not change the refusal, so that check "
        "never fires and is not what rejects a missing bind source"
    )
