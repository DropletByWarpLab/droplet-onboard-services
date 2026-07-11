"""Hermetic test for the single-box guest Wi-Fi host script.

scripts/host/droplet-set-guest-wifi.sh is the host-mutation layer for the
single-box GUEST network (a second hostapd BSS): it writes the guest SSID + PSK
+ an enabled flag into the droplet-openwrt-attach env file and restarts that
service, which regenerates /etc/hostapd.conf (now with a `bss=` guest stanza)
and stands up the isolated guest subnet.

Its VALIDATION is the unit under test: reject an SSID outside 1-32 or a PSK
outside 8-63 BEFORE writing anything (a bad value bricks hostapd, taking the
WHOLE radio down — home AP included). The upsert must be idempotent, must NEVER
print the PSK, and must preserve the home-AP keys (DROPLET_AP_*). The remove
path clears the guest creds and sets DROPLET_GUEST_ENABLED=0.

We drive it via subprocess with DROPLET_GUEST_DRY_RUN=1 (no real systemctl) and
DROPLET_GUEST_ENV_FILE redirected to a tmp file. Skipped if bash isn't on PATH.
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
    / "scripts" / "host" / "droplet-set-guest-wifi.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _run(params: dict, env_file: Path, extra_env: dict | None = None):
    env = dict(os.environ)
    env.update({
        "DROPLET_GUEST_DRY_RUN": "1",
        "DROPLET_GUEST_ENV_FILE": str(env_file),
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


def test_happy_path_writes_guest_creds_enabled(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Studio Guests", "psk": "welcome123"}, env_file)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("enabled") is True
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_GUEST_SSID=Studio Guests" in body
    assert "DROPLET_GUEST_PSK=welcome123" in body
    assert "DROPLET_GUEST_ENABLED=1" in body
    combined = (proc.stdout + proc.stderr).lower()
    assert "dry-run" in combined or out.get("dry_run") is True
    assert "droplet-openwrt-attach" in (proc.stdout + proc.stderr)


def test_never_prints_the_psk(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    secret = "guest-correct-horse"
    proc = _run({"ssid": "Guests", "psk": secret}, env_file)
    assert proc.returncode == 0, proc.stderr
    assert secret not in proc.stdout
    assert secret not in proc.stderr


def test_remove_clears_creds_and_disables(tmp_path):
    # Seed a configured guest, then remove it: SSID/PSK cleared, ENABLED=0.
    env_file = tmp_path / "droplet-openwrt-attach"
    _run({"ssid": "Guests", "psk": "welcome123"}, env_file)
    proc = _run({"action": "remove"}, env_file)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("enabled") is False
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_GUEST_ENABLED=0" in body
    assert "DROPLET_GUEST_SSID=" in body          # present but empty
    assert "welcome123" not in body               # the PSK is gone
    # Exactly one of each key after create+remove (no stacking).
    assert body.count("DROPLET_GUEST_ENABLED=") == 1
    assert body.count("DROPLET_GUEST_SSID=") == 1
    assert body.count("DROPLET_GUEST_PSK=") == 1


def test_remove_needs_no_creds(tmp_path):
    # A bare remove on a never-configured box is valid (idempotent off).
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"action": "remove"}, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_GUEST_ENABLED=0" in body


def test_rejects_psk_shorter_than_8_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Guests", "psk": "short"}, env_file)
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "password" in combined or "psk" in combined
    assert not env_file.exists()


def test_rejects_psk_longer_than_63_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Guests", "psk": "x" * 64}, env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_rejects_empty_ssid_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "", "psk": "welcome123"}, env_file)
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "ssid" in combined or "network name" in combined
    assert not env_file.exists()


def test_rejects_ssid_longer_than_32_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "x" * 33, "psk": "welcome123"}, env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_accepts_boundary_lengths(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    assert _run({"ssid": "x" * 32, "psk": "y" * 8}, env_file).returncode == 0
    env_file2 = tmp_path / "env2"
    assert _run({"ssid": "a", "psk": "z" * 63}, env_file2).returncode == 0


def test_rejects_newline_injection_in_ssid_before_writing(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "foo\nDROPLET_AP_PSK=injected", "psk": "welcome123"},
                env_file)
    assert proc.returncode != 0
    assert not env_file.exists()


def test_injection_does_not_clobber_home_ap_keys(tmp_path):
    # A pre-seeded home-AP env survives an injection attempt untouched.
    env_file = tmp_path / "droplet-openwrt-attach"
    env_file.write_text(
        "DROPLET_AP_SSID=HomeNet\nDROPLET_AP_PSK=homesecret1\n",
        encoding="utf-8",
    )
    proc = _run({"ssid": "evil\nDROPLET_AP_PSK=attacker", "psk": "welcome123"},
                env_file)
    assert proc.returncode != 0
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_AP_PSK=homesecret1" in body
    assert "attacker" not in body


@pytest.mark.parametrize("ctrl", ["\n", "\r", "\t", "\x0b", "\x1b", "\x7f"])
def test_rejects_any_control_char_in_ssid(tmp_path, ctrl):
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Net" + ctrl + "work", "psk": "welcome123"}, env_file)
    assert proc.returncode != 0, f"control char {ctrl!r} was accepted"
    assert not env_file.exists()


def test_upsert_is_idempotent(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    p1 = _run({"ssid": "Guests", "psk": "welcome123"}, env_file)
    assert p1.returncode == 0, p1.stderr
    first = env_file.read_text(encoding="utf-8")
    p2 = _run({"ssid": "Guests", "psk": "welcome123"}, env_file)
    assert p2.returncode == 0, p2.stderr
    second = env_file.read_text(encoding="utf-8")
    assert first == second
    assert second.count("DROPLET_GUEST_SSID=") == 1
    assert second.count("DROPLET_GUEST_PSK=") == 1
    assert second.count("DROPLET_GUEST_ENABLED=") == 1


def test_upsert_preserves_home_ap_keys(tmp_path):
    # Writing the guest creds must NOT clobber the home AP SSID/PSK or the
    # operator's phy/iface pinning — they share one env file.
    env_file = tmp_path / "droplet-openwrt-attach"
    env_file.write_text(
        "DROPLET_AP_SSID=HomeNet\n"
        "DROPLET_AP_PSK=homesecret1\n"
        "DROPLET_AP_PHY=phy0\n"
        "DROPLET_AP_IFACE=wlp14s0\n",
        encoding="utf-8",
    )
    proc = _run({"ssid": "Guests", "psk": "welcome123"}, env_file)
    assert proc.returncode == 0, proc.stderr
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_AP_SSID=HomeNet" in body
    assert "DROPLET_AP_PSK=homesecret1" in body
    assert "DROPLET_AP_PHY=phy0" in body
    assert "DROPLET_AP_IFACE=wlp14s0" in body
    assert "DROPLET_GUEST_SSID=Guests" in body


def test_rejects_bad_json(tmp_path):
    env_file = tmp_path / "droplet-openwrt-attach"
    env = dict(os.environ)
    env.update({
        "DROPLET_GUEST_DRY_RUN": "1",
        "DROPLET_GUEST_ENV_FILE": str(env_file),
    })
    proc = subprocess.run(
        [BASH, str(SCRIPT), "{not valid json"],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert not env_file.exists()


def _posix_perms_enforced(tmp_path) -> bool:
    probe = tmp_path / ".perm-probe"
    probe.write_text("x", encoding="utf-8")
    os.chmod(probe, 0o600)
    return (probe.stat().st_mode & 0o777) == 0o600


def test_written_env_file_is_mode_0600(tmp_path):
    if not _posix_perms_enforced(tmp_path):
        pytest.skip("filesystem does not enforce POSIX permission bits (Windows)")
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run({"ssid": "Guests", "psk": "welcome123"}, env_file)
    assert proc.returncode == 0, proc.stderr
    mode = env_file.stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


# --- WARP-843: sandboxed (unprivileged) write path — restart is DEFERRED ------
# The guest write shares the home-AP write's fate: since the pin change in
# droplet-device-bridge.service both scripts write the SAME droplet-owned
# /etc/default/droplet-openwrt-attach, so the guest script needs the identical
# treatment — unprivileged (EUID != 0) or DROPLET_GUEST_NO_RESTART=1 skips the
# privileged `systemctl restart`; the root droplet-openwrt-attach.path unit
# re-applies. Mirrors test_set_hostapd_script.py's WARP-843 section.

def _systemctl_stub(tmp_path: Path):
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    calls = tmp_path / "systemctl-calls.log"
    stub = stub_dir / "systemctl"
    stub.write_text(
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "{}"\nexit 0\n'.format(
            str(calls).replace("\\", "/")),
        encoding="utf-8", newline="\n")
    stub.chmod(0o755)
    return str(stub_dir), calls


def _run_real(params: dict, env_file: Path, extra_env: dict | None = None):
    """Run the script WITHOUT the dry-run stub — the real write path."""
    env = dict(os.environ)
    env.pop("DROPLET_GUEST_DRY_RUN", None)
    env["DROPLET_GUEST_ENV_FILE"] = str(env_file)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BASH, str(SCRIPT), json.dumps(params)],
        env=env, capture_output=True, text=True, timeout=30,
    )


def test_no_restart_flag_writes_env_but_never_calls_systemctl(tmp_path):
    stub_dir, calls = _systemctl_stub(tmp_path)
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run_real(
        {"ssid": "Guests", "psk": "welcome123"}, env_file,
        {"DROPLET_GUEST_NO_RESTART": "1",
         "PATH": stub_dir + os.pathsep + os.environ.get("PATH", "")})
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("restarted") is False
    assert out.get("reapply") == "path-unit"
    body = env_file.read_text(encoding="utf-8")
    assert "DROPLET_GUEST_SSID=Guests" in body
    assert "DROPLET_GUEST_ENABLED=1" in body
    assert not calls.exists(), f"systemctl was invoked: {calls.read_text()}"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="running as root — the unprivileged EUID branch can't be exercised")
def test_unprivileged_euid_skips_systemctl_even_without_flag(tmp_path):
    stub_dir, calls = _systemctl_stub(tmp_path)
    env_file = tmp_path / "droplet-openwrt-attach"
    proc = _run_real(
        {"ssid": "Guests", "psk": "welcome123"}, env_file,
        {"PATH": stub_dir + os.pathsep + os.environ.get("PATH", "")})
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("restarted") is False
    assert not calls.exists(), f"systemctl was invoked: {calls.read_text()}"


def test_remove_path_also_skips_systemctl_unprivileged(tmp_path):
    # The teardown path restarts too — it must defer identically.
    stub_dir, calls = _systemctl_stub(tmp_path)
    env_file = tmp_path / "droplet-openwrt-attach"
    _run_real({"ssid": "Guests", "psk": "welcome123"}, env_file,
              {"DROPLET_GUEST_NO_RESTART": "1",
               "PATH": stub_dir + os.pathsep + os.environ.get("PATH", "")})
    proc = _run_real({"action": "remove"}, env_file,
                     {"DROPLET_GUEST_NO_RESTART": "1",
                      "PATH": stub_dir + os.pathsep + os.environ.get("PATH", "")})
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("restarted") is False
    assert "DROPLET_GUEST_ENABLED=0" in env_file.read_text(encoding="utf-8")
    assert not calls.exists(), f"systemctl was invoked: {calls.read_text()}"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root ignores directory permission bits — the sandbox shape can't be simulated")
def test_in_place_rewrite_when_env_dir_is_read_only(tmp_path):
    # Same box scenario as the home-AP write: root-owned 0755 /etc/default,
    # droplet-owned 0600 env file → locked in-place rewrite, same inode,
    # home-AP keys preserved, no temp litter.
    if not _posix_perms_enforced(tmp_path):
        pytest.skip("filesystem does not enforce POSIX permission bits (Windows)")
    stub_dir, calls = _systemctl_stub(tmp_path)
    ro_dir = tmp_path / "etc-default"
    ro_dir.mkdir()
    env_file = ro_dir / "droplet-openwrt-attach"
    env_file.write_text(
        "DROPLET_AP_SSID=HomeNet\nDROPLET_AP_PSK=homesecret1\n",
        encoding="utf-8")
    os.chmod(env_file, 0o600)
    os.chmod(ro_dir, 0o555)
    try:
        ino_before = env_file.stat().st_ino
        proc = _run_real(
            {"ssid": "Guests", "psk": "welcome123"}, env_file,
            {"DROPLET_GUEST_NO_RESTART": "1",
             "PATH": stub_dir + os.pathsep + os.environ.get("PATH", "")})
        assert proc.returncode == 0, proc.stderr
        body = env_file.read_text(encoding="utf-8")
        assert "DROPLET_GUEST_SSID=Guests" in body
        assert "DROPLET_GUEST_ENABLED=1" in body
        assert "DROPLET_AP_SSID=HomeNet" in body       # home AP untouched
        assert "DROPLET_AP_PSK=homesecret1" in body
        assert env_file.stat().st_ino == ino_before, \
            "expected an in-place rewrite (rename is impossible here)"
        assert (env_file.stat().st_mode & 0o777) == 0o600
        leftovers = [p.name for p in ro_dir.iterdir()
                     if p.name != "droplet-openwrt-attach"]
        assert leftovers == [], f"temp-file litter in the read-only dir: {leftovers}"
        assert not calls.exists()
    finally:
        os.chmod(ro_dir, 0o755)
