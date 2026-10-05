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

WARP-3514 (ADR-070) extends the script with --status / --apply / --resize (an
auto-sized, quota-capped recordings slice on an encrypted bay drive). Those
tests start at the "WARP-3514" banner near the end of this file; the WARP-2099
tests above are untouched and prove the legacy positional mode is unchanged.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from _topology_lock_test_support import add_trusted_stat_env

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


# ==========================================================================
# WARP-3514 (ADR-070) — auto-sized, quota-capped recordings slice
#
# New modes: --status, --apply, --resize. Every test below drives the script
# through PATH shims (findmnt, lsblk, chattr, stat, docker, python3) plus the
# quota-tool and statfs hooks. A fake "kernel" keeps the project-quota table,
# so the post-set read-back verification is exercised for real: a quota tool
# that reports back what was set, a statfs that honours the cap — and knobs
# that make each of them lie. No root, no block device, no docker.
#
# Linux-only fixtures (shims, symlinks, `mv -T`): skipped on a Windows dev host.
# ==========================================================================

BAY_UUID = "0a1b2c3d-1111-2222-3333-444455556666"
OTHER_UUID = "99999999-aaaa-bbbb-cccc-dddddddddddd"
BAY_TAIL = "bay-0a1b2c3d"
BAY_DEV = "/dev/mapper/droplet-bay-ab12cd34"
KIB, MIB, GIB = 1024, 1024 ** 2, 1024 ** 3
FRSIZE = 4096
FS_BLOCKS = 25_000_000
FS_BYTES = FRSIZE * FS_BLOCKS          # 102_400_000_000 — the bay filesystem
LIMIT = 10 * GIB                       # a typical auto-sized slice
PROJID = 4096

needs_root = pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="needs root to chown (runs in the Linux test container)",
)

# Bash shims. Each logs its argv to $FAKE_CALLS so a test can assert what was
# (and was NOT) invoked, in order.
_NVR_STUBS = {
    "findmnt": r'''
printf 'findmnt %s\n' "$*" >> "$FAKE_CALLS"
[ -z "${FAKE_FINDMNT_FAIL:-}" ] || exit 127
cols="TARGET,SOURCE,FSTYPE,OPTIONS"; spec=""; tgt=""; mp=""; prev=""
for a in "$@"; do
  case "$prev" in
    -o) cols="$a" ;;
    -S) spec="$a" ;;
    --target) tgt="$a" ;;
    --mountpoint) mp="$a" ;;
  esac
  prev="$a"
done
awk -F'\t' -v cols="$cols" -v spec="$spec" -v tgt="$tgt" -v mp="$mp" '
function esc(s) { gsub(/ /, "\\x20", s); return s }
BEGIN { n = split(cols, C, ","); nr = 0; best = ""; bestlen = -1 }
{
  if (spec != "") { split(spec, K, "="); if (K[1] == "UUID" && $5 == K[2]) rows[++nr] = $0 }
  else if (tgt != "") {
    t = $1
    if (t == "/" || tgt == t || index(tgt, t "/") == 1) {
      if (length(t) >= bestlen) { bestlen = length(t); best = $0 }
    }
  }
  else if (mp != "") { if ($1 == mp) rows[++nr] = $0 }
  else rows[++nr] = $0
}
END {
  if (tgt != "" && best != "") rows[++nr] = best
  for (i = 1; i <= nr; i++) {
    split(rows[i], R, "\t"); out = ""
    for (j = 1; j <= n; j++) {
      v = ""
      if (C[j] == "TARGET") v = R[1]
      else if (C[j] == "SOURCE") v = R[2]
      else if (C[j] == "FSTYPE") v = R[3]
      else if (C[j] == "OPTIONS") v = R[4]
      else if (C[j] == "UUID") v = R[5]
      out = out (j > 1 ? " " : "") esc(v)
    }
    print out
  }
  exit ((nr > 0) ? 0 : 1)
}' "$FAKE_MOUNTS"
''',
    "lsblk": r'''
printf 'lsblk %s\n' "$*" >> "$FAKE_CALLS"
[ -z "${FAKE_LSBLK_FAIL:-}" ] || exit 127
cols=""; prev=""; dev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && cols="$a"
  prev="$a"; dev="$a"
done
case "$cols" in
  NAME,TYPE)
    rows="$(awk -F'\t' -v d="$dev" '$1 == d { print $2 " " $3 }' "$FAKE_LSBLK")"
    [ -n "$rows" ] || { printf 'lsblk: %s: not a block device\n' "$dev" >&2; exit 32; }
    printf '%s\n' "$rows" ;;
  UUID)
    awk -F'\t' -v d="$dev" '$1 == d { print $2 }' "$FAKE_LSBLK_UUID" ;;
esac
exit 0
''',
    "chattr": r'''
printf 'chattr %s\n' "$*" >> "$FAKE_CALLS"
exit "${FAKE_CHATTR_RC:-0}"
''',
    # Anything docker is a bug in the new modes: --apply must NOT recreate
    # Frigate and --status/--resize have no business with it.
    "docker": r'''
printf 'docker %s\n' "$*" >> "$FAKE_CALLS"
case "$*" in
  *files_external:list*) if [ -n "${FAKE_OCC_LIST:-}" ]; then printf '%s\n' "$FAKE_OCC_LIST"; exit 0; fi ;;
  *files_external:delete*) exit "${FAKE_OCC_DELETE_RC:-0}" ;;
esac
exit 99
''',
    # Only `stat -c %d <path>` (the legacy st_dev guard) can be faked; every
    # other invocation reaches the real stat.
    "stat": r'''
if [ -n "${FAKE_STAT_DEV_ROOT:-}" ] && [ "${1:-}" = "-c" ] && [ "${2:-}" = "%d" ]; then
  if [ "${3:-}" = "/" ]; then printf '%s\n' "$FAKE_STAT_DEV_ROOT"; else printf '%s\n' "$FAKE_STAT_DEV_OTHER"; fi
  exit 0
fi
exec /usr/bin/stat "$@"
''',
    # DROPLET_NVR_QUOTA_TOOL: a fake kernel quota table. `set` stores the limit
    # rounded UP to whole KiB (what the real tool does); `get` reads it back.
    "quota-tool": r'''
printf 'quota %s\n' "$*" >> "$FAKE_CALLS"
cmd="${1:-}"; projid="${3:-}"
hardfile="$FAKE_QUOTA_STATE.hard.$projid"
case "$cmd" in
  set)
    if [ "${FAKE_QUOTA_SET_RC:-0}" != 0 ]; then
      printf 'project quota not enabled on this filesystem\n' >&2
      exit "$FAKE_QUOTA_SET_RC"
    fi
    kib=$(( ($4 + 1023) / 1024 ))
    printf '%s\n' $(( kib * 1024 )) > "$hardfile"
    exit 0 ;;
  get)
    n=0; [ -f "$FAKE_QUOTA_STATE.gets" ] && n="$(cat "$FAKE_QUOTA_STATE.gets")"
    printf '%s\n' $(( n + 1 )) > "$FAKE_QUOTA_STATE.gets"
    if [ "${FAKE_QUOTA_GET_RC:-0}" != 0 ]; then echo "quota read failed" >&2; exit "$FAKE_QUOTA_GET_RC"; fi
    if [ -n "${FAKE_QUOTA_GET_FAIL_FIRST:-}" ] && [ "$n" -lt "$FAKE_QUOTA_GET_FAIL_FIRST" ]; then
      echo "quota read failed" >&2; exit 1
    fi
    if [ -n "${FAKE_QUOTA_GET_OUT:-}" ]; then printf '%s\n' "$FAKE_QUOTA_GET_OUT"; exit 0; fi
    hard=0; [ -f "$hardfile" ] && hard="$(cat "$hardfile")"
    printf '{"hardBytes":%s,"softBytes":0,"usedBytes":%s}\n' "$hard" "${FAKE_QUOTA_USED:-0}"
    exit 0 ;;
esac
exit 64
''',
    # DROPLET_NVR_MEDIA_STATFS: "<frsize> <blocks> <bfree> <bavail>" for $1.
    # For the bay's nvr dir it honours the quota the fake kernel holds (a
    # project-quota'd dir reports the quota as its total) unless the test says
    # the cap is invisible (FAKE_QUOTA_IGNORED) or pins the total (FAKE_NVR_TOTAL).
    "statfs": r'''
path="${1:-}"
printf 'statfs %s\n' "$path" >> "$FAKE_CALLS"
[ -z "${FAKE_STATFS_FAIL:-}" ] || exit 1
[ -z "${FAKE_STATFS_FAIL_PATH:-}" ] || [ "$path" != "$FAKE_STATFS_FAIL_PATH" ] || exit 1
hardfile="$FAKE_QUOTA_STATE.hard.${FAKE_PROJID:-4096}"
if [ "$path" = "$FAKE_NVR_DIR" ] && [ -z "${FAKE_QUOTA_IGNORED:-}" ] \
   && { [ -f "$hardfile" ] || [ -n "${FAKE_NVR_TOTAL:-}" ]; }; then
  frsize=4096
  if [ -n "${FAKE_NVR_TOTAL:-}" ]; then total="$FAKE_NVR_TOTAL"; else total="$(cat "$hardfile")"; fi
  blocks=$(( total / frsize )); used=$(( ${FAKE_QUOTA_USED:-0} / frsize ))
  free=$(( blocks - used )); [ "$free" -ge 0 ] || free=0
  printf '%s %s %s %s\n' "$frsize" "$blocks" "$free" "$free"
  exit 0
fi
filesfile="$FAKE_QUOTA_STATE.hard.${FAKE_FILES_PROJID:-4097}"
if [ -n "${FAKE_FILES_DIR:-}" ] && [ "$path" = "$FAKE_FILES_DIR" ] && [ -z "${FAKE_QUOTA_IGNORED:-}" ] \
   && [ -f "$filesfile" ]; then
  frsize=4096; total="$(cat "$filesfile")"; blocks=$(( total / frsize ))
  printf '%s %s %s %s\n' "$frsize" "$blocks" "$blocks" "$blocks"
  exit 0
fi
awk -F'\t' -v p="$path" '
BEGIN { best = -1 }
{ t = $1
  if (t == "/" || p == t || index(p, t "/") == 1) {
    if (length(t) >= best) { best = length(t); line = $2 " " $3 " " $4 " " $5 }
  }
}
END { if (best < 0) exit 1; print line }' "$FAKE_STATFS"
''',
}

ROOT_UUID = "11111111-0000-0000-0000-000000000001"
DATA_UUID = "11111111-0000-0000-0000-000000000003"


def _posix(p) -> str:
    return str(p).replace("\\", "/")


class _World:
    """A fake Droplet host: mount table, lsblk chains, statfs numbers, a quota
    table. `mount` is a REAL directory under tmp (the script creates
    <mount>/nvr in it); DROPLET_NVR_MOUNT_BASE points at its parent."""

    def __init__(self, tmp_path: Path):
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.root = tmp_path
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        self.stubs = self.fake / "bin"
        self.stubs.mkdir()
        self.base = tmp_path / "mnt"
        self.base.mkdir()
        self.mount = self.base / BAY_TAIL
        self.mount.mkdir()
        self.nvr = self.mount / "nvr"
        self.files = self.mount / "files"
        self.state_dir = tmp_path / "spool"
        self.state_dir.mkdir(mode=0o700)
        self.root_state = tmp_path / "root-state"
        self.topology_lock = tmp_path / "recordings-topology.lock"
        self.topology_lock.touch()
        self.repo = tmp_path / "repo"
        self.repo.mkdir()
        self.env_file = self.repo / ".env"
        self.calls = self.fake / "calls.log"
        self.calls.write_text("", encoding="utf-8")
        self.mounts: list[tuple[str, str, str, str, str]] = []
        self.chains: dict[str, list[tuple[str, str]]] = {}
        self.dev_uuids: dict[str, str] = {}
        self.statfs: dict[str, tuple[int, int, int, int]] = {}
        self.reset_topology()

    # -- topology ------------------------------------------------------------
    def reset_topology(self):
        """OS on nvme0n1 (/, /boot/efi, LUKS /data); the bay is a LUKS ext4 on
        its own disk sdb, mounted rw with prjquota, 102.4 GB with 81.9 GB free."""
        self.mounts = [
            ("/", "/dev/nvme0n1p2", "ext4", "rw,relatime", ROOT_UUID),
            ("/boot/efi", "/dev/nvme0n1p1", "vfat", "rw,relatime", "ABCD-1234"),
            ("/data", "/dev/mapper/droplet-data-crypt", "ext4", "rw,relatime", DATA_UUID),
            (str(self.mount), BAY_DEV, "ext4", "rw,nosuid,nodev,noatime,prjquota", BAY_UUID),
        ]
        self.chains = {
            "/dev/nvme0n1p2": [("nvme0n1p2", "part"), ("nvme0n1", "disk")],
            "/dev/nvme0n1p1": [("nvme0n1p1", "part"), ("nvme0n1", "disk")],
            "/dev/mapper/droplet-data-crypt": [
                ("droplet-data-crypt", "crypt"), ("nvme0n1p3", "part"), ("nvme0n1", "disk")],
            BAY_DEV: [("droplet-bay-ab12cd34", "crypt"), ("sdb1", "part"), ("sdb", "disk")],
        }
        self.dev_uuids = {}
        self.statfs = {
            "/": (FRSIZE, 10_000_000, 4_000_000, 4_000_000),
            str(self.mount): (FRSIZE, FS_BLOCKS, 20_000_000, 20_000_000),
        }

    def bay(self, **changes):
        """Edit the bay's mount row: target, source, fstype, options, uuid."""
        cols = ["target", "source", "fstype", "options", "uuid"]
        for i, row in enumerate(self.mounts):
            if row[0] == str(self.mount):
                new = dict(zip(cols, row))
                new.update(changes)
                self.mounts[i] = tuple(new[c] for c in cols)
                return
        raise AssertionError("bay mount row is gone")

    def unmount_bay(self):
        self.mounts = [r for r in self.mounts if r[0] != str(self.mount)]

    def add_mount(self, target, source, fstype="ext4", options="rw,relatime", uuid=""):
        self.mounts.append((target, source, fstype, options, uuid))

    # -- files ---------------------------------------------------------------
    def write_env(self, text: str):
        self.env_file.write_text(text, encoding="utf-8", newline="\n")

    def write_storage_json(self, raw: str | None = None, **fields):
        if raw is None:
            payload = {"fsUuid": BAY_UUID, "mountPath": str(self.mount),
                       "source": str(self.nvr), "mode": "reserved", "projectId": PROJID,
                       "limitBytes": LIMIT, "appliedAt": "2026-10-03T12:00:00Z"}
            payload.update(fields)
            raw = json.dumps(payload, separators=(",", ":")) + "\n"
        (self.state_dir / "storage.json").write_text(raw, encoding="utf-8", newline="\n")

    @property
    def storage_json(self) -> Path:
        return self.state_dir / "storage.json"

    @property
    def migration_json(self) -> Path:
        return self.root_state / "migration.json"

    def write(self):
        f = self.fake
        (f / "mounts.tsv").write_text(
            "".join("\t".join(r) + "\n" for r in self.mounts), encoding="utf-8", newline="\n")
        (f / "lsblk.tsv").write_text(
            "".join(f"{dev}\t{n}\t{t}\n" for dev, rows in self.chains.items() for n, t in rows),
            encoding="utf-8", newline="\n")
        (f / "lsblk-uuid.tsv").write_text(
            "".join(f"{d}\t{u}\n" for d, u in self.dev_uuids.items()),
            encoding="utf-8", newline="\n")
        (f / "statfs.tsv").write_text(
            "".join(f"{p}\t{a}\t{b}\t{c}\t{d}\n" for p, (a, b, c, d) in self.statfs.items()),
            encoding="utf-8", newline="\n")
        for name, body in _NVR_STUBS.items():
            stub = self.stubs / name
            stub.write_text("#!/usr/bin/env bash\n" + body.lstrip("\n"),
                            encoding="utf-8", newline="\n")
            os.chmod(stub, 0o755)
        # Pin the script's python3 to the interpreter running pytest (house
        # style: test_storage_pool_script.py).
        py = self.stubs / "python3"
        py.write_text('#!/usr/bin/env bash\nexec "%s" "$@"\n' % Path(sys.executable).as_posix(),
                      encoding="utf-8", newline="\n")
        os.chmod(py, 0o755)

    def env(self, extra: dict | None = None) -> dict:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("DROPLET_NVR_", "FAKE_"))}
        env.update({
            "PATH": _posix(self.stubs) + os.pathsep + env.get("PATH", ""),
            "DROPLET_NVR_MEDIA_ENV_FILE": str(self.env_file),
            "DROPLET_NVR_MEDIA_COMPOSE_FILE": str(COMPOSE),
            "DROPLET_NVR_MEDIA_SKIP_RECREATE": "1",
            "DROPLET_NVR_STATE_DIR": str(self.state_dir),
            "DROPLET_NVR_ROOT_STATE_DIR": str(self.root_state),
            "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(self.topology_lock),
            "DROPLET_NVR_MOUNT_BASE": str(self.base),
            "DROPLET_NVR_QUOTA_TOOL": str(self.stubs / "quota-tool"),
            "DROPLET_NVR_MEDIA_STATFS": str(self.stubs / "statfs"),
            "FAKE_CALLS": str(self.calls),
            "FAKE_MOUNTS": str(self.fake / "mounts.tsv"),
            "FAKE_LSBLK": str(self.fake / "lsblk.tsv"),
            "FAKE_LSBLK_UUID": str(self.fake / "lsblk-uuid.tsv"),
            "FAKE_STATFS": str(self.fake / "statfs.tsv"),
            "FAKE_QUOTA_STATE": str(self.fake / "quota"),
            "FAKE_NVR_DIR": str(self.nvr),
            "FAKE_FILES_DIR": str(self.files),
        })
        if extra:
            env.update(extra)
        return add_trusted_stat_env(env, self.stubs, self.topology_lock)


def _make_world(tmp_path: Path, env_text: str | None = "JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=nvrdata\n"):
    w = _World(tmp_path)
    if env_text is not None:
        w.write_env(env_text)
    return w


def _run_writer(w: _World, *args, extra_env: dict | None = None, script: Path = SCRIPT):
    w.write()
    return subprocess.run([BASH, str(script), *args], env=w.env(extra_env),
                          capture_output=True, text=True, timeout=120)


def _calls(w: _World, prefix: str | None = None) -> list[str]:
    lines = [ln for ln in w.calls.read_text(encoding="utf-8").splitlines() if ln]
    return [ln for ln in lines if prefix is None or ln.split(" ", 1)[0] == prefix]


def _snapshot(w: _World) -> dict:
    """Everything under the test tree except the fake host's own fixtures."""
    state = {}
    for p in sorted(w.root.rglob("*")):
        rel = p.relative_to(w.root).as_posix()
        if rel == "fake" or rel.startswith("fake/"):
            continue
        if p.is_symlink():
            state[rel] = ("link", os.readlink(p))
        elif p.is_dir():
            state[rel] = ("dir", stat.S_IMODE(p.stat().st_mode))
        else:
            state[rel] = ("file", stat.S_IMODE(p.stat().st_mode), p.read_bytes())
    return state


def _one_json(proc) -> dict:
    lines = proc.stdout.splitlines()
    assert len(lines) == 1, f"stdout must be ONE JSON line: {proc.stdout!r} (stderr {proc.stderr!r})"
    return json.loads(lines[0])


def _ok(proc) -> dict:
    assert proc.returncode == 0, (proc.returncode, proc.stdout, proc.stderr)
    body = _one_json(proc)
    assert body["ok"] is True, body
    return body


def _refused(proc, code: str | None = None) -> dict:
    assert proc.returncode == 1, (proc.returncode, proc.stdout, proc.stderr)
    body = _one_json(proc)
    assert body["ok"] is False, body
    assert set(body) == {"ok", "code", "message"}, body
    assert isinstance(body["message"], str) and body["message"]
    assert proc.stderr.startswith("droplet-set-nvr-media: "), proc.stderr
    assert body["message"] in proc.stderr
    if code is not None:
        assert body["code"] == code, body
    return body


def _apply_args(limit: int | None = LIMIT, mode: str = "reserved", uuid: str = BAY_UUID) -> list[str]:
    args = ["--apply", "--fs-uuid", uuid, "--mode", mode]
    if limit is not None:
        args += ["--limit-bytes", str(limit)]
    return args


def _applied(w: _World, **kw) -> dict:
    """Run a successful --apply (a PREPARED slice; the .env is NOT touched)."""
    return _ok(_run_writer(w, *_apply_args(**kw)))


def _flip(w: _World) -> None:
    """Simulate the migration flip: the .env now names the slice (WARP-3514: only
    the flip writes NVR_MEDIA_SOURCE) - the realistic precondition for --resize."""
    kept = []
    if w.env_file.exists():
        kept = [ln for ln in w.env_file.read_text(encoding="utf-8").splitlines()
                if not ln.startswith("NVR_MEDIA_SOURCE=")]
    w.write_env("\n".join(kept + [f"NVR_MEDIA_SOURCE={w.nvr}"]) + "\n")


def _applied_active(w: _World, **kw) -> dict:
    body = _applied(w, **kw)
    _flip(w)
    return body


STATUS_KEYS = {
    "source", "kind", "fsUuid", "mountPath", "physicalDisk", "backingDevices",
    "isSystemDisk", "encrypted", "mounted", "rw", "projectId", "limitBytes",
    "usedBytes", "fsSizeBytes", "fsFreeBytes",
}


def _status(w: _World, extra_env: dict | None = None) -> dict:
    proc = _run_writer(w, "--status", extra_env=extra_env)
    assert proc.returncode == 0, (proc.returncode, proc.stdout, proc.stderr)
    body = _one_json(proc)
    assert set(body) == STATUS_KEYS, set(body) ^ STATUS_KEYS
    return body


# --------------------------------------------------------------------------
# Hygiene
# --------------------------------------------------------------------------

def test_script_is_lf_and_parses_cleanly():
    raw = SCRIPT.read_bytes()
    assert b"\r" not in raw, "CRLF in a host script breaks the shebang on the box"
    proc = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr


def test_new_hooks_follow_the_shipping_product_naming_rule():
    """architecture-guard rule 17: no poc/prototype/-dev/-test in env-var names."""
    text = SCRIPT.read_text(encoding="utf-8")
    names = set(re.findall(r"\bDROPLET_[A-Z0-9_]+\b", text))
    assert {"DROPLET_NVR_QUOTA_TOOL", "DROPLET_NVR_STATE_DIR", "DROPLET_NVR_ROOT_STATE_DIR",
            "DROPLET_NVR_PROJID", "DROPLET_NVR_MEDIA_STATFS", "DROPLET_NVR_MEDIA_OSDISK",
            "DROPLET_NVR_MOUNT_BASE"} <= names
    # ROOT_DEV is the pre-existing WARP-2099 hook: "dev" there is a st_dev
    # DEVICE number, not a development-environment marker.
    for name in names - {"DROPLET_NVR_MEDIA_ROOT_DEV"}:
        assert not re.search(r"POC|PROTOTYPE|(^|_)DEV(_|$)|(^|_)TEST(_|$)", name), name


def test_files_cite_the_right_decision_record():
    stale = "ADR-" + "069"   # taken by another PR; the recordings ADR is ADR-070
    for path in (SCRIPT, REPO_ROOT / "scripts" / "host" / "droplet-nvr-quota.py",
                 Path(__file__), REPO_ROOT / "scripts" / "test" / "pytest" / "test_nvr_quota_helper.py"):
        text = path.read_text(encoding="utf-8")
        assert stale not in text, path
    assert "ADR-070" in SCRIPT.read_text(encoding="utf-8")


@posix_only
def test_an_unknown_dash_flag_still_gets_the_legacy_refusal(tmp_path):
    """Only --status/--apply/--resize are new. Anything else keeps today's
    behaviour: it is a (bad) positional target."""
    w = _make_world(tmp_path)
    proc = _run_writer(w, "--bogus")
    assert proc.returncode == 1
    assert "neither an absolute path nor a valid volume name" in proc.stderr
    assert proc.stdout == ""


# --------------------------------------------------------------------------
# --status
# --------------------------------------------------------------------------

@posix_only
def test_status_reports_the_active_bay_slice(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"JWT_SECRET=keepme\nNVR_MEDIA_SOURCE={w.nvr}\n")
    w.nvr.mkdir(mode=0o700)
    # a project-quota'd dir reports the QUOTA as its total: 10 GiB cap, 1 GiB used
    w.statfs[str(w.nvr)] = (FRSIZE, 2_621_440, 2_359_296, 2_359_296)
    w.write_storage_json()
    before = _snapshot(w)

    proc = _run_writer(w, "--status")

    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == {
        "source": str(w.nvr), "kind": "path", "fsUuid": BAY_UUID, "mountPath": str(w.mount),
        "physicalDisk": "sdb",
        "backingDevices": ["sdb", "sdb1", "droplet-bay-ab12cd34"],
        "isSystemDisk": False, "encrypted": True, "mounted": True, "rw": True,
        "projectId": PROJID, "limitBytes": 10 * GIB, "usedBytes": 1 * GIB,
        "fsSizeBytes": FS_BYTES, "fsFreeBytes": 20_000_000 * FRSIZE,
    }
    assert _snapshot(w) == before, "--status must never write anything"
    assert _calls(w, "docker") == [] and _calls(w, "chattr") == [] and _calls(w, "quota") == []


@posix_only
def test_status_of_an_unmounted_bay_resolves_onto_root_and_says_so(tmp_path):
    """An unmounted bay path resolves onto `/`, so it reports mounted:false AND
    isSystemDisk:true — correct and intended (the orchestrator maps it to
    drive_missing, not on_system_disk)."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.unmount_bay()
    w.write_storage_json()          # even a matching record cannot be trusted unmounted
    assert _status(w) == {
        "source": str(w.nvr), "kind": "path", "fsUuid": None, "mountPath": "/",
        "physicalDisk": "nvme0n1", "backingDevices": ["nvme0n1", "nvme0n1p2"],
        "isSystemDisk": True, "encrypted": False, "mounted": False, "rw": False,
        "projectId": None, "limitBytes": None, "usedBytes": None,
        "fsSizeBytes": 10_000_000 * FRSIZE, "fsFreeBytes": 4_000_000 * FRSIZE,
    }


@posix_only
def test_status_treats_the_shared_mount_base_itself_as_not_mounted(tmp_path):
    """/mnt/droplet is itself a (bind) mount on the OS disk; a path that only
    resolves to IT — not to /mnt/droplet/<tail> — is an unmounted bay."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.unmount_bay()
    # findmnt reports a bind of a subdirectory as SOURCE[/subdir]
    w.add_mount(str(w.base), "/dev/nvme0n1p2[/droplet]", "ext4", "rw,relatime", ROOT_UUID)
    body = _status(w)
    assert body["mountPath"] == str(w.base)
    assert body["mounted"] is False and body["isSystemDisk"] is True and body["fsUuid"] is None
    assert body["physicalDisk"] == "nvme0n1"


@posix_only
def test_status_of_a_named_volume_describes_the_docker_root_filesystem(tmp_path):
    """A named volume lives in Docker's data root on the OS disk: kind volume,
    mounted/rw true by definition, isSystemDisk true — whatever the ancestry."""
    w = _make_world(tmp_path, env_text=None)      # no .env at all -> nvrdata
    assert _status(w) == {
        "source": "nvrdata", "kind": "volume", "fsUuid": None, "mountPath": None,
        "physicalDisk": "nvme0n1", "backingDevices": ["nvme0n1", "nvme0n1p2"],
        "isSystemDisk": True, "encrypted": False, "mounted": True, "rw": True,
        "projectId": None, "limitBytes": None, "usedBytes": None,
        "fsSizeBytes": 10_000_000 * FRSIZE, "fsFreeBytes": 4_000_000 * FRSIZE,
    }


@posix_only
def test_status_of_a_volume_follows_a_separate_docker_root_mount(tmp_path):
    w = _make_world(tmp_path)
    w.add_mount("/var/lib/docker", "/dev/mapper/droplet-data-crypt", "ext4", "rw", DATA_UUID)
    w.statfs["/var/lib/docker"] = (FRSIZE, 5_000_000, 1_000_000, 1_000_000)
    body = _status(w)
    assert body["kind"] == "volume" and body["isSystemDisk"] is True
    assert body["encrypted"] is True                 # the docker root is on LUKS
    assert body["physicalDisk"] == "nvme0n1"
    assert body["backingDevices"] == ["nvme0n1", "nvme0n1p3", "droplet-data-crypt"]
    assert (body["fsSizeBytes"], body["fsFreeBytes"]) == (5_000_000 * FRSIZE, 1_000_000 * FRSIZE)


@posix_only
@pytest.mark.parametrize("line, expected", [
    ("NVR_MEDIA_SOURCE=nvrdata\r\n", "nvrdata"),                 # CRLF .env
    ('NVR_MEDIA_SOURCE="nvrdata"\n', "nvrdata"),
    ("NVR_MEDIA_SOURCE='nvrdata'\n", "nvrdata"),
    ("NVR_MEDIA_SOURCE=\n", "nvrdata"),                          # empty == the named volume
    ('NVR_MEDIA_SOURCE=""\n', "nvrdata"),
    ("JWT_SECRET=x\n", "nvrdata"),                               # key absent
    ("  NVR_MEDIA_SOURCE=/mnt/x/nvr\n", "nvrdata"),              # indented: not an assignment
    ("# NVR_MEDIA_SOURCE=/mnt/x/nvr\n", "nvrdata"),              # commented out
    ("NVR_MEDIA_SOURCE=/srv/first/nvr\nNVR_MEDIA_SOURCE=/srv/second/nvr\n", "/srv/first/nvr"),
    ('NVR_MEDIA_SOURCE="/srv/quoted/nvr"\r\n', "/srv/quoted/nvr"),
])
def test_status_source_follows_the_env_file_rules(tmp_path, line, expected):
    w = _make_world(tmp_path, env_text=None)
    w.env_file.write_bytes(line.encode("utf-8"))
    body = _status(w)
    assert body["source"] == expected
    assert body["kind"] == ("path" if expected.startswith("/") else "volume")


@posix_only
@pytest.mark.parametrize("case, raw", [
    ("stale-fsuuid", '{"fsUuid":"%s","projectId":4096}' % OTHER_UUID),
    ("not-json", "this is not json at all"),
    ("duplicate-keys", '{"fsUuid":"%s","fsUuid":"%s","projectId":4096}' % (BAY_UUID, BAY_UUID)),
    ("project-id-as-string", '{"fsUuid":"%s","projectId":"4096"}' % BAY_UUID),
    ("project-id-zero", '{"fsUuid":"%s","projectId":0}' % BAY_UUID),
    ("junk-uuid", '{"fsUuid":"zz-not-a-uuid","projectId":4096}'),
    ("missing-project-id", '{"fsUuid":"%s"}' % BAY_UUID),
    ("empty-file", ""),
])
def test_status_slice_fields_are_null_unless_the_record_matches(tmp_path, case, raw):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.nvr.mkdir(mode=0o700)
    w.statfs[str(w.nvr)] = (FRSIZE, 2_621_440, 2_359_296, 2_359_296)
    w.write_storage_json(raw=raw)
    body = _status(w)
    assert (body["projectId"], body["limitBytes"], body["usedBytes"]) == (None, None, None), case
    # the live facts are unaffected by a bad record
    assert body["mounted"] is True and body["fsUuid"] == BAY_UUID and body["rw"] is True


@posix_only
def test_status_without_a_record_has_a_null_slice(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    body = _status(w)
    assert (body["projectId"], body["limitBytes"], body["usedBytes"]) == (None, None, None)
    assert body["mounted"] is True


@posix_only
def test_status_matches_the_record_uuid_case_insensitively(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.nvr.mkdir(mode=0o700)
    w.statfs[str(w.nvr)] = (FRSIZE, 2_621_440, 2_359_296, 2_359_296)
    w.write_storage_json(fsUuid=BAY_UUID.upper())
    assert _status(w)["projectId"] == PROJID


@posix_only
def test_status_slice_is_null_when_the_source_dir_cannot_be_measured(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.write_storage_json()
    body = _status(w, extra_env={"FAKE_STATFS_FAIL": "1"})
    assert body["projectId"] == PROJID
    assert (body["limitBytes"], body["usedBytes"]) == (None, None)
    assert (body["fsSizeBytes"], body["fsFreeBytes"]) == (None, None)


@posix_only
def test_status_survives_findmnt_and_lsblk_being_unusable(tmp_path):
    """Missing tools => the affected fields are null/false. Never a crash,
    never non-JSON, still exit 0."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.write_storage_json()
    assert _status(w, extra_env={"FAKE_FINDMNT_FAIL": "1", "FAKE_LSBLK_FAIL": "1"}) == {
        "source": str(w.nvr), "kind": "path", "fsUuid": None, "mountPath": None,
        "physicalDisk": None, "backingDevices": [], "isSystemDisk": False,
        "encrypted": False, "mounted": False, "rw": False,
        "projectId": None, "limitBytes": None, "usedBytes": None,
        "fsSizeBytes": None, "fsFreeBytes": None,
    }


@posix_only
def test_status_without_lsblk_keeps_the_mount_facts(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    body = _status(w, extra_env={"FAKE_LSBLK_FAIL": "1"})
    assert body["mounted"] is True and body["rw"] is True and body["fsUuid"] == BAY_UUID
    assert body["physicalDisk"] is None and body["backingDevices"] == []
    assert body["encrypted"] is False and body["isSystemDisk"] is False


@posix_only
def test_status_volume_with_unusable_tools_is_still_a_system_disk_volume(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    body = _status(w, extra_env={"FAKE_FINDMNT_FAIL": "1", "FAKE_LSBLK_FAIL": "1",
                                 "FAKE_STATFS_FAIL": "1"})
    assert body["kind"] == "volume" and body["isSystemDisk"] is True
    assert body["mounted"] is True and body["rw"] is True
    assert body["physicalDisk"] is None and body["backingDevices"] == []
    assert body["fsSizeBytes"] is None


@posix_only
def test_status_falls_back_to_lsblk_for_a_uuid_findmnt_cannot_read(tmp_path):
    """Unprivileged, libblkid often cannot read the filesystem UUID; udev's
    database (via lsblk) still can."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.bay(uuid="")
    w.dev_uuids[BAY_DEV] = BAY_UUID
    assert _status(w)["fsUuid"] == BAY_UUID


@posix_only
def test_status_fsuuid_is_null_when_nobody_can_name_it(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.bay(uuid="")
    body = _status(w)
    assert body["mounted"] is True and body["fsUuid"] is None


@posix_only
@pytest.mark.parametrize("options, rw", [
    ("rw,nosuid,nodev,noatime,prjquota", True),
    ("rw,errors=remount-ro,prjquota", True),     # `remount-ro` is not the `ro` flag
    ("ro,nosuid,nodev,noatime,prjquota", False),
    ("nosuid,nodev", False),                      # neither flag: not provably writable
])
def test_status_rw_is_decided_by_whole_option_tokens(tmp_path, options, rw):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.bay(options=options)
    body = _status(w)
    assert body["mounted"] is True and body["rw"] is rw


@posix_only
def test_status_lists_every_physical_disk_behind_an_md_array(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("md0", "raid1"),
                         ("sdc1", "part"), ("sdc", "disk"), ("sdb1", "part"), ("sdb", "disk")]
    body = _status(w)
    assert body["physicalDisk"] == "sdb,sdc"            # sorted, unique, comma-joined
    assert body["encrypted"] is True and body["isSystemDisk"] is False
    assert sorted(body["backingDevices"]) == sorted(
        ["droplet-bay-ab12cd34", "md0", "sdc1", "sdc", "sdb1", "sdb"])


@posix_only
def test_status_backing_devices_are_unique(tmp_path):
    """Two members on partitions of one disk list that disk once."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("md0", "raid1"),
                         ("sdb1", "part"), ("sdb", "disk"), ("sdb2", "part"), ("sdb", "disk")]
    body = _status(w)
    assert body["physicalDisk"] == "sdb"
    assert len(body["backingDevices"]) == len(set(body["backingDevices"])) == 5


@posix_only
def test_status_flags_a_bay_that_shares_a_disk_with_the_os(tmp_path):
    """Physical ancestry, not device names: the bay's LUKS partition is on the
    same NVMe as /, so it is a system disk even though it is mounted and rw."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
    body = _status(w)
    assert body["mounted"] is True and body["rw"] is True
    assert body["isSystemDisk"] is True and body["encrypted"] is True


@posix_only
def test_status_os_disk_override_hook(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    assert _status(w)["isSystemDisk"] is False
    assert _status(w, extra_env={"DROPLET_NVR_MEDIA_OSDISK": "sdb"})["isSystemDisk"] is True


@posix_only
def test_status_default_measurement_is_stat_dash_f(tmp_path):
    """No DROPLET_NVR_MEDIA_STATFS hook: the script measures with `stat -f`."""
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    body = _status(w, extra_env={"DROPLET_NVR_MEDIA_STATFS": ""})
    vfs = os.statvfs(w.mount)
    assert body["fsSizeBytes"] == vfs.f_frsize * vfs.f_blocks
    assert 0 <= body["fsFreeBytes"] <= body["fsSizeBytes"]


@posix_only
@pytest.mark.parametrize("evil", [
    '/mnt/x","isSystemDisk":false,"x":"',
    '/mnt/x\\","encrypted":true',
    '/mnt/\x01\x02\x7f/x',
    "/mnt/tab\there/x",
    '/mnt/é中/x',
    "/mnt/" + "A" * 3000,
])
def test_status_json_cannot_be_injected_through_the_env_file(tmp_path, evil):
    """NVR_MEDIA_SOURCE is read from a droplet-writable file. Whatever it
    holds must come back as ONE string value — never as extra fields."""
    w = _make_world(tmp_path, env_text=None)
    w.env_file.write_bytes(f"NVR_MEDIA_SOURCE={evil}\n".encode("utf-8"))
    proc = _run_writer(w, "--status")
    assert proc.returncode == 0, proc.stderr
    body = json.loads(proc.stdout)
    assert set(body) == STATUS_KEYS
    assert body["kind"] == "path" and body["mounted"] is False
    assert isinstance(body["source"], str)
    assert proc.stdout.isascii(), "output must stay plain ASCII JSON"


@posix_only
def test_status_takes_no_arguments(tmp_path):
    w = _make_world(tmp_path)
    proc = _run_writer(w, "--status", "extra")
    _refused(proc, "bad_request")
    assert _calls(w) == []


# --------------------------------------------------------------------------
# --apply: prepare the slice and record the target (no frigate, no data move)
# --------------------------------------------------------------------------

@posix_only
def test_apply_reserved_prepares_the_slice_and_records_the_target(tmp_path):
    w = _make_world(tmp_path)
    proc = _run_writer(w, *_apply_args())

    assert _ok(proc) == {
        "ok": True, "operation": "apply", "fsUuid": BAY_UUID, "mountPath": str(w.mount),
        "source": str(w.nvr), "mode": "reserved", "projectId": PROJID,
        "limitBytes": LIMIT, "previousSource": "nvrdata",
        "filesLimitBytes": None, "filesDeregistered": False,
    }
    assert proc.stderr == "", "a successful apply is quiet on stderr"

    # <mount>/nvr: a real directory, root-only
    assert w.nvr.is_dir() and not w.nvr.is_symlink()
    assert stat.S_IMODE(w.nvr.stat().st_mode) == 0o700
    # project id + inherit flag first, then the hard limit — through the tool
    calls = _calls(w)
    assert f"chattr +P -p {PROJID} {w.nvr}" in calls
    assert f"quota set {BAY_DEV} {PROJID} {LIMIT}" in calls
    assert calls.index(f"chattr +P -p {PROJID} {w.nvr}") < calls.index(
        f"quota set {BAY_DEV} {PROJID} {LIMIT}")
    # .env: NOT touched - only the migration flip writes NVR_MEDIA_SOURCE
    assert w.env_file.read_text(encoding="utf-8") == "JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=nvrdata\n"
    # the last applied allocation, readable by the (unprivileged) status call
    rec = json.loads(w.storage_json.read_text(encoding="utf-8"))
    assert {k: rec[k] for k in ("fsUuid", "mountPath", "source", "mode", "projectId", "limitBytes")} == {
        "fsUuid": BAY_UUID, "mountPath": str(w.mount), "source": str(w.nvr),
        "mode": "reserved", "projectId": PROJID, "limitBytes": LIMIT}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", rec["appliedAt"])
    assert stat.S_IMODE(w.storage_json.stat().st_mode) == 0o600
    # the root-only record of where the footage lived before
    mig = json.loads(w.migration_json.read_text(encoding="utf-8"))
    assert {k: mig[k] for k in ("previousSource", "newSource", "fsUuid")} == {
        "previousSource": "nvrdata", "newSource": str(w.nvr), "fsUuid": BAY_UUID}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", mig["recordedAt"])
    assert stat.S_IMODE(w.root_state.stat().st_mode) == 0o700
    assert stat.S_IMODE(w.migration_json.stat().st_mode) == 0o600
    # NO frigate recreate and no data move
    assert _calls(w, "docker") == []


@posix_only
def test_apply_full_mode_limits_the_slice_to_the_filesystem_size(tmp_path):
    w = _make_world(tmp_path)
    body = _ok(_run_writer(w, *_apply_args(limit=None, mode="full")))
    assert body["mode"] == "full" and body["limitBytes"] == FS_BYTES
    assert f"quota set {BAY_DEV} {PROJID} {FS_BYTES}" in _calls(w, "quota")
    assert json.loads(w.storage_json.read_text(encoding="utf-8"))["mode"] == "full"


@posix_only
def test_apply_full_mode_validates_but_ignores_a_given_limit(tmp_path):
    w = _make_world(tmp_path)
    body = _ok(_run_writer(w, *_apply_args(limit=5, mode="full")))
    assert body["limitBytes"] == FS_BYTES

    w2 = _make_world(tmp_path / "two")  # fresh world
    proc = _run_writer(w2, "--apply", "--fs-uuid", BAY_UUID, "--mode", "full",
                       "--limit-bytes", "abc")
    _refused(proc, "bad_request")


@posix_only
def test_apply_recurses_the_project_id_over_existing_content(tmp_path):
    w = _make_world(tmp_path)
    w.nvr.mkdir(mode=0o700)
    (w.nvr / "clip.mp4").write_bytes(b"x")
    _applied(w)
    assert f"chattr -R +P -p {PROJID} {w.nvr}" in _calls(w, "chattr")
    assert f"chattr +P -p {PROJID} {w.nvr}" not in _calls(w, "chattr")


@posix_only
def test_apply_tightens_a_loose_existing_recordings_dir(tmp_path):
    w = _make_world(tmp_path)
    w.nvr.mkdir()
    os.chmod(w.nvr, 0o755)
    _applied(w)
    assert stat.S_IMODE(w.nvr.stat().st_mode) == 0o700


@posix_only
def test_apply_uses_the_configured_project_id(tmp_path):
    w = _make_world(tmp_path)
    body = _ok(_run_writer(w, *_apply_args(),
                           extra_env={"DROPLET_NVR_PROJID": "5000", "FAKE_PROJID": "5000"}))
    assert body["projectId"] == 5000
    assert f"chattr +P -p 5000 {w.nvr}" in _calls(w, "chattr")
    assert f"quota set {BAY_DEV} 5000 {LIMIT}" in _calls(w, "quota")


@posix_only
@pytest.mark.parametrize("projid", ["0", "abc", "-1", "1.5", "4294967295", "", " 7", "99999999999"])
def test_apply_refuses_a_misconfigured_project_id_before_touching_anything(tmp_path, projid):
    w = _make_world(tmp_path)
    before = _snapshot(w)
    proc = _run_writer(w, *_apply_args(), extra_env={"DROPLET_NVR_PROJID": projid})
    if projid == "":
        # empty == unset == the default 4096
        _ok(proc)
        return
    _refused(proc, "internal")
    assert _snapshot(w) == before
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == []


# --- idempotence + the root-only previous-source record ---------------------

@posix_only
def test_apply_is_idempotent_and_keeps_the_original_previous_source(tmp_path):
    w = _make_world(tmp_path)
    first = _applied(w)
    env_after_first = w.env_file.read_bytes()
    migration_after_first = w.migration_json.read_bytes()

    second = _applied(w)

    assert first == second                                  # same slice, same answer
    assert second["previousSource"] == "nvrdata"            # the .env still names the OLD source
    assert w.env_file.read_bytes() == env_after_first       # byte-identical re-run
    # the record keeps where the footage ORIGINALLY lived — never overwritten
    # with the new path
    assert w.migration_json.read_bytes() == migration_after_first
    assert json.loads(migration_after_first)["previousSource"] == "nvrdata"
    assert json.loads(w.storage_json.read_text(encoding="utf-8"))["limitBytes"] == LIMIT


@posix_only
def test_apply_records_a_retarget_with_the_current_value_as_previous(tmp_path):
    w = _make_world(tmp_path, env_text='NVR_MEDIA_SOURCE="/old/other/nvr"\n')
    w.root_state.mkdir(mode=0o700)
    w.migration_json.write_text(json.dumps({
        "previousSource": "nvrdata", "newSource": "/elsewhere/nvr",
        "fsUuid": OTHER_UUID, "recordedAt": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    body = _applied(w)
    assert body["previousSource"] == "/old/other/nvr"       # quotes stripped
    mig = json.loads(w.migration_json.read_text(encoding="utf-8"))
    assert (mig["previousSource"], mig["newSource"], mig["fsUuid"]) == (
        "/old/other/nvr", str(w.nvr), BAY_UUID)


@posix_only
def test_apply_keeps_a_recorded_previous_source_when_the_target_is_unchanged(tmp_path):
    """The record already describes this very target; a second apply (even
    with .env pointing elsewhere) must not rewrite where the footage came from."""
    w = _make_world(tmp_path, env_text="NVR_MEDIA_SOURCE=/somewhere/else/nvr\n")
    w.root_state.mkdir(mode=0o700)
    original = json.dumps({"previousSource": "nvrdata", "newSource": str(w.nvr),
                           "fsUuid": BAY_UUID, "recordedAt": "2020-01-01T00:00:00Z"})
    w.migration_json.write_text(original, encoding="utf-8")
    _applied(w)
    assert w.migration_json.read_text(encoding="utf-8") == original


@posix_only
def test_apply_writes_no_record_when_the_source_is_already_the_target(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.write_env(f"NVR_MEDIA_SOURCE={w.nvr}\n")
    body = _applied(w)
    assert body["previousSource"] == str(w.nvr)
    assert not w.migration_json.exists()


# --- .env writing ------------------------------------------------------------

@posix_only
def test_apply_reports_a_hostile_previous_source_as_plain_data(tmp_path):
    evil = 'x","envChanged":false,"ok":false,"y":"\\'
    w = _make_world(tmp_path, env_text=f"NVR_MEDIA_SOURCE={evil}\n")
    body = _ok(_run_writer(w, *_apply_args()))
    assert body["ok"] is True
    assert body["previousSource"] == evil
    assert json.loads(w.migration_json.read_text(encoding="utf-8"))["previousSource"] == evil


# --- the hardened atomic write of the state files ---------------------------

@posix_only
def test_apply_never_follows_a_planted_symlink_when_writing_state(tmp_path):
    """Root writes into a droplet-owned dir: a pre-planted symlink at the tmp
    or final name must never become a root-file write primitive."""
    victim = tmp_path / "victim.txt"
    victim.write_text("keep", encoding="utf-8")
    w = _make_world(tmp_path)
    (w.state_dir / "storage.json.tmp").symlink_to(victim)
    (w.state_dir / "storage.json").symlink_to(victim)
    w.root_state.mkdir(mode=0o700)
    (w.root_state / "migration.json.tmp").symlink_to(victim)

    _applied(w)

    assert victim.read_text(encoding="utf-8") == "keep"
    for path in (w.storage_json, w.migration_json):
        assert path.is_file() and not path.is_symlink()
    assert not (w.state_dir / "storage.json.tmp").exists()
    assert not (w.state_dir / "storage.json.tmp").is_symlink()
    assert not (w.root_state / "migration.json.tmp").is_symlink()


@posix_only
def test_apply_refuses_a_symlinked_state_directory(tmp_path):
    w = _make_world(tmp_path)
    real = tmp_path / "elsewhere"
    real.mkdir()
    w.state_dir.rmdir()
    w.state_dir.symlink_to(real)
    before = _snapshot(w)
    _refused(_run_writer(w, *_apply_args()), "internal")
    assert _snapshot(w) == before
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == []


@posix_only
def test_apply_refuses_when_the_state_directory_is_missing(tmp_path):
    w = _make_world(tmp_path)
    w.state_dir.rmdir()
    before = _snapshot(w)
    _refused(_run_writer(w, *_apply_args()), "internal")
    assert _snapshot(w) == before
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == []


@posix_only
def test_apply_refuses_a_symlinked_root_state_directory(tmp_path):
    w = _make_world(tmp_path)
    real = tmp_path / "elsewhere"
    real.mkdir()
    w.root_state.symlink_to(real)
    before = _snapshot(w)
    _refused(_run_writer(w, *_apply_args()), "internal")
    assert _snapshot(w) == before
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == []
    assert list(real.iterdir()) == []


# --- ownership (needs root: runs in the Linux test container) ---------------

@needs_root
@posix_only
def test_apply_hands_the_state_file_to_the_spool_owner_and_keeps_the_record_root_only(tmp_path):
    w = _make_world(tmp_path)
    os.chown(w.state_dir, 4246, 4247)
    _applied(w)
    st = w.storage_json.stat()
    assert (st.st_uid, st.st_gid) == (4246, 4247)       # the bridge user can read it
    mig = w.migration_json.stat()
    assert (mig.st_uid, stat.S_IMODE(mig.st_mode)) == (0, 0o600)
    assert (w.root_state.stat().st_uid, stat.S_IMODE(w.root_state.stat().st_mode)) == (0, 0o700)
    assert (w.nvr.stat().st_uid, stat.S_IMODE(w.nvr.stat().st_mode)) == (0, 0o700)


# --- the recordings directory is never a symlink -----------------------------

@posix_only
def test_apply_refuses_a_symlinked_recordings_dir(tmp_path):
    """root chmod/chattr through a planted symlink would act on an arbitrary dir."""
    w = _make_world(tmp_path)
    victim = tmp_path / "victim-dir"
    victim.mkdir()
    os.chmod(victim, 0o755)
    w.nvr.symlink_to(victim)
    before = _snapshot(w)
    _refused(_run_writer(w, *_apply_args()), "bad_mount")
    assert _snapshot(w) == before
    assert stat.S_IMODE(victim.stat().st_mode) == 0o755
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == []


@posix_only
def test_apply_refuses_a_file_where_the_recordings_dir_should_be(tmp_path):
    w = _make_world(tmp_path)
    w.nvr.write_text("not a directory", encoding="utf-8")
    before = _snapshot(w)
    _refused(_run_writer(w, *_apply_args()), "bad_mount")
    assert _snapshot(w) == before


# --------------------------------------------------------------------------
# --apply: refusals — stable machine codes, and NOTHING written
# --------------------------------------------------------------------------

def _untouched(w: _World, before: dict, proc, code: str):
    body = _refused(proc, code)
    assert _snapshot(w) == before, "a refusal must leave .env, state files and nvr/ alone"
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == [] and _calls(w, "docker") == []
    return body


_LONG_UUID_OK = "a" * 36
_BAD_APPLY_ARGS = {
    "no-flags": ["--apply"],
    "missing-uuid": ["--apply", "--mode", "full"],
    "missing-mode": ["--apply", "--fs-uuid", BAY_UUID],
    "reserved-without-limit": ["--apply", "--fs-uuid", BAY_UUID, "--mode", "reserved"],
    "uuid-too-short": ["--apply", "--fs-uuid", "abc12", "--mode", "full"],
    "uuid-too-long": ["--apply", "--fs-uuid", "a" * 37, "--mode", "full"],
    "uuid-leading-dash": ["--apply", "--fs-uuid", "-abcdef1", "--mode", "full"],
    "uuid-not-hex": ["--apply", "--fs-uuid", "zzzzzzzz-zzzz", "--mode", "full"],
    "uuid-semicolon": ["--apply", "--fs-uuid", "abcdef12;touch /tmp/pwned", "--mode", "full"],
    "uuid-command-substitution": ["--apply", "--fs-uuid", "$(touch /tmp/pwned)", "--mode", "full"],
    "uuid-backtick": ["--apply", "--fs-uuid", "`id`abcdef1", "--mode", "full"],
    "uuid-path": ["--apply", "--fs-uuid", "../../etc/passwd", "--mode", "full"],
    "uuid-newline": ["--apply", "--fs-uuid", BAY_UUID + "\nextra", "--mode", "full"],
    "uuid-space": ["--apply", "--fs-uuid", "abcdef12 34", "--mode", "full"],
    "uuid-empty": ["--apply", "--fs-uuid", "", "--mode", "full"],
    "mode-unknown": ["--apply", "--fs-uuid", BAY_UUID, "--mode", "partial"],
    "mode-wrong-case": ["--apply", "--fs-uuid", BAY_UUID, "--mode", "RESERVED", "--limit-bytes", "5"],
    "mode-empty": ["--apply", "--fs-uuid", BAY_UUID, "--mode", ""],
    "limit-zero": _apply_args(limit=0),
    "limit-negative": _apply_args(limit="-5"),
    "limit-float": _apply_args(limit="1.5"),
    "limit-hex": _apply_args(limit="0x10"),
    "limit-leading-zero": _apply_args(limit="0100"),
    "limit-plus": _apply_args(limit="+5"),
    "limit-space": _apply_args(limit="1 000"),
    "limit-empty": _apply_args(limit=""),
    "limit-above-2-62": _apply_args(limit=2 ** 62 + 1),
    "limit-20-digits": _apply_args(limit="1" * 20),
    "duplicate-uuid": _apply_args() + ["--fs-uuid", OTHER_UUID],
    "duplicate-mode": _apply_args() + ["--mode", "full"],
    "duplicate-limit": _apply_args() + ["--limit-bytes", "5"],
    "unknown-flag": _apply_args() + ["--force"],
    "flag-without-value": _apply_args()[:-1],
    "positional-junk": _apply_args() + ["junk"],
    "equals-form": ["--apply", f"--fs-uuid={BAY_UUID}", "--mode", "full"],
}


@posix_only
@pytest.mark.parametrize("args", list(_BAD_APPLY_ARGS.values()), ids=list(_BAD_APPLY_ARGS))
def test_apply_rejects_junk_arguments_before_running_anything(tmp_path, args):
    w = _make_world(tmp_path)
    before = _snapshot(w)
    proc = _run_writer(w, *args)
    _refused(proc, "bad_request")
    assert _snapshot(w) == before
    assert _calls(w) == [], "validation must happen BEFORE any tool is invoked"
    assert not Path("/tmp/pwned").exists()


@posix_only
@pytest.mark.parametrize("uuid", ["abcdef1", _LONG_UUID_OK, "ABCDEF1-2345", BAY_UUID.upper()])
def test_apply_accepts_the_documented_uuid_shapes_and_then_checks_the_mount(tmp_path, uuid):
    """The regex is 7..36 chars of hex/dash starting with a hex digit; a
    well-formed UUID nobody has mounted is a `not_mounted`, not a `bad_request`."""
    w = _make_world(tmp_path)
    w.unmount_bay()
    _refused(_run_writer(w, *_apply_args(uuid=uuid)), "not_mounted")


@posix_only
@pytest.mark.parametrize("limit", [2 ** 62, FS_BYTES + 1, FS_BYTES * 2])
def test_apply_refuses_a_limit_larger_than_the_filesystem(tmp_path, limit):
    w = _make_world(tmp_path)
    before = _snapshot(w)
    proc = _run_writer(w, *_apply_args(limit=limit))
    _refused(proc, "exceeds_fs")
    assert _snapshot(w) == before
    assert _calls(w, "quota") == [] and _calls(w, "chattr") == []


@posix_only
def test_apply_accepts_a_limit_equal_to_the_filesystem_size(tmp_path):
    w = _make_world(tmp_path)
    assert _ok(_run_writer(w, *_apply_args(limit=FS_BYTES)))["limitBytes"] == FS_BYTES


@posix_only
def test_apply_below_used_boundary_is_ceil_of_used_times_1_1(tmp_path):
    """A slice may never be set below used x 1.1 (Frigate would hit ENOSPC)."""
    used = 1_000_000_000
    w = _make_world(tmp_path)
    w.nvr.mkdir(mode=0o700)
    too_small = _run_writer(w, *_apply_args(limit=1_100_000_000 - 1),
                            extra_env={"FAKE_QUOTA_USED": str(used)})
    _refused(too_small, "below_used")
    assert _calls(w, "quota", ) == [f"quota get {BAY_DEV} {PROJID}"], "only the usage read, no set"
    assert not w.storage_json.exists() and not w.root_state.exists()
    assert w.env_file.read_text(encoding="utf-8") == "JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=nvrdata\n"

    just_enough = _run_writer(w, *_apply_args(limit=1_100_000_000),
                              extra_env={"FAKE_QUOTA_USED": str(used)})
    assert _ok(just_enough)["limitBytes"] == 1_100_000_000


@posix_only
def test_apply_below_used_does_not_apply_in_full_mode(tmp_path):
    w = _make_world(tmp_path)
    body = _ok(_run_writer(w, *_apply_args(limit=None, mode="full"),
                           extra_env={"FAKE_QUOTA_USED": str(FS_BYTES - 1)}))
    assert body["limitBytes"] == FS_BYTES


@posix_only
def test_apply_still_applies_when_current_usage_cannot_be_read(tmp_path):
    """No usage reading is not a reason to refuse a first-time apply (the
    read-back verification after the set still has to pass)."""
    w = _make_world(tmp_path)
    body = _ok(_run_writer(w, *_apply_args(), extra_env={"FAKE_QUOTA_GET_FAIL_FIRST": "1"}))
    assert body["limitBytes"] == LIMIT


_MOUNT_REFUSALS = {
    "not_mounted": ("not_mounted", lambda w: w.unmount_bay()),
    "outside-the-base": ("bad_mount", lambda w: w.bay(target="/srv/bay")),
    "nested-below-a-tail": ("bad_mount", lambda w: w.bay(target=str(w.base / "a" / "b"))),
    "the-base-itself": ("bad_mount", lambda w: w.bay(target=str(w.base))),
    "dot-tail": ("bad_mount", lambda w: w.bay(target=str(w.base / ".hidden"))),
    "tail-with-a-space": ("bad_mount", lambda w: w.bay(target=str(w.base / "a b"))),
    "read-only": ("read_only", lambda w: w.bay(options="ro,nosuid,nodev,noatime,prjquota")),
    "neither-rw-nor-ro": ("read_only", lambda w: w.bay(options="nosuid,nodev,prjquota")),
    "shares-the-os-disk": ("os_disk", lambda w: w.chains.__setitem__(
        BAY_DEV, [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")])),
    "not-encrypted": ("not_encrypted", lambda w: (
        w.bay(source="/dev/sdb1"),
        w.chains.__setitem__("/dev/sdb1", [("sdb1", "part"), ("sdb", "disk")]))),
    "not-ext4": ("quota_unsupported", lambda w: w.bay(fstype="xfs")),
    "no-prjquota": ("quota_unsupported", lambda w: w.bay(options="rw,nosuid,nodev,noatime")),
    "only-usrquota": ("quota_unsupported", lambda w: w.bay(options="rw,usrquota,grpquota")),
    "prjquota-lookalike": ("quota_unsupported", lambda w: w.bay(options="rw,noprjquota")),
}


@posix_only
@pytest.mark.parametrize("code, mutate", list(_MOUNT_REFUSALS.values()), ids=list(_MOUNT_REFUSALS))
def test_apply_refuses_an_unsuitable_mount_and_writes_nothing(tmp_path, code, mutate):
    w = _make_world(tmp_path)
    mutate(w)
    before = _snapshot(w)
    proc = _run_writer(w, *_apply_args())
    _untouched(w, before, proc, code)
    assert not w.nvr.exists(), "no <mount>/nvr may be created on a refused drive"


@posix_only
def test_apply_refusal_messages_carry_no_paths_or_labels(tmp_path):
    """Messages travel up to the owner-facing layer (WARP-3466: drive labels,
    mount paths and device paths can carry text from a plugged-in disk)."""
    w = _make_world(tmp_path)
    w.bay(options="ro,prjquota")
    body = _refused(_run_writer(w, *_apply_args()), "read_only")
    assert str(w.mount) not in body["message"] and BAY_TAIL not in body["message"]
    assert BAY_DEV not in body["message"] and "droplet-bay" not in body["message"]


@posix_only
def test_apply_checks_run_in_the_documented_order(tmp_path):
    """read_only, then os_disk, then not_encrypted, then quota_unsupported —
    the FIRST failure wins."""
    def build(name, *, ro, os_disk, plain, no_quota):
        w = _make_world(tmp_path / name)
        w.bay(options=("ro" if ro else "rw") + ",nosuid" + ("" if no_quota else ",prjquota"))
        if os_disk or plain:
            dev, disk = ("/dev/nvme0n1p4", "nvme0n1") if os_disk else ("/dev/sdb1", "sdb")
            w.bay(source=dev)
            w.chains[dev] = [(dev.rsplit("/", 1)[1], "part"), (disk, "disk")]   # no crypt layer
        return w

    cases = [
        ("all-four", dict(ro=True, os_disk=True, plain=True, no_quota=True), "read_only"),
        ("three", dict(ro=False, os_disk=True, plain=True, no_quota=True), "os_disk"),
        ("two", dict(ro=False, os_disk=False, plain=True, no_quota=True), "not_encrypted"),
    ]
    for name, flags, code in cases:
        _refused(_run_writer(build(name, **flags), *_apply_args()), code)
    # the last gate on its own: encrypted, foreign disk, writable, but no prjquota
    w = _make_world(tmp_path / "one")
    w.bay(options="rw,nosuid")
    _refused(_run_writer(w, *_apply_args()), "quota_unsupported")


# --- OS-disk refusal by PHYSICAL ANCESTRY ------------------------------------

@posix_only
def test_apply_refuses_a_bay_that_shares_a_physical_disk_with_root_through_dm_crypt(tmp_path):
    """Device NAMES differ (a LUKS mapper vs the root LVM), but both stack on
    nvme0n1 — only the lsblk -s ancestry shows it."""
    w = _make_world(tmp_path)
    w.bay(source="/dev/mapper/droplet-bay-shared")
    w.chains["/dev/mapper/droplet-bay-shared"] = [
        ("droplet-bay-shared", "crypt"), ("nvme0n1p5", "part"), ("nvme0n1", "disk")]
    w.mounts[0] = ("/", "/dev/mapper/vg0-root", "ext4", "rw,relatime", ROOT_UUID)
    w.chains["/dev/mapper/vg0-root"] = [("vg0-root", "lvm"), ("nvme0n1p3", "part"), ("nvme0n1", "disk")]
    before = _snapshot(w)
    body = _untouched(w, before, _run_writer(w, *_apply_args()), "os_disk")
    assert "operating system" in body["message"]


@posix_only
def test_apply_refuses_a_bay_that_shares_a_disk_with_slash_data_only(tmp_path):
    w = _make_world(tmp_path)
    # /data lives on its own disk sda; the bay is a partition of that same disk
    w.mounts[2] = ("/data", "/dev/mapper/droplet-data-crypt", "ext4", "rw,relatime", DATA_UUID)
    w.chains["/dev/mapper/droplet-data-crypt"] = [
        ("droplet-data-crypt", "crypt"), ("sda1", "part"), ("sda", "disk")]
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("sda2", "part"), ("sda", "disk")]
    before = _snapshot(w)
    _untouched(w, before, _run_writer(w, *_apply_args()), "os_disk")


@posix_only
def test_apply_refuses_a_bay_that_shares_a_disk_with_the_boot_partition(tmp_path):
    w = _make_world(tmp_path)
    w.mounts[1] = ("/boot/efi", "/dev/sdc1", "vfat", "rw", "ABCD-1234")
    w.chains["/dev/sdc1"] = [("sdc1", "part"), ("sdc", "disk")]
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("sdc2", "part"), ("sdc", "disk")]
    before = _snapshot(w)
    _untouched(w, before, _run_writer(w, *_apply_args()), "os_disk")


@posix_only
def test_apply_os_disk_override_hook_names_the_os_disks(tmp_path):
    w = _make_world(tmp_path)
    before = _snapshot(w)
    proc = _run_writer(w, *_apply_args(), extra_env={"DROPLET_NVR_MEDIA_OSDISK": "sdb"})
    _untouched(w, before, proc, "os_disk")
    # naming only an unrelated disk accepts the bay again
    _ok(_run_writer(w, *_apply_args(), extra_env={"DROPLET_NVR_MEDIA_OSDISK": "nvme0n1 sdz"}))


@posix_only
def test_apply_fails_closed_when_the_os_disk_cannot_be_determined(tmp_path):
    """If lsblk cannot say which disk holds the OS, 'not the OS disk' is
    unprovable — refuse rather than guess."""
    w = _make_world(tmp_path)
    for dev in ("/dev/nvme0n1p2", "/dev/nvme0n1p1", "/dev/mapper/droplet-data-crypt"):
        w.chains.pop(dev)
    before = _snapshot(w)
    body = _untouched(w, before, _run_writer(w, *_apply_args()), "os_disk")
    assert "determine" in body["message"]


@posix_only
def test_apply_accepts_a_bay_on_a_different_physical_disk(tmp_path):
    w = _make_world(tmp_path)
    assert _ok(_run_writer(w, *_apply_args()))["mountPath"] == str(w.mount)


@posix_only
def test_apply_accepts_a_bay_over_an_md_array_of_two_foreign_disks(tmp_path):
    w = _make_world(tmp_path)
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("md0", "raid1"),
                         ("sdb1", "part"), ("sdb", "disk"), ("sdc1", "part"), ("sdc", "disk")]
    _ok(_run_writer(w, *_apply_args()))


@posix_only
def test_apply_refuses_an_md_bay_when_one_member_is_the_os_disk(tmp_path):
    w = _make_world(tmp_path)
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("md0", "raid1"),
                         ("sdb1", "part"), ("sdb", "disk"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
    before = _snapshot(w)
    _untouched(w, before, _run_writer(w, *_apply_args()), "os_disk")


@posix_only
def test_apply_first_matching_mount_line_wins_over_a_foreign_bind_peer(tmp_path):
    """The same filesystem can appear twice (a bind peer outside the mount
    area); only a /mnt/droplet/<tail> line counts."""
    w = _make_world(tmp_path)
    w.mounts.insert(0, ("/var/lib/docker/peer/mnt", BAY_DEV, "ext4", "rw,prjquota", BAY_UUID))
    assert _ok(_run_writer(w, *_apply_args()))["mountPath"] == str(w.mount)


# --- quota / chattr failures ---------------------------------------------------

@posix_only
def test_apply_chattr_failure_is_quota_failed_and_records_nothing(tmp_path):
    w = _make_world(tmp_path)
    env_before = w.env_file.read_bytes()
    proc = _run_writer(w, *_apply_args(), extra_env={"FAKE_CHATTR_RC": "1"})
    _refused(proc, "quota_failed")
    assert [c for c in _calls(w, "quota") if c.startswith("quota set")] == [], \
        "must not set a limit on a dir that has no project id"
    assert w.env_file.read_bytes() == env_before
    assert not w.storage_json.exists() and not w.root_state.exists()


@posix_only
def test_apply_quota_tool_failure_is_quota_failed_and_records_nothing(tmp_path):
    w = _make_world(tmp_path)
    env_before = w.env_file.read_bytes()
    proc = _run_writer(w, *_apply_args(), extra_env={"FAKE_QUOTA_SET_RC": "1"})
    body = _refused(proc, "quota_failed")
    assert "project quota not enabled on this filesystem" in body["message"]
    assert w.env_file.read_bytes() == env_before
    assert not w.storage_json.exists() and not w.root_state.exists()


@posix_only
def test_apply_with_the_quota_tool_missing_is_quota_failed(tmp_path):
    w = _make_world(tmp_path)
    proc = _run_writer(w, *_apply_args(),
                       extra_env={"DROPLET_NVR_QUOTA_TOOL": str(tmp_path / "no-such-tool")})
    _refused(proc, "quota_failed")
    assert not w.storage_json.exists()


# --- AMENDMENT: post-set read-back verification (step 6b) -------------------
# This dev host's kernel cannot exercise ext4 project quotas (WSL2: no
# CONFIG_QUOTA), so a silently-wrong quotactl struct would otherwise only show
# up on the real box. After `set` the writer reads the quota back AND checks
# that the cap is what Frigate will see through the bind mount (statfs of
# <mount>/nvr) — BEFORE it writes .env or any state file.

def _tolerance(limit: int) -> int:
    return max(MIB, limit // 100)


@posix_only
@pytest.mark.parametrize("env, why", [
    ({"FAKE_QUOTA_GET_OUT": '{"hardBytes":123,"softBytes":0,"usedBytes":0}'}, "reads back a different limit"),
    ({"FAKE_QUOTA_GET_OUT": '{"hardBytes":%d,"softBytes":0,"usedBytes":0}' % (LIMIT + 1024)},
     "reads back one KiB too many"),
    ({"FAKE_QUOTA_GET_OUT": '{"hardBytes":%d,"softBytes":0,"usedBytes":0}' % (LIMIT - 1024)},
     "reads back one KiB too few"),
    ({"FAKE_QUOTA_GET_OUT": '{"hardBytes":0,"softBytes":0,"usedBytes":0}'}, "reads back no limit at all"),
    ({"FAKE_QUOTA_GET_OUT": "not json"}, "reads back garbage"),
    ({"FAKE_QUOTA_GET_OUT": '{"softBytes":0,"usedBytes":0}'}, "reads back no hardBytes"),
    ({"FAKE_QUOTA_GET_RC": "1"}, "cannot read the quota back"),
    ({"FAKE_QUOTA_IGNORED": "1"}, "the cap is invisible through statfs (kernel ignores it)"),
])
def test_apply_verifies_the_quota_before_touching_env_or_state(tmp_path, env, why):
    w = _make_world(tmp_path)
    env_before = w.env_file.read_bytes()
    proc = _run_writer(w, *_apply_args(), extra_env=env)
    body = _refused(proc, "quota_failed")
    assert re.search(r"read back|visible|readable", body["message"]), (why, body["message"])
    assert "set" in body["message"], "the message says the quota WAS set"
    assert w.env_file.read_bytes() == env_before, why
    assert not w.storage_json.exists(), why
    assert not w.root_state.exists() and not w.migration_json.exists(), why
    assert _calls(w, "docker") == []


@posix_only
def test_apply_verification_rounds_the_expected_limit_up_to_whole_kib(tmp_path):
    """The tool rounds UP to whole KiB; a read-back of the raw limit therefore
    means the tool did not do what was asked."""
    limit = 1_000_000_001                       # not a multiple of 1024
    w = _make_world(tmp_path)
    expected_hard = -(-limit // 1024) * 1024    # ceil to KiB
    assert expected_hard == 1_000_000_512
    # the honest fake kernel rounds up -> passes
    assert _ok(_run_writer(w, *_apply_args(limit=limit)))["limitBytes"] == limit
    # a "kernel" that stored the raw byte count (no rounding) is rejected
    w2 = _make_world(tmp_path / "raw")
    proc = _run_writer(w2, *_apply_args(limit=limit), extra_env={
        "FAKE_QUOTA_GET_OUT": '{"hardBytes":%d,"softBytes":0,"usedBytes":0}' % limit})
    _refused(proc, "quota_failed")
    # ... and exactly the rounded value is accepted
    w3 = _make_world(tmp_path / "rounded")
    proc = _run_writer(w3, *_apply_args(limit=limit), extra_env={
        "FAKE_QUOTA_GET_OUT": '{"hardBytes":%d,"softBytes":0,"usedBytes":0}' % expected_hard})
    _ok(proc)


@posix_only
def test_apply_verification_needs_the_statfs_of_the_recordings_dir(tmp_path):
    w = _make_world(tmp_path)
    env_before = w.env_file.read_bytes()
    proc = _run_writer(w, *_apply_args(), extra_env={"FAKE_STATFS_FAIL_PATH": str(w.nvr)})
    _refused(proc, "quota_failed")
    assert w.env_file.read_bytes() == env_before and not w.storage_json.exists()


@posix_only
def test_apply_verification_tolerance_is_one_percent_with_a_one_mib_floor(tmp_path):
    """The visible cap must be within max(1 MiB, 1% of the limit) of the
    request: the kernel counts whole filesystem blocks, so exact equality
    would refuse every healthy slice."""
    tol = _tolerance(LIMIT)
    assert tol == LIMIT // 100 > MIB
    ok_hi = (LIMIT + tol) // FRSIZE * FRSIZE
    bad_hi = ok_hi + 2 * FRSIZE
    ok_lo = -(-(LIMIT - tol) // FRSIZE) * FRSIZE
    bad_lo = (LIMIT - tol) // FRSIZE * FRSIZE - FRSIZE
    for total, accepted in ((ok_hi, True), (bad_hi, False), (ok_lo, True), (bad_lo, False)):
        w = _make_world(tmp_path / f"total-{total}")
        proc = _run_writer(w, *_apply_args(), extra_env={"FAKE_NVR_TOTAL": str(total)})
        if accepted:
            _ok(proc)
        else:
            _refused(proc, "quota_failed")
            assert not w.storage_json.exists()

    small = 8 * MIB                              # 1% would be < 1 MiB: the floor applies
    assert _tolerance(small) == MIB
    for total, accepted in ((small + MIB, True), (small + MIB + 2 * FRSIZE, False)):
        w = _make_world(tmp_path / f"small-{total}")
        proc = _run_writer(w, *_apply_args(limit=small), extra_env={"FAKE_NVR_TOTAL": str(total)})
        if accepted:
            _ok(proc)
        else:
            _refused(proc, "quota_failed")


@posix_only
def test_apply_verification_also_covers_full_mode(tmp_path):
    w = _make_world(tmp_path)
    proc = _run_writer(w, *_apply_args(limit=None, mode="full"),
                       extra_env={"FAKE_NVR_TOTAL": str(FS_BYTES // 2)})
    # the dir reports half the filesystem although the limit is the whole of it
    _refused(proc, "quota_failed")
    w2 = _make_world(tmp_path / "ok")
    _ok(_run_writer(w2, *_apply_args(limit=None, mode="full")))


# --------------------------------------------------------------------------
# --resize: quota only — no docker, no .env, no frigate restart
# --------------------------------------------------------------------------

def _applied_world(tmp_path: Path, **kw) -> _World:
    """A world with an ACTIVE slice (--apply + the migration flip that makes the .env
    name it), with the call log cleared so a test sees only what the next command invokes."""
    w = _make_world(tmp_path)
    _applied_active(w, **kw)
    w.calls.write_text("", encoding="utf-8")
    return w


@posix_only
def test_resize_changes_only_the_quota(tmp_path):
    w = _applied_world(tmp_path)
    env_before = w.env_file.read_bytes()
    migration_before = w.migration_json.read_bytes()

    proc = _run_writer(w, "--resize", str(20 * GIB), extra_env={"FAKE_QUOTA_USED": "123456789"})

    assert _ok(proc) == {"ok": True, "operation": "resize", "limitBytes": 20 * GIB,
                         "usedBytes": 123456789, "projectId": PROJID}
    assert proc.stderr == ""
    assert f"quota set {BAY_DEV} {PROJID} {20 * GIB}" in _calls(w, "quota")
    assert _calls(w, "chattr") == [] and _calls(w, "docker") == []
    assert w.env_file.read_bytes() == env_before
    assert w.migration_json.read_bytes() == migration_before
    rec = json.loads(w.storage_json.read_text(encoding="utf-8"))
    assert (rec["fsUuid"], rec["source"], rec["mountPath"], rec["projectId"],
            rec["limitBytes"], rec["mode"]) == (
        BAY_UUID, str(w.nvr), str(w.mount), PROJID, 20 * GIB, "reserved")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", rec["appliedAt"])
    assert stat.S_IMODE(w.storage_json.stat().st_mode) == 0o600


@posix_only
def test_resize_to_the_filesystem_size_records_full_mode(tmp_path):
    w = _applied_world(tmp_path)
    _ok(_run_writer(w, "--resize", str(FS_BYTES)))
    assert json.loads(w.storage_json.read_text(encoding="utf-8"))["mode"] == "full"
    # ... and back down again
    _ok(_run_writer(w, "--resize", str(LIMIT)))
    assert json.loads(w.storage_json.read_text(encoding="utf-8"))["mode"] == "reserved"


@posix_only
def test_resize_can_shrink_when_the_new_limit_still_clears_usage(tmp_path):
    w = _applied_world(tmp_path)
    body = _ok(_run_writer(w, "--resize", str(5 * GIB), extra_env={"FAKE_QUOTA_USED": str(1 * GIB)}))
    assert body["limitBytes"] == 5 * GIB and body["usedBytes"] == 1 * GIB


@posix_only
@pytest.mark.parametrize("case, setup, code", [
    ("no-record", lambda w: None, "no_allocation"),
    ("corrupt-record", lambda w: w.write_storage_json(raw="not json"), "no_allocation"),
    ("junk-uuid-in-record", lambda w: w.write_storage_json(fsUuid="../../etc"), "no_allocation"),
    ("empty-record", lambda w: w.write_storage_json(raw=""), "no_allocation"),
])
def test_resize_without_a_usable_record_is_no_allocation(tmp_path, case, setup, code):
    w = _make_world(tmp_path)
    setup(w)
    before = _snapshot(w)
    proc = _run_writer(w, "--resize", str(LIMIT))
    _refused(proc, code)
    assert _snapshot(w) == before
    assert _calls(w, "quota") == [] and _calls(w, "chattr") == [] and _calls(w, "docker") == []


@posix_only
def test_resize_with_a_stale_record_is_no_allocation(tmp_path):
    """The record is only trusted while .env still points at that drive's nvr/."""
    w = _applied_world(tmp_path)
    w.write_env("JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=nvrdata\n")
    before = _snapshot(w)
    _refused(_run_writer(w, "--resize", str(20 * GIB)), "no_allocation")
    assert _snapshot(w) == before and _calls(w, "quota") == []


@posix_only
def test_resize_when_the_recordings_dir_is_gone_is_no_allocation(tmp_path):
    w = _applied_world(tmp_path)
    shutil.rmtree(w.nvr)
    before = _snapshot(w)
    _refused(_run_writer(w, "--resize", str(20 * GIB)), "no_allocation")
    assert _snapshot(w) == before and _calls(w, "quota") == []


@posix_only
def test_resize_when_the_drive_is_unmounted_is_not_mounted(tmp_path):
    w = _applied_world(tmp_path)
    w.unmount_bay()
    before = _snapshot(w)
    _refused(_run_writer(w, "--resize", str(20 * GIB)), "not_mounted")
    assert _snapshot(w) == before and _calls(w, "quota") == []


_BAD_RESIZE_ARGS = {
    "no-value": ["--resize"],
    "text": ["--resize", "abc"],
    "zero": ["--resize", "0"],
    "negative": ["--resize", "-5"],
    "float": ["--resize", "1.5"],
    "hex": ["--resize", "0x10"],
    "leading-zero": ["--resize", "0100"],
    "plus": ["--resize", "+5"],
    "above-2-62": ["--resize", str(2 ** 62 + 1)],
    "twenty-digits": ["--resize", "1" * 20],
    "empty": ["--resize", ""],
    "two-values": ["--resize", "5", "6"],
    "flag-as-value": ["--resize", "--limit-bytes", "5"],
    "extra-flag": ["--resize", "5", "--force"],
}


@posix_only
@pytest.mark.parametrize("args", list(_BAD_RESIZE_ARGS.values()), ids=list(_BAD_RESIZE_ARGS))
def test_resize_rejects_junk_arguments_before_running_anything(tmp_path, args):
    w = _applied_world(tmp_path)
    before = _snapshot(w)
    _refused(_run_writer(w, *args), "bad_request")
    assert _snapshot(w) == before
    assert _calls(w) == []


@posix_only
@pytest.mark.parametrize("limit", [2 ** 62, FS_BYTES + 1, FS_BYTES * 3])
def test_resize_refuses_a_limit_larger_than_the_filesystem(tmp_path, limit):
    w = _applied_world(tmp_path)
    before = _snapshot(w)
    _refused(_run_writer(w, "--resize", str(limit)), "exceeds_fs")
    assert _snapshot(w) == before and _calls(w, "quota", ) in ([], [f"quota get {BAY_DEV} {PROJID}"])
    assert not [c for c in _calls(w, "quota") if c.startswith("quota set")]


@posix_only
def test_resize_accepts_exactly_the_filesystem_size(tmp_path):
    w = _applied_world(tmp_path)
    assert _ok(_run_writer(w, "--resize", str(FS_BYTES)))["limitBytes"] == FS_BYTES


@posix_only
def test_resize_below_used_boundary_is_ceil_of_used_times_1_1(tmp_path):
    used = 5 * GIB
    floor = (used * 11 + 9) // 10               # ceil(used x 1.1)
    w = _applied_world(tmp_path)
    storage_before = w.storage_json.read_bytes()
    _refused(_run_writer(w, "--resize", str(floor - 1), extra_env={"FAKE_QUOTA_USED": str(used)}),
             "below_used")
    assert w.storage_json.read_bytes() == storage_before
    assert not [c for c in _calls(w, "quota") if c.startswith("quota set")]
    body = _ok(_run_writer(w, "--resize", str(floor), extra_env={"FAKE_QUOTA_USED": str(used)}))
    assert body["limitBytes"] == floor and body["usedBytes"] == used


@posix_only
def test_resize_reads_usage_from_statfs_when_the_quota_read_fails(tmp_path):
    used = 5 * GIB
    w = _applied_world(tmp_path)
    (w.fake / "quota.gets").unlink()            # only the FIRST read of this run fails
    storage_before = w.storage_json.read_bytes()
    proc = _run_writer(w, "--resize", str(1 * GIB), extra_env={
        "FAKE_QUOTA_GET_FAIL_FIRST": "1", "FAKE_QUOTA_USED": str(used)})
    _refused(proc, "below_used")                 # the statfs fallback saw 5 GiB in use
    assert w.storage_json.read_bytes() == storage_before

    (w.fake / "quota.gets").unlink()
    body = _ok(_run_writer(w, "--resize", str(6 * GIB), extra_env={
        "FAKE_QUOTA_GET_FAIL_FIRST": "1", "FAKE_QUOTA_USED": str(used)}))
    assert body["usedBytes"] == used


@posix_only
def test_resize_refuses_when_usage_cannot_be_determined_at_all(tmp_path):
    """Cutting a quota without knowing what is in it risks ENOSPC for Frigate."""
    w = _applied_world(tmp_path)
    storage_before = w.storage_json.read_bytes()
    proc = _run_writer(w, "--resize", str(20 * GIB), extra_env={
        "FAKE_QUOTA_GET_RC": "1", "FAKE_STATFS_FAIL_PATH": str(w.nvr)})
    body = _refused(proc, "quota_failed")
    assert "usage" in body["message"]
    assert w.storage_json.read_bytes() == storage_before
    assert not [c for c in _calls(w, "quota") if c.startswith("quota set")]


_RESIZE_MOUNT_BREAKS = {
    "read_only": lambda w: w.bay(options="ro,nosuid,nodev,noatime,prjquota"),
    "os_disk": lambda w: w.chains.__setitem__(
        BAY_DEV, [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]),
    "not_encrypted": lambda w: (
        w.bay(source="/dev/sdb1"), w.chains.__setitem__("/dev/sdb1", [("sdb1", "part"), ("sdb", "disk")])),
    "quota_unsupported": lambda w: w.bay(options="rw,nosuid,nodev,noatime"),
}


@posix_only
@pytest.mark.parametrize("code", list(_RESIZE_MOUNT_BREAKS))
def test_resize_revalidates_the_mount_before_touching_the_quota(tmp_path, code):
    w = _applied_world(tmp_path)
    _RESIZE_MOUNT_BREAKS[code](w)
    before = _snapshot(w)
    _refused(_run_writer(w, "--resize", str(20 * GIB)), code)
    assert _snapshot(w) == before
    assert _calls(w, "quota") == [] and _calls(w, "chattr") == []


@posix_only
@pytest.mark.parametrize("env", [
    {"FAKE_QUOTA_GET_OUT": '{"hardBytes":123,"softBytes":0,"usedBytes":0}'},
    {"FAKE_QUOTA_GET_OUT": "not json"},
    {"FAKE_QUOTA_IGNORED": "1"},
], ids=["mismatching-hard-limit", "garbage-read-back", "cap-invisible-through-statfs"])
def test_resize_verifies_the_quota_before_rewriting_the_record(tmp_path, env):
    w = _applied_world(tmp_path)
    storage_before = w.storage_json.read_bytes()
    env_before = w.env_file.read_bytes()
    body = _refused(_run_writer(w, "--resize", str(20 * GIB), extra_env=env), "quota_failed")
    assert re.search(r"read back|visible|readable", body["message"])
    assert w.storage_json.read_bytes() == storage_before, "the record must still describe the old limit"
    assert w.env_file.read_bytes() == env_before


@posix_only
def test_resize_quota_tool_failure_is_quota_failed(tmp_path):
    w = _applied_world(tmp_path)
    storage_before = w.storage_json.read_bytes()
    _refused(_run_writer(w, "--resize", str(20 * GIB), extra_env={"FAKE_QUOTA_SET_RC": "1"}),
             "quota_failed")
    assert w.storage_json.read_bytes() == storage_before


@posix_only
def test_resize_state_file_write_is_hardened(tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("keep", encoding="utf-8")
    w = _applied_world(tmp_path)
    (w.state_dir / "storage.json.tmp").symlink_to(victim)
    _ok(_run_writer(w, "--resize", str(20 * GIB)))
    assert victim.read_text(encoding="utf-8") == "keep"
    assert w.storage_json.is_file() and not w.storage_json.is_symlink()


@posix_only
def test_resize_after_a_status_round_trip_reports_the_new_cap(tmp_path):
    """--apply, --resize and --status agree through the fake kernel."""
    w = _applied_world(tmp_path)
    assert _status(w)["limitBytes"] == LIMIT
    _ok(_run_writer(w, "--resize", str(20 * GIB)))
    body = _status(w)
    assert body["limitBytes"] == 20 * GIB and body["projectId"] == PROJID
    assert body["mounted"] is True and body["isSystemDisk"] is False


# --------------------------------------------------------------------------
# Legacy positional mode: unchanged — plus ONE small addition (ancestry)
# --------------------------------------------------------------------------

def _run_legacy(w: _World, target, extra_env: dict | None = None):
    w.write()
    return subprocess.run([BASH, str(SCRIPT), str(target)], env=w.env(extra_env),
                          capture_output=True, text=True, timeout=60)


# `stat -c %d` is the legacy st_dev guard; these make `/` and the target look
# like different filesystems without a second real device.
_STAT_SPLIT = {"FAKE_STAT_DEV_ROOT": "1", "FAKE_STAT_DEV_OTHER": "2"}


@posix_only
def test_legacy_path_sharing_a_physical_disk_with_the_os_is_refused(tmp_path):
    """The st_dev check passes (a LUKS partition IS a different filesystem from
    /), but both stack on nvme0n1: footage there still fills the OS disk."""
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
    proc = _run_legacy(w, w.nvr, _STAT_SPLIT)
    assert proc.returncode == 1
    assert "OS disk" in proc.stderr and "nvme0n1" in proc.stderr
    assert not w.env_file.exists(), "a refused target must not be written"


@posix_only
def test_legacy_path_on_another_disk_is_still_accepted(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    proc = _run_legacy(w, w.nvr, _STAT_SPLIT)
    assert proc.returncode == 0, proc.stderr
    assert f"NVR_MEDIA_SOURCE={w.nvr}\n" in w.env_file.read_text(encoding="utf-8")


@posix_only
@pytest.mark.parametrize("env", [
    {"FAKE_LSBLK_FAIL": "1"},
    {"FAKE_FINDMNT_FAIL": "1"},
], ids=["lsblk-unusable", "findmnt-unusable"])
def test_legacy_ancestry_only_applies_when_it_is_resolvable(tmp_path, env):
    """Unresolvable ancestry falls back to the st_dev guard alone (as before)."""
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
    proc = _run_legacy(w, w.nvr, {**_STAT_SPLIT, **env})
    assert proc.returncode == 0, proc.stderr


@posix_only
def test_legacy_ancestry_is_skipped_for_a_target_on_an_unknown_device(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    w.bay(source="overlay")                       # no block-device ancestry at all
    proc = _run_legacy(w, w.nvr, _STAT_SPLIT)
    assert proc.returncode == 0, proc.stderr


@posix_only
def test_legacy_simulated_root_dev_keeps_the_host_topology_out_of_it(tmp_path):
    """DROPLET_NVR_MEDIA_ROOT_DEV simulates a box for the unit tests. The real
    block-device topology of whatever machine runs them must not veto that
    simulation — that is what keeps the 23 WARP-2099 tests hermetic on any CI
    runner (whose tmp dir may well share a disk with /)."""
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
    simulated_off_root = str(os.stat(w.nvr).st_dev + 1)
    proc = _run_legacy(w, w.nvr, {"DROPLET_NVR_MEDIA_ROOT_DEV": simulated_off_root})
    assert proc.returncode == 0, proc.stderr


@posix_only
def test_legacy_simulated_root_dev_plus_osdisk_hook_exercises_the_ancestry_guard(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    w.nvr.mkdir()
    simulated_off_root = str(os.stat(w.nvr).st_dev + 1)
    proc = _run_legacy(w, w.nvr, {"DROPLET_NVR_MEDIA_ROOT_DEV": simulated_off_root,
                                  "DROPLET_NVR_MEDIA_OSDISK": "sdb"})
    assert proc.returncode == 1
    assert "OS disk" in proc.stderr and "sdb" in proc.stderr
    assert not w.env_file.exists()


@posix_only
def test_legacy_named_volume_never_consults_the_block_layer(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    proc = _run_legacy(w, "nvrdata")
    assert proc.returncode == 0, proc.stderr
    assert _calls(w, "findmnt") == [] and _calls(w, "lsblk") == []
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in w.env_file.read_text(encoding="utf-8")


@posix_only
def test_legacy_ignores_the_new_modes_configuration(tmp_path):
    """The new hooks are read only by --status/--apply/--resize: a malformed
    DROPLET_NVR_PROJID or mount base must not change legacy behaviour."""
    w = _make_world(tmp_path, env_text=None)
    proc = _run_legacy(w, "nvrdata", {"DROPLET_NVR_PROJID": "abc",
                                      "DROPLET_NVR_MOUNT_BASE": "relative/base",
                                      "DROPLET_NVR_STATE_DIR": "/nonexistent/state"})
    assert proc.returncode == 0, proc.stderr
    assert not w.root_state.exists() and list(w.state_dir.iterdir()) == []


@posix_only
def test_legacy_mode_still_prints_text_not_json(tmp_path):
    w = _make_world(tmp_path, env_text=None)
    proc = _run_legacy(w, "nvrdata")
    assert proc.stdout.startswith("NVR_MEDIA_SOURCE=nvrdata persisted to ")
    with pytest.raises(ValueError):
        json.loads(proc.stdout)


# --------------------------------------------------------------------------
# Mutation checks — the new guards are load-bearing, not decorative
# --------------------------------------------------------------------------

def _mutant(tmp_path: Path, needle: str, replacement: str) -> Path:
    src = SCRIPT.read_text(encoding="utf-8")
    assert src.count(needle) == 1, f"guard shape changed — update this mutation test: {needle!r}"
    mutated = tmp_path / "mutated.sh"
    mutated.write_text(src.replace(needle, replacement), encoding="utf-8", newline="\n")
    return mutated


# A mutant runs from tmp_path, so it cannot find scripts/lib/ from its own
# location — re-anchor it to the real repo (the script honours REPO_ROOT) so the
# canonical _upsert_env_kv writer still resolves.
_ANCHOR = {"REPO_ROOT": str(REPO_ROOT)}


@posix_only
def test_mutation_removing_the_apply_os_disk_guard_lets_a_shared_disk_through(tmp_path):
    def shared(root):
        w = _make_world(root)
        w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
        return w

    real = _run_writer(shared(tmp_path / "real"), *_apply_args())
    _refused(real, "os_disk")
    mutant = _mutant(tmp_path, 'if nvr_disks_intersect "$bay_disks" "$os_disks"; then', "if false; then")
    mut = _run_writer(shared(tmp_path / "mut"), *_apply_args(), script=mutant, extra_env=_ANCHOR)
    assert mut.returncode == 0, (
        "the mutant should ACCEPT a bay on the OS disk; if it still refuses, the physical-ancestry "
        "guard is not what rejects it: " + mut.stdout)


@posix_only
def test_mutation_removing_the_encryption_guard_lets_a_plain_drive_through(tmp_path):
    def plain(root):
        w = _make_world(root)
        w.bay(source="/dev/sdb1")
        w.chains["/dev/sdb1"] = [("sdb1", "part"), ("sdb", "disk")]
        return w

    _refused(_run_writer(plain(tmp_path / "real"), *_apply_args()), "not_encrypted")
    mutant = _mutant(tmp_path, '[ "$ANC_CRYPT" = 1 ] ||', "true ||")
    mut = _run_writer(plain(tmp_path / "mut"), *_apply_args(), script=mutant, extra_env=_ANCHOR)
    assert mut.returncode == 0, mut.stdout


@posix_only
def test_mutation_removing_the_legacy_ancestry_guard_lets_a_shared_disk_through(tmp_path):
    def shared(root):
        w = _make_world(root, env_text=None)
        w.nvr.mkdir()
        w.chains[BAY_DEV] = [("droplet-bay-ab12cd34", "crypt"), ("nvme0n1p4", "part"), ("nvme0n1", "disk")]
        return w

    real = _run_legacy(shared(tmp_path / "real"), tmp_path / "real" / "mnt" / BAY_TAIL / "nvr", _STAT_SPLIT)
    assert real.returncode == 1 and "OS disk" in real.stderr
    mutant = _mutant(tmp_path, 'if nvr_disks_intersect "$target_disks" "$os_disks"; then', "if false; then")
    w = shared(tmp_path / "mut")
    w.write()
    mut = subprocess.run([BASH, str(mutant), str(w.nvr)], env=w.env({**_STAT_SPLIT, **_ANCHOR}),
                         capture_output=True, text=True, timeout=60)
    assert mut.returncode == 0, mut.stderr


@posix_only
def test_mutation_removing_the_read_back_verification_accepts_an_invisible_cap(tmp_path):
    real = _run_writer(_make_world(tmp_path / "real"), *_apply_args(),
                       extra_env={"FAKE_QUOTA_IGNORED": "1"})
    _refused(real, "quota_failed")
    mutant = _mutant(tmp_path, 'if ! nvr_quota_visible "$limit"; then', "if false; then")
    mut = _run_writer(_make_world(tmp_path / "mut"), *_apply_args(), script=mutant,
                      extra_env={**_ANCHOR, "FAKE_QUOTA_IGNORED": "1"})
    assert mut.returncode == 0, (
        "the mutant should ACCEPT a quota the kernel does not enforce: " + mut.stdout)


@posix_only
def test_mutation_removing_the_below_used_guard_allows_cutting_under_usage(tmp_path):
    used = 1_000_000_000
    extra = {"FAKE_QUOTA_USED": str(used)}
    real = _run_writer(_make_world(tmp_path / "real"), *_apply_args(limit=used), extra_env=extra)
    _refused(real, "below_used")
    mutant = _mutant(tmp_path, 'if [ "$limit" -lt "$min_limit" ]; then', "if false; then")
    mut = _run_writer(_make_world(tmp_path / "mut"), *_apply_args(limit=used), script=mutant,
                      extra_env={**_ANCHOR, **extra})
    assert mut.returncode == 0, mut.stdout


@posix_only
def test_script_has_no_polling_loops():
    """Coding standard: no `while true` scheduling loops (bounded loops are fine)."""
    text = SCRIPT.read_text(encoding="utf-8")
    assert not re.search(r"\bwhile\s+(true|:)\s*[;\n]", text)
    assert not re.search(r"\buntil\s+false\b", text)


# --------------------------------------------------------------------------
# WARP-3514 decisions 2026-10-04: --apply PREPARES, only the migration flip
# writes NVR_MEDIA_SOURCE; files/ gets a reservation quota; `full` needs an
# empty files/ and deregisters it from Nextcloud.
# --------------------------------------------------------------------------

FS_SIZE = FS_BLOCKS * FRSIZE
FILES_PROJID = 4097


def _files_quota(slice_bytes: int) -> int:
    return FS_SIZE - slice_bytes - (FS_SIZE + 49) // 50


@posix_only
@pytest.mark.parametrize("env_text", [
    "JWT_SECRET=keepme\nNVR_MEDIA_SOURCE=nvrdata\n",
    "JWT_SECRET=keepme\n",
    None,
])
def test_apply_never_writes_the_env_file(tmp_path, env_text):
    w = _make_world(tmp_path, env_text=env_text)
    before = w.env_file.read_bytes() if w.env_file.exists() else None
    _applied(w)
    after = w.env_file.read_bytes() if w.env_file.exists() else None
    assert after == before, "--apply must not write NVR_MEDIA_SOURCE (only the migration flip does)"


@posix_only
def test_apply_leaves_a_symlinked_env_alone(tmp_path):
    real = tmp_path / "data" / "secrets.env"
    real.parent.mkdir()
    real.write_text("NVR_MEDIA_SOURCE=nvrdata\n", encoding="utf-8")
    w = _make_world(tmp_path, env_text=None)
    w.env_file.symlink_to(real)
    _applied(w)
    assert w.env_file.is_symlink() and real.read_text(encoding="utf-8") == "NVR_MEDIA_SOURCE=nvrdata\n"


@posix_only
def test_apply_reserves_the_files_side_with_its_own_project_quota(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    body = _applied(w)
    q = _files_quota(LIMIT)
    assert body["filesLimitBytes"] == q
    calls = _calls(w)
    assert f"chattr +P -p {FILES_PROJID} {w.files}" in calls
    assert f"quota set {BAY_DEV} {FILES_PROJID} {q}" in calls
    # recordings first, then the files reservation
    assert calls.index(f"quota set {BAY_DEV} {PROJID} {LIMIT}") < calls.index(
        f"quota set {BAY_DEV} {FILES_PROJID} {q}")


@posix_only
def test_apply_without_a_files_dir_has_nothing_to_reserve(tmp_path):
    w = _make_world(tmp_path)
    body = _applied(w)
    assert body["filesLimitBytes"] is None
    assert not any(str(FILES_PROJID) in c for c in _calls(w))


@posix_only
def test_apply_files_reservation_failure_is_quota_failed(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    proc = _run_writer(w, *_apply_args(), extra_env={"FAKE_QUOTA_IGNORED": "1"})
    _refused(proc, "quota_failed")


@posix_only
def test_apply_full_refuses_a_drive_that_still_holds_files_and_changes_nothing(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    (w.files / "holiday.jpg").write_text("x", encoding="utf-8")
    before = _snapshot(w)
    proc = _run_writer(w, *_apply_args(limit=None, mode="full"))
    _refused(proc, "files_not_empty")
    assert _snapshot(w) == before
    assert _calls(w, "chattr") == [] and _calls(w, "quota") == [] and _calls(w, "docker") == []


@posix_only
def test_apply_full_counts_hidden_entries_as_files(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    (w.files / ".hidden").write_text("x", encoding="utf-8")
    _refused(_run_writer(w, *_apply_args(limit=None, mode="full")), "files_not_empty")


@posix_only
def test_apply_full_with_an_empty_files_dir_deregisters_it_from_nextcloud(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    listing = json.dumps([
        {"mount_id": 3, "mount_point": "/Other", "configuration": {"datadir": "/host/other-drive/files"}},
        {"mount_id": 7, "mount_point": "/Bay", "configuration": {"datadir": f"/host/{BAY_TAIL}/files"}},
    ])
    body = _ok(_run_writer(w, *_apply_args(limit=None, mode="full"),
                           extra_env={"FAKE_OCC_LIST": listing}))
    assert body["mode"] == "full" and body["limitBytes"] == FS_SIZE
    assert body["filesDeregistered"] is True and body["filesLimitBytes"] is None
    docker = _calls(w, "docker")
    assert any("php occ files_external:list --output=json" in c for c in docker)
    deletes = [c for c in docker if "files_external:delete" in c]
    assert len(deletes) == 1 and deletes[0].endswith("files_external:delete 7 -y"), \
        "only the entry for THIS drive's files/ may be removed"
    assert not any(str(FILES_PROJID) in c for c in _calls(w, "quota")), "no reservation in full mode"


@posix_only
def test_apply_full_succeeds_when_nextcloud_is_unreachable(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    body = _ok(_run_writer(w, *_apply_args(limit=None, mode="full")))   # docker stub exits 99
    assert body["ok"] is True and body["filesDeregistered"] is False


@posix_only
def test_resize_re_reserves_the_files_side(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    _applied_active(w)
    new_limit = 20 * GIB
    body = _ok(_run_writer(w, "--resize", str(new_limit)))
    assert body["limitBytes"] == new_limit
    q = _files_quota(new_limit)
    assert f"quota set {BAY_DEV} {FILES_PROJID} {q}" in _calls(w)


@posix_only
def test_resize_to_full_needs_an_empty_files_dir(tmp_path):
    w = _make_world(tmp_path)
    w.files.mkdir()
    _applied_active(w)
    (w.files / "doc.txt").write_text("x", encoding="utf-8")
    proc = _run_writer(w, "--resize", str(FS_SIZE))
    _refused(proc, "files_not_empty")
    assert w.nvr.exists() and json.loads(w.storage_json.read_text(encoding="utf-8"))["limitBytes"] == LIMIT


@posix_only
def test_a_configured_files_project_id_must_differ_from_the_recordings_one(tmp_path):
    w = _make_world(tmp_path)
    proc = _run_writer(w, *_apply_args(), extra_env={"DROPLET_NVR_FILES_PROJID": str(PROJID)})
    _refused(proc, "internal")
