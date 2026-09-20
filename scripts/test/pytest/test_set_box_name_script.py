"""Hermetic test for the box-name write-back host script (WARP-988).

scripts/host/droplet-set-box-name.sh is the actual host-mutation layer for the
wizard's "name your box" step (WARP-979): the device-bridge's auth-gated POST
/host/box-name execs it to persist DROPLET_BOX_NAME=<slug> into the repo .env,
so the next orchestrator boot reads the chosen name and tls-issuance sends it
to HQ as `requested_name`. Deliberately NO DNS legs — HQ owns the name's DNS.

Its VALIDATION is the unit under test: the orchestrator and the bridge both
validate already, but the script validates a THIRD time (defence in depth —
the value is interpolated into .env). It must reject anything that isn't a
lowercase slug of [a-z0-9-], 3-40 chars, no leading/trailing/double hyphen,
and never the `d-<16 hex>` opaque per-device lookalike — BEFORE writing
anything. The upsert must be idempotent (a second identical write yields a
byte-identical env file) and replace-in-place (via the canonical _upsert_env_kv, other keys survive).

We drive it via subprocess. The env-file path is redirected to a tmp file via
DROPLET_BOX_NAME_ENV_FILE so we never touch a real .env. Skipped automatically
if a POSIX `bash` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-set-box-name.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")

_GOOD_NAME = "warp-lab-hq"


def _run(name: str | None, env_file: Path, extra_env: dict | None = None):
    env = dict(os.environ)
    env.update({
        # Redirect the .env write away from any real repo .env.
        "DROPLET_BOX_NAME_ENV_FILE": str(env_file),
    })
    if extra_env:
        env.update(extra_env)
    argv = [BASH, str(SCRIPT)]
    if name is not None:
        argv.append(name)
    return subprocess.run(
        argv, env=env, capture_output=True, text=True, timeout=30,
    )


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_happy_path_appends_box_name(tmp_path):
    env_file = tmp_path / ".env"
    proc = _run(_GOOD_NAME, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"DROPLET_BOX_NAME={_GOOD_NAME}\n" in body
    assert "persisted" in proc.stdout


def test_creates_env_file_when_missing(tmp_path):
    # A brand-new box has no .env yet — the script must create it rather than
    # fail, so the very first name choice still lands.
    env_file = tmp_path / "fresh" / ".env"
    env_file.parent.mkdir()
    proc = _run(_GOOD_NAME, env_file)
    assert proc.returncode == 0, proc.stderr
    assert env_file.exists()
    assert f"DROPLET_BOX_NAME={_GOOD_NAME}" in env_file.read_text(encoding="utf-8")


def test_upsert_is_idempotent(tmp_path):
    # Writing the same name twice yields a byte-identical env file — no
    # duplicated DROPLET_BOX_NAME lines, no churn.
    env_file = tmp_path / ".env"
    p1 = _run(_GOOD_NAME, env_file)
    assert p1.returncode == 0, p1.stderr
    first = env_file.read_text(encoding="utf-8")
    p2 = _run(_GOOD_NAME, env_file)
    assert p2.returncode == 0, p2.stderr
    second = env_file.read_text(encoding="utf-8")
    assert first == second
    assert second.count("DROPLET_BOX_NAME=") == 1


def test_upsert_replaces_in_place_preserving_other_keys(tmp_path):
    # An existing .env with unrelated keys keeps them; only the
    # DROPLET_BOX_NAME line changes (a rename must not clobber secrets).
    env_file = tmp_path / ".env"
    env_file.write_text(
        "POSTGRES_PASSWORD=keepme\n"
        "DROPLET_BOX_NAME=old-name\n"
        "DROPLET_PUBLIC_FQDN=d-0123456789abcdef.devices.warp-lab.ai\n",
        encoding="utf-8",
    )
    proc = _run("new-name", env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_BOX_NAME=new-name" in body
    assert "old-name" not in body
    assert "POSTGRES_PASSWORD=keepme" in body
    assert "DROPLET_PUBLIC_FQDN=d-0123456789abcdef.devices.warp-lab.ai" in body
    assert body.count("DROPLET_BOX_NAME=") == 1


def test_upsert_uncomments_a_commented_line(tmp_path):
    # A commented-out placeholder (# DROPLET_BOX_NAME=) is replaced in place,
    # not duplicated at the end of the file.
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# DROPLET_BOX_NAME=\nOTHER=1\n",
        encoding="utf-8",
    )
    proc = _run(_GOOD_NAME, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"DROPLET_BOX_NAME={_GOOD_NAME}" in body
    assert "OTHER=1" in body
    assert body.count("DROPLET_BOX_NAME=") == 1


# --- Validation: reject BEFORE writing ---------------------------------------

@pytest.mark.parametrize("junk", [
    "ab",                               # too short (< 3)
    "a" * 41,                           # too long (> 40)
    "not a slug",                       # whitespace
    "Warp-Lab",                         # uppercase
    "warp.lab",                         # dots — a slug, not an fqdn
    "-warp-lab",                        # leading hyphen
    "warp-lab-",                        # trailing hyphen
    "warp--lab",                        # double hyphen
    "../etc/passwd",                    # path traversal
    "hq; rm -rf /",                     # shell metacharacters
    "$(reboot)",                        # command substitution
    "d-0123456789abcdef",               # opaque per-device lookalike (ADR-023)
])
def test_rejects_junk_before_writing(tmp_path, junk):
    env_file = tmp_path / ".env"
    proc = _run(junk, env_file)
    assert proc.returncode != 0, f"expected refusal for {junk!r}"
    # Nothing was written — validation fails before any .env touch.
    assert not env_file.exists()


def test_rejects_newline_injection_before_writing(tmp_path):
    # The classic env-file injection payload: a newline that opens a SECOND
    # KEY=VALUE line ("name\nDROPLET_PUBLIC_FQDN=evil"). The script's [[ =~ ]]
    # match is whole-string (newline-safe), unlike a line-based `grep -q`,
    # so this must be refused before any write. The payload rides in via the
    # ENVIRONMENT block (NUL-separated, so the literal newline survives) and
    # is expanded into $1 by bash itself — Windows CreateProcess command-line
    # quoting mangles argv-embedded newlines, which would make a plain
    # subprocess argv silently exercise a clean "name" instead.
    env_file = tmp_path / ".env"
    env = dict(os.environ)
    env.update({
        "DROPLET_BOX_NAME_ENV_FILE": str(env_file),
        "INJECT_PAYLOAD": "name\nDROPLET_PUBLIC_FQDN=evil",
    })
    proc = subprocess.run(
        [BASH, "-c", 'exec "$0" "$INJECT_PAYLOAD"', str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0, "newline-bearing name was accepted"
    assert not env_file.exists()


def test_rejects_missing_arg(tmp_path):
    env_file = tmp_path / ".env"
    proc = _run(None, env_file)
    assert proc.returncode != 0
    assert "no name given" in (proc.stderr + proc.stdout)
    assert not env_file.exists()


def test_rejection_leaves_existing_env_untouched(tmp_path):
    # A junk name against a pre-existing .env must leave it byte-identical —
    # the _upsert_env_kv write path is never reached on a validation failure.
    env_file = tmp_path / ".env"
    original = "DROPLET_BOX_NAME=old-name\nPOSTGRES_PASSWORD=keepme\n"
    env_file.write_text(original, encoding="utf-8")
    proc = _run("evil; touch /tmp/pwned", env_file)
    assert proc.returncode != 0
    assert env_file.read_text(encoding="utf-8") == original


def test_accepts_boundary_lengths(tmp_path):
    # Exactly 3 and exactly 40 characters are both valid.
    env_file3 = tmp_path / "env3"
    assert _run("abc", env_file3).returncode == 0
    env_file40 = tmp_path / "env40"
    assert _run("a" * 40, env_file40).returncode == 0


# --------------------------------------------------------------------------
# WARP-2537 — the write must go THROUGH a symlinked .env, literally
# --------------------------------------------------------------------------

# Symlink creation and sed/shell metacharacters in .env values are POSIX-shaped;
# on a Windows checkout these would error in the fixture, not exercise the
# script.
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX-only fixture")


@posix_only
def test_env_symlink_survives_the_rewrite(tmp_path):
    """After relocate_secrets_to_data has run, the repo .env is a SYMLINK into
    the encrypted /data. The old tmp+mv rewrite unlinked it and dropped a
    plaintext secrets file on the unencrypted boot disk (the WARP-232
    regression class, closed for droplet-set-nvr-media.sh by WARP-2522). The
    write must land THROUGH the link — the link survives and the bytes change
    at the link's REAL target."""
    real = tmp_path / "data" / "secrets.env"
    real.parent.mkdir()
    real.write_text(
        "DEVICE_SECRET_KEY=keepme\nDROPLET_BOX_NAME=old-name\n", encoding="utf-8"
    )
    link = tmp_path / ".env"
    link.symlink_to(real)

    proc = _run("new-name", link)
    assert proc.returncode == 0, proc.stderr
    assert link.is_symlink(), "the .env symlink was replaced by a plain file"
    assert os.readlink(link) == str(real)
    body = real.read_text(encoding="utf-8")
    assert "DROPLET_BOX_NAME=new-name\n" in body
    assert "DEVICE_SECRET_KEY=keepme\n" in body
    assert "old-name" not in body


@posix_only
def test_neighbouring_values_and_comments_survive_byte_exact(tmp_path):
    """The slug validator makes a metacharacter-bearing NAME unreachable, so the
    reachable literal-safety surface is the rest of the file: every other line
    — values carrying &, |, $, backslashes, quotes and spaces, plus plain
    comments — must pass through the rewrite byte-exact, neither re-interpreted
    nor dropped."""
    env_file = tmp_path / ".env"
    hostile = (
        "# a plain comment line\n"
        "POSTGRES_PASSWORD=p@ss&word|with$dollars\n"
        'NEXTCLOUD_ADMIN=he said "hi" \\ then left\n'
        "SPACED=value with spaces\n"
        "DROPLET_BOX_NAME=old-name\n"
        "# trailing comment\n"
    )
    env_file.write_text(hostile, encoding="utf-8")

    proc = _run("new-name", env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    for line in hostile.splitlines():
        if line.startswith("DROPLET_BOX_NAME="):
            continue
        assert line + "\n" in body, f"line mangled or dropped: {line!r}"
    assert "DROPLET_BOX_NAME=new-name\n" in body
    assert body.count("DROPLET_BOX_NAME=") == 1
