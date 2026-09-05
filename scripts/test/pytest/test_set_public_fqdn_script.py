"""Hermetic test for the public-FQDN write-back host script (WARP-994).

scripts/host/droplet-set-public-fqdn.sh is the actual host-mutation layer for
ADR-023's public-CA TLS flow: the device-bridge's auth-gated POST
/host/public-fqdn execs it to persist DROPLET_PUBLIC_FQDN=<fqdn> into the repo
.env (so the next orchestrator boot reads the learned opaque per-device name
directly) and to register the split-horizon DNS leg.

Its VALIDATION is the unit under test: the orchestrator and the bridge both
validate already, but the script validates a THIRD time (defence in depth —
the value is interpolated into .env AND a DNS payload). It must reject anything
that isn't a conservative lowercase dotted hostname of [a-z0-9.-], 1-253 chars,
no leading/trailing dot or hyphen — BEFORE writing anything. The upsert must be
idempotent (a second identical write yields a byte-identical env file) and
replace-in-place (via the canonical _upsert_env_kv, other keys survive).

We drive it via subprocess. The env-file path is redirected to a tmp file via
DROPLET_PUBLIC_FQDN_ENV_FILE and the DNS leg is skipped via
DROPLET_PUBLIC_FQDN_SKIP_DNS so we never touch a real .env or live routing
service. Skipped automatically if a POSIX `bash` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-set-public-fqdn.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")

_GOOD_FQDN = "d-0123456789abcdef.devices.warp-lab.ai"


def _run(fqdn: str | None, env_file: Path, extra_env: dict | None = None):
    env = dict(os.environ)
    env.update({
        # Redirect the .env write away from any real repo .env, and skip the
        # split-horizon DNS leg (no live routing service / host dnsmasq here).
        "DROPLET_PUBLIC_FQDN_ENV_FILE": str(env_file),
        "DROPLET_PUBLIC_FQDN_SKIP_DNS": "1",
    })
    if extra_env:
        env.update(extra_env)
    argv = [BASH, str(SCRIPT)]
    if fqdn is not None:
        argv.append(fqdn)
    return subprocess.run(
        argv, env=env, capture_output=True, text=True, timeout=30,
    )


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_happy_path_appends_public_fqdn(tmp_path):
    env_file = tmp_path / ".env"
    proc = _run(_GOOD_FQDN, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}\n" in body
    assert "persisted" in proc.stdout


def test_creates_env_file_when_missing(tmp_path):
    # A brand-new box has no .env yet — the script must create it rather than
    # fail, so the very first learned name still lands.
    env_file = tmp_path / "fresh" / ".env"
    env_file.parent.mkdir()
    proc = _run(_GOOD_FQDN, env_file)
    assert proc.returncode == 0, proc.stderr
    assert env_file.exists()
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}" in env_file.read_text(encoding="utf-8")


def test_upsert_is_idempotent(tmp_path):
    # Writing the same fqdn twice yields a byte-identical env file — no
    # duplicated DROPLET_PUBLIC_FQDN lines, no churn.
    env_file = tmp_path / ".env"
    p1 = _run(_GOOD_FQDN, env_file)
    assert p1.returncode == 0, p1.stderr
    first = env_file.read_text(encoding="utf-8")
    p2 = _run(_GOOD_FQDN, env_file)
    assert p2.returncode == 0, p2.stderr
    second = env_file.read_text(encoding="utf-8")
    assert first == second
    assert second.count("DROPLET_PUBLIC_FQDN=") == 1


def test_upsert_replaces_in_place_preserving_other_keys(tmp_path):
    # An existing .env with unrelated keys keeps them; only the
    # DROPLET_PUBLIC_FQDN line changes (a re-learn must not clobber secrets).
    env_file = tmp_path / ".env"
    env_file.write_text(
        "POSTGRES_PASSWORD=keepme\n"
        "DROPLET_PUBLIC_FQDN=d-ffffffffffffffff.devices.warp-lab.ai\n"
        "DROPLET_BOX_NAME=old-name\n",
        encoding="utf-8",
    )
    proc = _run(_GOOD_FQDN, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}" in body
    assert "d-ffffffffffffffff" not in body
    assert "POSTGRES_PASSWORD=keepme" in body
    assert "DROPLET_BOX_NAME=old-name" in body
    assert body.count("DROPLET_PUBLIC_FQDN=") == 1


def test_upsert_uncomments_a_commented_line(tmp_path):
    # A commented-out placeholder (# DROPLET_PUBLIC_FQDN=) is replaced in place,
    # not duplicated at the end of the file.
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# DROPLET_PUBLIC_FQDN=\nOTHER=1\n",
        encoding="utf-8",
    )
    proc = _run(_GOOD_FQDN, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}" in body
    assert "OTHER=1" in body
    assert body.count("DROPLET_PUBLIC_FQDN=") == 1


# --- Validation: reject BEFORE writing ---------------------------------------

@pytest.mark.parametrize("junk", [
    "nodot",                            # not a dotted hostname
    "a" * 254 + ".x",                   # too long (> 253)
    "not a.fqdn",                       # whitespace
    "Evil.Example",                     # uppercase
    ".evil.example",                    # leading dot
    "evil.example.",                    # trailing dot
    "-evil.example",                    # leading hyphen
    "evil.example-",                    # trailing hyphen
    "../etc/passwd",                    # path traversal
    "evil.example; rm -rf /",           # shell metacharacters
    "$(reboot).example",                # command substitution
    "evil_example.com",                 # underscore (not in ruleset)
])
def test_rejects_junk_before_writing(tmp_path, junk):
    env_file = tmp_path / ".env"
    proc = _run(junk, env_file)
    assert proc.returncode != 0, f"expected refusal for {junk!r}"
    # Nothing was written — validation fails before any .env touch.
    assert not env_file.exists()


def test_rejects_newline_injection_before_writing(tmp_path):
    # The classic env-file injection payload: a newline that opens a SECOND
    # KEY=VALUE line ("evil.example\nDROPLET_BOX_NAME=attacker"). The script's
    # [[ =~ ]] match is whole-string (newline-safe), unlike a line-based
    # `grep -q` (which anchors per line, so the first line would match and the
    # injected line would ride along into .env). This must be refused before
    # any write. The payload rides in via the ENVIRONMENT block (NUL-separated,
    # so the literal newline survives) and is expanded into $1 by bash itself —
    # Windows CreateProcess command-line quoting mangles argv-embedded
    # newlines, which would make a plain subprocess argv silently exercise a
    # clean "fqdn" instead.
    env_file = tmp_path / ".env"
    env = dict(os.environ)
    env.update({
        "DROPLET_PUBLIC_FQDN_ENV_FILE": str(env_file),
        "DROPLET_PUBLIC_FQDN_SKIP_DNS": "1",
        "INJECT_PAYLOAD": "evil.example\nDROPLET_BOX_NAME=attacker",
    })
    proc = subprocess.run(
        [BASH, "-c", 'exec "$0" "$INJECT_PAYLOAD"', str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0, "newline-bearing fqdn was accepted"
    assert not env_file.exists()


def test_rejects_missing_arg(tmp_path):
    env_file = tmp_path / ".env"
    proc = _run(None, env_file)
    assert proc.returncode != 0
    assert "no fqdn given" in (proc.stderr + proc.stdout)
    assert not env_file.exists()


def test_rejection_leaves_existing_env_untouched(tmp_path):
    # A junk fqdn against a pre-existing .env must leave it byte-identical —
    # the _upsert_env_kv write path is never reached on a validation failure.
    env_file = tmp_path / ".env"
    original = "DROPLET_PUBLIC_FQDN=d-ffffffffffffffff.devices.warp-lab.ai\nPOSTGRES_PASSWORD=keepme\n"
    env_file.write_text(original, encoding="utf-8")
    proc = _run("evil.example; touch /tmp/pwned", env_file)
    assert proc.returncode != 0
    assert env_file.read_text(encoding="utf-8") == original


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
        "DEVICE_SECRET_KEY=keepme\n"
        "DROPLET_PUBLIC_FQDN=d-ffffffffffffffff.devices.warp-lab.ai\n",
        encoding="utf-8",
    )
    link = tmp_path / ".env"
    link.symlink_to(real)

    proc = _run(_GOOD_FQDN, link)
    assert proc.returncode == 0, proc.stderr
    assert link.is_symlink(), "the .env symlink was replaced by a plain file"
    assert os.readlink(link) == str(real)
    body = real.read_text(encoding="utf-8")
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}\n" in body
    assert "DEVICE_SECRET_KEY=keepme\n" in body
    assert "d-ffffffffffffffff" not in body


@posix_only
def test_neighbouring_values_and_comments_survive_byte_exact(tmp_path):
    """The hostname validator makes a metacharacter-bearing FQDN unreachable —
    which is why the old sed splice never corrupted a value — so the reachable
    literal-safety surface is the rest of the file: every other line (values
    carrying &, |, $, backslashes, quotes and spaces, plus plain comments) must
    pass through the rewrite byte-exact, neither re-interpreted nor dropped."""
    env_file = tmp_path / ".env"
    hostile = (
        "# a plain comment line\n"
        "POSTGRES_PASSWORD=p@ss&word|with$dollars\n"
        'NEXTCLOUD_ADMIN=he said "hi" \\ then left\n'
        "SPACED=value with spaces\n"
        "DROPLET_PUBLIC_FQDN=d-ffffffffffffffff.devices.warp-lab.ai\n"
        "# trailing comment\n"
    )
    env_file.write_text(hostile, encoding="utf-8")

    proc = _run(_GOOD_FQDN, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    for line in hostile.splitlines():
        if line.startswith("DROPLET_PUBLIC_FQDN="):
            continue
        assert line + "\n" in body, f"line mangled or dropped: {line!r}"
    assert f"DROPLET_PUBLIC_FQDN={_GOOD_FQDN}\n" in body
    assert body.count("DROPLET_PUBLIC_FQDN=") == 1
