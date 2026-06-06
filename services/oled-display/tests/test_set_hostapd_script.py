"""Hermetic test for the single-box hostapd-write host script (WARP-808).

scripts/host/droplet-set-hostapd.sh is the actual host-mutation layer for the
single-box Wi-Fi AP: it writes the customer's SSID + PSK into the
droplet-openwrt-attach env file and restarts that service, which regenerates
/etc/hostapd.conf inside the droplet-openwrt container and respawns hostapd.

Its VALIDATION is the unit under test: it must reject an SSID outside 1-32 or a
PSK outside 8-63 BEFORE writing anything (a too-short PSK makes hostapd refuse
to start, so a bad write would brick the AP). The upsert must be idempotent (a
second identical write yields a byte-identical env file) and it must NEVER print
the PSK.

We drive it via subprocess. The restart is stubbed via DROPLET_HOSTAPD_DRY_RUN
so no real `systemctl` runs, and the env-file path is redirected to a tmp file
via DROPLET_HOSTAPD_ENV_FILE so we never touch the real /etc/default/... .
Skipped automatically if a POSIX `bash` isn't on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-set-hostapd.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _run(params: dict, env_file: Path, extra_env: dict | None = None):
    env = dict(os.environ)
    env.update({
        # Never actually `systemctl restart` in tests — capture the call.
        "DROPLET_HOSTAPD_DRY_RUN": "1",
        # Redirect the env-file write away from the real /etc/default/... .
        "DROPLET_HOSTAPD_ENV_FILE": str(env_file),
    })
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BASH, str(SCRIPT), json.dumps(params)],
        env=env, capture_output=True, text=True, timeout=30,
    )


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_happy_path_writes_creds_and_reports_dry_run_restart(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Studio Fotonia", "psk": "supersecret1"}, env_file)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    # The SSID landed verbatim; the env file exists and carries the new SSID.
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_AP_SSID=Studio Fotonia" in body
    assert "DROPLET_AP_PSK=supersecret1" in body
    # Dry-run must report the restart it WOULD do rather than running it.
    combined = (proc.stdout + proc.stderr).lower()
    assert "dry-run" in combined or out.get("dry_run") is True
    assert "droplet-openwrt-attach" in (proc.stdout + proc.stderr)


def test_never_prints_the_psk(tmp_path):
    # The PSK is a per-device secret (architecture-guard rule 19). It must never
    # appear on stdout or stderr — not in the success JSON, not in a log line.
    env_file = tmp_path / "droplet-openwrt-attach"
    secret = "hunter2-correct-horse"
    proc = _run({"ssid": "HomeNet", "psk": secret}, env_file)
    assert proc.returncode == 0, proc.stderr
    assert secret not in proc.stdout
    assert secret not in proc.stderr


def test_rejects_psk_shorter_than_8_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "HomeNet", "psk": "short"}, env_file)
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "password" in combined or "psk" in combined
    # Nothing was written — a bad PSK must not reach hostapd.
    assert not env_file.exists()


def test_rejects_psk_longer_than_63_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "HomeNet", "psk": "x" * 64}, env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_rejects_empty_ssid_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "", "psk": "supersecret1"}, env_file)
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "ssid" in combined or "network name" in combined
    assert not env_file.exists()


def test_rejects_ssid_longer_than_32_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "x" * 33, "psk": "supersecret1"}, env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_accepts_boundary_lengths(tmp_path):
    # SSID exactly 32, PSK exactly 8 and exactly 63 are all valid.
    env_file = tmp_path / "droplet-openwrt-attach"
    assert _run({"ssid": "x" * 32, "psk": "y" * 8}, env_file).returncode == 0
    env_file2 = tmp_path / "env2"
    assert _run({"ssid": "a", "psk": "z" * 63}, env_file2).returncode == 0


# --- SECURITY: control characters → env-file injection (WARP-808) -------------
# The SSID/PSK are written verbatim as `KEY=VALUE` lines in the systemd
# EnvironmentFile. A newline-bearing SSID like "foo\nDROPLET_AP_PSK=injected"
# passes a length-only check (the newline is one character) but would inject a
# SECOND assignment that overrides DROPLET_AP_PSK (or any key). The script must
# reject ANY control character (byte < 0x20, plus DEL) BEFORE writing.

def test_rejects_newline_injection_in_ssid_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    # The classic env-file injection payload: a newline that opens a new
    # KEY=VALUE line overriding the AP password.
    proc = _run({"ssid": "foo\nDROPLET_AP_PSK=injected", "psk": "supersecret1"},
                env_file)
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "control character" in combined or "ssid" in combined
    # Nothing written — the injected key never reaches the env file.
    assert not env_file.exists()


def test_injected_ssid_does_not_override_psk_key_even_if_file_exists(tmp_path):
    # Pre-seed a real env file; an injection attempt must leave it untouched
    # (the write is atomic-replace, and validation fails before the temp write).
    env_file = tmp_path / "droplet-openwrt-attach"
    env_file.write_text(
        "DROPLET_AP_SSID=OldName\nDROPLET_AP_PSK=originalsecret\n",
        encoding="utf-8",
    )
    proc = _run({"ssid": "evil\nDROPLET_AP_PSK=attacker", "psk": "supersecret1"},
                env_file)
    assert proc.returncode != 0
    body = env_file.read_text(encoding="utf-8")
    # The operator's original PSK survives; the attacker's value is nowhere.
    assert "DROPLET_AP_PSK=originalsecret" in body
    assert "attacker" not in body
    assert body.count("DROPLET_AP_PSK=") == 1


# NUL (\x00) is intentionally excluded: a POSIX shell variable cannot hold a NUL
# byte, so bash command-substitution strips it before validation — it can never
# survive into the env file to inject a line, so it isn't an attack vector here.
# The injection-relevant control chars are the line terminators (\n, \r).
@pytest.mark.parametrize("ctrl", ["\n", "\r", "\t", "\x0b", "\x1b", "\x7f"])
def test_rejects_any_control_char_in_ssid(tmp_path, ctrl):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Net" + ctrl + "work", "psk": "supersecret1"}, env_file)
    assert proc.returncode != 0, f"control char {ctrl!r} was accepted"
    assert not env_file.exists()


@pytest.mark.parametrize("ctrl", ["\n", "\r", "\t", "\x1b"])
def test_rejects_control_char_in_psk(tmp_path, ctrl):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "HomeNet", "psk": "secret" + ctrl + "more"}, env_file)
    assert proc.returncode != 0, f"control char {ctrl!r} in PSK was accepted"
    assert not env_file.exists()


def test_accepts_utf8_ssid_with_accents(tmp_path):
    # The control-char guard must NOT reject legitimate non-ASCII SSIDs — an
    # 802.11 SSID can be UTF-8. Multi-byte printable runs are not control chars,
    # so the script must ACCEPT them (returncode 0). We assert acceptance + that
    # the write happened, decoding tolerantly: the script's stdout/file encoding
    # follows the host locale (UTF-8 on the Linux box, cp1252 on a Windows dev
    # host), so we don't pin the exact accented bytes — just that the SSID key
    # landed and the PSK line is intact.
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Café Réseau", "psk": "supersecret1"}, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8", errors="replace")
    assert "DROPLET_AP_SSID=" in body
    assert "DROPLET_AP_PSK=supersecret1" in body
    assert body.count("DROPLET_AP_SSID=") == 1


def test_upsert_is_idempotent(tmp_path):
    # Writing the same creds twice yields a byte-identical env file — no
    # duplicated DROPLET_AP_SSID/PSK lines, no churn. The "exactly one AP reload
    # per submit; identical re-submit is a no-op" guarantee (AC4) rests on this.
    env_file = tmp_path / "droplet-openwrt-attach"
    p1 = _run({"ssid": "HomeNet", "psk": "supersecret1"}, env_file)
    assert p1.returncode == 0, p1.stderr
    first = env_file.read_text(encoding="utf-8")
    p2 = _run({"ssid": "HomeNet", "psk": "supersecret1"}, env_file)
    assert p2.returncode == 0, p2.stderr
    second = env_file.read_text(encoding="utf-8")
    assert first == second
    # Exactly one SSID line and one PSK line after two writes.
    assert second.count("DROPLET_AP_SSID=") == 1
    assert second.count("DROPLET_AP_PSK=") == 1


def test_upsert_updates_in_place_preserving_other_keys(tmp_path):
    # An existing env file with unrelated keys (DROPLET_AP_PHY etc.) keeps them;
    # only the SSID/PSK lines change. We must not clobber the operator's
    # phy/iface pinning when rotating the Wi-Fi name.
    env_file = tmp_path / "droplet-openwrt-attach"
    env_file.write_text(
        "DROPLET_AP_SSID=OldName\n"
        "DROPLET_AP_PSK=oldsecret1\n"
        "DROPLET_AP_PHY=phy0\n"
        "DROPLET_AP_IFACE=wlp14s0\n",
        encoding="utf-8",
    )
    proc = _run({"ssid": "NewName", "psk": "newsecret1"}, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_AP_SSID=NewName" in body
    assert "DROPLET_AP_PSK=newsecret1" in body
    assert "OldName" not in body
    assert "oldsecret1" not in body
    # Operator's hardware pinning survives untouched.
    assert "DROPLET_AP_PHY=phy0" in body
    assert "DROPLET_AP_IFACE=wlp14s0" in body
    assert body.count("DROPLET_AP_SSID=") == 1
    assert body.count("DROPLET_AP_PSK=") == 1


def _posix_perms_enforced(tmp_path) -> bool:
    """True only on a filesystem that actually honors chmod(0600).

    On Windows/NTFS (incl. Git-Bash) chmod is a no-op and stat reports 0o666
    regardless, so the script's real `chmod 0600` can't be observed here. The
    perms ARE enforced on the Linux box the script runs on (and in CI), so we
    gate the strict assertion on a probe rather than asserting a value the host
    OS can't deliver.
    """
    probe = tmp_path / ".perm-probe"
    probe.write_text("x", encoding="utf-8")
    os.chmod(probe, 0o600)
    return (probe.stat().st_mode & 0o777) == 0o600


def test_written_env_file_is_mode_0600(tmp_path):
    # The file holds the per-device PSK; it must not be world/group readable.
    if not _posix_perms_enforced(tmp_path):
        pytest.skip("filesystem does not enforce POSIX permission bits (Windows)")
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "HomeNet", "psk": "supersecret1"}, env_file)
    assert proc.returncode == 0, proc.stderr
    mode = env_file.stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_rejects_missing_psk_field(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "HomeNet"}, env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_rejects_bad_json(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    env = dict(os.environ)
    env.update({
        "DROPLET_HOSTAPD_DRY_RUN": "1",
        "DROPLET_HOSTAPD_ENV_FILE": str(env_file),
    })
    proc = subprocess.run(
        [BASH, str(SCRIPT), "{not valid json"],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert not env_file.exists()
