"""Wiring pins for the camera-recordings allocation host surface (WARP-3514).

The allocation is spread over files that have to agree with each other and that
nothing else ties together: the device-bridge (which starts two root units), the
polkit rule (which lets it), the installer (which places the scripts + units and
turns the boot guard on) and factory-reset (which must remove everything the
installer added — and disarm the guard BEFORE removing the script that knows how
to). A name that drifts in any one of them fails silently on a real box: a unit
the installer never enables, a start polkit denies, an immutable placeholder
directory stranded under /mnt/droplet after a reset.

Two layers, both hermetic (no root, no systemd, no docker, nothing outside a
scratch dir):

  * STRUCTURAL pins over the repo files (these run everywhere); and
  * BEHAVIOURAL tests that cut a section out of the REAL installer / reset script
    and execute it under bash with the host tools replaced by recording shims, so
    "never fatal" and "disarm first" are shown by running them, not by grepping.
    POSIX only — skipped on a Windows dev host.

Ownership: the scripts and units named here are written elsewhere in the same
change (writer, apply consumer, migration job, boot guard). The one hard
cross-check on them is `test_every_installer_source_exists`; their content is
pinned by their own suites, so the unit-file checks here only cover what the
wiring depends on and skip while a unit is not present.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALLER = REPO_ROOT / "scripts" / "install-device-bridge.sh"
FACTORY_RESET = REPO_ROOT / "scripts" / "factory-reset.sh"
OLED_DIR = REPO_ROOT / "services" / "oled-display"
POLKIT = OLED_DIR / "50-droplet-device-bridge.rules"
BRIDGE = OLED_DIR / "device-bridge.py"
BRIDGE_UNIT = OLED_DIR / "droplet-device-bridge.service"
HOST_DIR = REPO_ROOT / "scripts" / "host"
BASH = shutil.which("bash")

NVR_SCRIPTS = (
    "droplet-nvr-quota.py",
    "droplet-nvr-storage-apply.sh",
    "droplet-nvr-migrate.sh",
    "droplet-nvr-guard.sh",
    "droplet-storage-topology-lock.sh",
)
NVR_CHECKER = "droplet-recordings-drive-check.py"
ON_DEMAND_UNITS = ("droplet-nvr-storage-apply.service", "droplet-nvr-migrate.service")
GUARD_UNITS = (
    "droplet-nvr-guard.service",
    "droplet-nvr-guard-release.service",
    "droplet-nvr-guard-release.timer",
)
NVR_UNITS = ON_DEMAND_UNITS + GUARD_UNITS
# Units the installer already placed before this change: must all survive.
PRE_EXISTING_UNITS = (
    "droplet-device-bridge.service",
    "droplet-wifi-rotate.service",
    "droplet-wifi-rotate.timer",
    "droplet-shutdown-screen.service",
    "droplet-storage-pool-apply.service",
    "droplet-panel-claim.service",
    "droplet-panel-console.service",
    "droplet-panel-deadman.service",
    "droplet-panel-deadman.timer",
)
STATE_DIR = "/var/lib/droplet-nvr"

_posix_only = pytest.mark.skipif(
    sys.platform == "win32" or BASH is None,
    reason="runs the real shell sections against POSIX shims")
_needs_bash = pytest.mark.skipif(BASH is None, reason="bash not available")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _logical_lines(path: Path) -> list[str]:
    """A shell script as logical lines: comments dropped, `\\`-continuations
    joined, whitespace squeezed."""
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"\\\n\s*", " ", text)
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(re.sub(r"\s+", " ", stripped))
    return lines


def _code(path: Path) -> str:
    return "\n".join(_logical_lines(path))


def _loop_items(path: Path, var: str, suffixes: str) -> list[str]:
    for line in _logical_lines(path):
        m = re.match(r"for {} in (.*); do$".format(re.escape(var)), line)
        if m:
            return re.findall(r"[A-Za-z0-9_.@-]+\.(?:{})\b".format(suffixes), m.group(1))
    raise AssertionError("no `for {} in ...; do` loop in {}".format(var, path.name))


def _installer_units() -> list[str]:
    return _loop_items(INSTALLER, "unit", "service|timer|path")


def _installer_scripts() -> list[str]:
    return _loop_items(INSTALLER, "nvr_script", "sh|py")


def _section(text: str, start_marker: str) -> str:
    """The text from the line starting with `start_marker` up to (not including)
    the next `# --- ` section heading."""
    start = text.index(start_marker)
    nxt = re.compile(r"^# --- ", re.M).search(text, start + len(start_marker))
    return text[start:nxt.start() if nxt else len(text)]


def _polkit() -> dict:
    text = "\n".join(line for line in POLKIT.read_text(encoding="utf-8").splitlines()
                     if not line.lstrip().startswith("//"))
    return {
        "units": re.findall(r'action\.lookup\("unit"\)\s*===\s*"([^"]+)"', text),
        "verbs": re.findall(r'action\.lookup\("verb"\)\s*===\s*"([^"]+)"', text),
        "users": re.findall(r'subject\.user\s*===\s*"([^"]+)"', text),
        "rules": text.count("polkit.addRule("),
        "text": text,
    }


def _load_bridge(monkeypatch):
    for name in ("DROPLET_NVR_SCRIPT", "DROPLET_NVR_SPOOL_DIR",
                 "DROPLET_NVR_APPLY_UNIT", "DROPLET_NVR_MIGRATE_UNIT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    spec = importlib.util.spec_from_file_location("device_bridge_nvr_wiring", BRIDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unit_text(name: str) -> str:
    path = OLED_DIR / name
    if not path.exists():
        pytest.skip("{} has not landed yet (written elsewhere in this change)".format(name))
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# polkit: the bridge may START the two on-demand units, nothing else
# ---------------------------------------------------------------------------

def test_polkit_grants_exactly_the_allowed_starts():
    p = _polkit()
    assert sorted(p["units"]) == sorted([
        "droplet-storage-pool-apply.service",
        "droplet-panel-console.service",
        "droplet-nvr-storage-apply.service",
        "droplet-nvr-migrate.service",
    ])
    assert len(p["units"]) == len(set(p["units"])), "a unit is granted twice"
    # ONE rule, start verb only, for the unprivileged bridge user only.
    assert p["rules"] == 1
    assert p["verbs"] == ["start"]
    assert p["users"] == ["droplet"]


@pytest.mark.parametrize("unit", GUARD_UNITS)
def test_polkit_grants_nothing_over_the_boot_guard_units(unit):
    # The bridge must not be able to stop the guard that keeps Frigate off the
    # OS disk (or start/stop its release timer).
    assert unit not in _polkit()["units"]
    assert "droplet-nvr-guard" not in _polkit()["text"]


def test_polkit_never_grants_stop_restart_or_enable():
    text = _polkit()["text"]
    for verb in ("stop", "restart", "reload", "try-restart", "enable", "disable",
                 "kill", "reset-failed"):
        assert '"{}"'.format(verb) not in text, verb


def test_the_bridge_default_units_are_granted_by_polkit(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    granted = set(_polkit()["units"])
    assert bridge.NVR_APPLY_UNIT in granted
    assert bridge.NVR_MIGRATE_UNIT in granted
    assert {bridge.NVR_APPLY_UNIT, bridge.NVR_MIGRATE_UNIT} == set(ON_DEMAND_UNITS)


def test_the_bridge_spool_lives_in_its_own_state_directory(monkeypatch):
    # The bridge may only write inside its StateDirectory (ProtectSystem=strict);
    # the ROOT-only state must be OUTSIDE it, where the bridge cannot reach it.
    bridge = _load_bridge(monkeypatch)
    unit = BRIDGE_UNIT.read_text(encoding="utf-8")
    assert re.search(r"^StateDirectory=droplet-bridge$", unit, re.M)
    assert bridge.NVR_SPOOL_DIR.startswith("/var/lib/droplet-bridge/")
    assert not STATE_DIR.startswith("/var/lib/droplet-bridge")


# ---------------------------------------------------------------------------
# installer: structure
# ---------------------------------------------------------------------------

def test_installer_places_every_unit_old_and_new():
    units = _installer_units()
    assert len(units) == len(set(units)), "a unit is listed twice"
    for unit in PRE_EXISTING_UNITS + NVR_UNITS:
        assert unit in units, "{} is missing from the installer unit loop".format(unit)


def test_installer_unit_loop_still_substitutes_the_repo_root():
    # The new units carry `Environment=REPO_ROOT=@REPO_ROOT@`; the placeholder is
    # only resolved by the sed in this very loop.
    assert 'sed "s|@REPO_ROOT@|$REPO_ROOT|g" "$src" > "$dst"' in _code(INSTALLER)


def test_installer_installs_the_nvr_scripts_0755_into_sbin():
    assert sorted(_installer_scripts()) == sorted(NVR_SCRIPTS)
    code = _code(INSTALLER)
    assert 'install -m 0755 "$nvr_src" "/usr/local/sbin/$nvr_script"' in code
    assert 'nvr_src="$REPO_ROOT/scripts/host/$nvr_script"' in code


def test_installer_keeps_the_existing_writer_install():
    code = _code(INSTALLER)
    assert 'SET_NVR_MEDIA_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-nvr-media.sh"' in code
    assert 'SET_NVR_MEDIA_SCRIPT_DST="/usr/local/sbin/droplet-set-nvr-media.sh"' in code
    assert 'install -m 0755 "$SET_NVR_MEDIA_SCRIPT_SRC" "$SET_NVR_MEDIA_SCRIPT_DST"' in code


def test_installer_places_the_recordings_checker_and_provisions_shared_lock():
    code = _code(INSTALLER)
    assert '"$REPO_ROOT/scripts/host/droplet-recordings-drive-check.py"' in code
    assert 'install -m 0755 "$REPO_ROOT/scripts/host/droplet-recordings-drive-check.py" /usr/local/sbin/droplet-recordings-drive-check.py' in code
    tmpfiles = _code(HOST_DIR / "etc-tmpfiles.d" / "droplet.conf")
    assert "f /run/droplet-storage-ops/recordings-topology.lock 0660 root droplet - -" in tmpfiles
    assert "install -m 0644 \"$TMPFILES_SRC\" /etc/tmpfiles.d/droplet.conf" in code
    assert "systemd-tmpfiles --create /etc/tmpfiles.d/droplet.conf" in code


def test_shared_lock_is_writable_by_bridge_and_root_pool_uses_same_repo_env():
    bridge_unit = BRIDGE_UNIT.read_text(encoding="utf-8")
    pool_unit = _unit_text("droplet-storage-pool-apply.service")
    lock_helper = _code(HOST_DIR / "droplet-storage-topology-lock.sh")
    assert re.search(r"^ReadWritePaths=/run/droplet-storage-ops$", bridge_unit, re.M)
    assert "Environment=REPO_ROOT=@REPO_ROOT@" in pool_unit
    assert "/run/droplet-storage-ops/recordings-topology.lock" in lock_helper
    assert '"/proc/$$/fd/7"' in lock_helper and '"/proc/$$/fd/8"' in lock_helper
    assert "flock -n -E 75 -x 8" in lock_helper


def test_installer_creates_the_root_only_state_dir():
    assert "install -d -m 0700 {}".format(STATE_DIR) in _code(INSTALLER)


def test_installer_enables_the_guard_and_the_release_timer():
    code = _code(INSTALLER)
    assert re.search(r"systemctl enable droplet-nvr-guard\.service(?=[; ])", code)
    assert re.search(r"systemctl enable --now droplet-nvr-guard-release\.timer(?=[; ])", code)


def test_installer_never_enables_or_starts_the_on_demand_units():
    # They run only when the bridge starts them (polkit, start verb only).
    code = _code(INSTALLER)
    for unit in ON_DEMAND_UNITS:
        pattern = (r"systemctl\s+(?:--\S+\s+)*(?:enable|start|restart|reload|try-restart"
                   r"|reenable|unmask)\b[^\n]*" + re.escape(unit))
        assert not re.search(pattern, code), unit


def test_installer_arms_the_guard_once_after_everything_is_in_place():
    code = _code(INSTALLER)
    arm = code.index("/usr/local/sbin/droplet-nvr-guard.sh arm")
    assert code.index("systemctl daemon-reload") < arm, "arm before units are loaded"
    assert code.index('install -m 0755 "$nvr_src"') < arm, "arm before the script exists"
    assert code.index("systemctl enable droplet-nvr-guard.service") < arm
    assert code.count("/usr/local/sbin/droplet-nvr-guard.sh arm") == 1
    # The installed copy finds the repo .env through REPO_ROOT, and a failing
    # arm must never abort the install.
    line = next(l for l in _logical_lines(INSTALLER)
                if "/usr/local/sbin/droplet-nvr-guard.sh arm" in l)
    assert 'REPO_ROOT="$REPO_ROOT"' in line
    assert "||" in line


def test_installer_rsync_install_is_best_effort():
    # (`log "... sudo apt-get install -y rsync"` is only the remediation hint.)
    lines = [l for l in _logical_lines(INSTALLER)
             if "install -y rsync" in l and not l.startswith("log ")]
    assert lines, "the installer never installs rsync"
    for line in lines:
        # Either the condition of an `if !` (so set -e cannot trip) or `|| true`.
        assert re.search(r"(?:^if ! |\|\| true$)", line), line


def test_every_installer_source_exists():
    """The installer `exit 1`s on a missing source, so every script and unit it
    names must really be in the tree — the one hard cross-check on files that are
    written elsewhere in this change."""
    missing = [str(HOST_DIR / s) for s in _installer_scripts() if not (HOST_DIR / s).is_file()]
    missing += [str(OLED_DIR / u) for u in _installer_units()
                if not (OLED_DIR / u).is_file()]
    assert not missing, "installer references files that do not exist: {}".format(missing)


@_needs_bash
@pytest.mark.parametrize("path", [INSTALLER, FACTORY_RESET], ids=lambda p: p.name)
def test_shell_syntax_is_clean(path):
    proc = subprocess.run([BASH, "-n", str(path)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr


# (Not the polkit rules file: .gitattributes does not pin `*.rules`, so a Windows
# checkout with core.autocrlf materializes it as CRLF — harmless to polkit, and
# the committed blob is LF either way.)
@pytest.mark.parametrize("path", [INSTALLER, FACTORY_RESET, BRIDGE], ids=lambda p: p.name)
def test_files_are_lf_only(path):
    assert b"\r" not in path.read_bytes()


# ---------------------------------------------------------------------------
# installer: behaviour of the new sections, run under bash with shims
# ---------------------------------------------------------------------------

def _shim(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text("#!{}\n{}\n".format(BASH, body), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _run_section(script: str, *, env: dict, timeout: int = 60):
    return subprocess.run([BASH, "-c", script], env=env, capture_output=True,
                          text=True, timeout=timeout)


def _log_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


_PRELUDE = (
    "set -euo pipefail\n"
    "log() { printf '[install-bridge] %s\\n' \"$*\"; }\n"
)


@_posix_only
def test_script_block_installs_each_script_and_the_state_dir(tmp_path):
    section = _section(INSTALLER.read_text(encoding="utf-8"), "# --- 1f) Camera-recordings")
    repo = tmp_path / "repo"
    (repo / "scripts" / "host").mkdir(parents=True)
    for name in NVR_SCRIPTS:
        (repo / "scripts" / "host" / name).write_text("#!/bin/sh\n")
    (repo / "scripts" / "host" / NVR_CHECKER).write_text("#!/usr/bin/env python3\n")
    shims = tmp_path / "shims"
    shims.mkdir()
    shim_log = tmp_path / "install.log"
    _shim(shims, "install", 'printf \'%s\\n\' "$*" >> "$SHIM_LOG"')
    env = {**os.environ, "PATH": "{}{}{}".format(shims, os.pathsep, os.environ["PATH"]),
           "SHIM_LOG": str(shim_log)}
    proc = _run_section("{}REPO_ROOT={}\n{}".format(_PRELUDE, shlex.quote(str(repo)), section),
                        env=env)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    calls = _log_lines(shim_log)
    for name in NVR_SCRIPTS:
        assert "-m 0755 {} /usr/local/sbin/{}".format(
            repo / "scripts" / "host" / name, name) in calls
    assert "-m 0755 {} /usr/local/sbin/{}".format(
        repo / "scripts" / "host" / NVR_CHECKER, NVR_CHECKER) in calls
    assert "-d -m 0700 {}".format(STATE_DIR) in calls
    assert len(calls) == len(NVR_SCRIPTS) + 2, calls


@_posix_only
def test_script_block_refuses_a_missing_source_like_its_siblings(tmp_path):
    section = _section(INSTALLER.read_text(encoding="utf-8"), "# --- 1f) Camera-recordings")
    repo = tmp_path / "repo"
    (repo / "scripts" / "host").mkdir(parents=True)        # no sources at all
    shims = tmp_path / "shims"
    shims.mkdir()
    shim_log = tmp_path / "install.log"
    _shim(shims, "install", 'printf \'%s\\n\' "$*" >> "$SHIM_LOG"')
    env = {**os.environ, "PATH": "{}{}{}".format(shims, os.pathsep, os.environ["PATH"]),
           "SHIM_LOG": str(shim_log)}
    proc = _run_section("{}REPO_ROOT={}\n{}".format(_PRELUDE, shlex.quote(str(repo)), section),
                        env=env)
    assert proc.returncode == 1
    assert "missing source:" in proc.stdout
    assert _log_lines(shim_log) == []          # nothing was installed


def _rsync_run(tmp_path, *, rsync_present: bool, apt_ok: bool):
    """Run the rsync section with `rsync`/`apt-get` as shell functions (no PATH
    at all, so a real rsync can never leak in)."""
    section = _section(INSTALLER.read_text(encoding="utf-8"), "# --- 2c) rsync")
    shim_log = tmp_path / "apt.log"
    prelude = _PRELUDE + (
        "PATH=/nonexistent\n"
        "apt-get() {\n"
        "  printf 'apt-get %s\\n' \"$*\" >> \"$SHIM_LOG\"\n"
        "  [ \"$1\" = update ] && return 0\n"
        "  if [ \"$APT_OK\" = 1 ]; then rsync() { :; }; return 0; fi\n"
        "  return 100\n"
        "}\n"
    )
    if rsync_present:
        prelude += "rsync() { :; }\n"
    env = {"SHIM_LOG": str(shim_log), "APT_OK": "1" if apt_ok else "0"}
    proc = _run_section(prelude + section, env=env)
    return proc, _log_lines(shim_log)


@_posix_only
def test_rsync_block_does_nothing_when_rsync_is_present(tmp_path):
    proc, calls = _rsync_run(tmp_path, rsync_present=True, apt_ok=False)
    assert proc.returncode == 0, proc.stderr
    assert calls == []
    assert "rsync: already installed" in proc.stdout


@_posix_only
def test_rsync_block_installs_it_when_missing(tmp_path):
    proc, calls = _rsync_run(tmp_path, rsync_present=False, apt_ok=True)
    assert proc.returncode == 0, proc.stderr
    assert calls == ["apt-get install -y rsync"]
    assert "rsync: installed" in proc.stdout
    assert "WARNING" not in proc.stdout


@_posix_only
def test_rsync_block_never_aborts_the_install_when_apt_fails(tmp_path):
    proc, calls = _rsync_run(tmp_path, rsync_present=False, apt_ok=False)
    # `set -e` is on in the installer: a failing apt must not kill it.
    assert proc.returncode == 0, proc.stderr + proc.stdout
    # first try, one index refresh, one retry — then it gives up, loudly.
    assert calls == ["apt-get install -y rsync", "apt-get update -y",
                     "apt-get install -y rsync"]
    assert "WARNING: rsync is still missing" in proc.stdout
    assert "rsync_missing" in proc.stdout


def _guard_run(tmp_path, *, systemctl_rc: int = 0, arm_rc: int = 0):
    """Run the guard-activation section with `systemctl` as a recording function
    and the (absolute-path) guard script re-pointed at a recording shim."""
    section = _section(INSTALLER.read_text(encoding="utf-8"), "# --- 4a-ter) Camera-recordings")
    shim_log = tmp_path / "guard.log"
    guard = _shim(tmp_path, "droplet-nvr-guard.sh",
                  'printf \'guard %s REPO_ROOT=%s\\n\' "$*" "${REPO_ROOT:-unset}" >> "$SHIM_LOG"\n'
                  'exit "${ARM_RC:-0}"')
    assert "/usr/local/sbin/droplet-nvr-guard.sh" in section
    section = section.replace("/usr/local/sbin/droplet-nvr-guard.sh", str(guard))
    prelude = _PRELUDE + (
        "REPO_ROOT=/srv/repo\n"
        "systemctl() {\n"
        "  printf 'systemctl %s\\n' \"$*\" >> \"$SHIM_LOG\"\n"
        "  return \"$SYSTEMCTL_RC\"\n"
        "}\n"
    )
    env = {**os.environ, "SHIM_LOG": str(shim_log), "SYSTEMCTL_RC": str(systemctl_rc),
           "ARM_RC": str(arm_rc)}
    env.pop("REPO_ROOT", None)
    proc = _run_section(prelude + section, env=env)
    return proc, _log_lines(shim_log)


@_posix_only
def test_guard_block_enables_the_units_then_arms_once_with_the_repo_root(tmp_path):
    proc, calls = _guard_run(tmp_path)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    assert calls == [
        "systemctl enable droplet-nvr-guard.service",
        "systemctl enable --now droplet-nvr-guard-release.timer",
        "guard arm REPO_ROOT=/srv/repo",
    ]
    assert "WARNING" not in proc.stdout


@_posix_only
def test_guard_block_is_never_fatal_but_says_so_when_it_cannot_wire_the_guard(tmp_path):
    proc, calls = _guard_run(tmp_path, systemctl_rc=1, arm_rc=1)
    assert proc.returncode == 0, proc.stderr + proc.stdout     # set -e did not trip
    # Every step was still attempted, in order.
    assert calls == [
        "systemctl enable droplet-nvr-guard.service",
        "systemctl enable --now droplet-nvr-guard-release.timer",
        "guard arm REPO_ROOT=/srv/repo",
    ]
    out = proc.stdout
    assert "could not enable droplet-nvr-guard.service" in out
    assert "could not enable droplet-nvr-guard-release.timer" in out
    assert "droplet-nvr-guard.sh arm failed" in out


@_posix_only
def test_guard_block_reports_a_failing_arm_on_its_own(tmp_path):
    proc, calls = _guard_run(tmp_path, arm_rc=1)
    assert proc.returncode == 0
    assert "droplet-nvr-guard.sh arm failed" in proc.stdout
    assert "could not enable" not in proc.stdout


# ---------------------------------------------------------------------------
# factory-reset: removes everything the installer adds, disarming first
# ---------------------------------------------------------------------------

def _reset_block() -> str:
    text = FACTORY_RESET.read_text(encoding="utf-8")
    start = text.index("# Camera-recordings allocation (WARP-3514")
    end = text.index("# Device-bridge state + logs", start)
    return text[start:end]


def test_factory_reset_removes_every_script_the_installer_adds():
    code = _code(FACTORY_RESET)
    for script in NVR_SCRIPTS:
        assert "/usr/local/sbin/{}".format(script) in code, script
    assert "/usr/local/sbin/{}".format(NVR_CHECKER) in code
    # ...and the list really is the installer's (not a stale copy of it).
    assert set(_installer_scripts()) == set(NVR_SCRIPTS)


def test_factory_reset_removes_every_unit_the_installer_adds():
    code = _code(FACTORY_RESET)
    installed = [u for u in _installer_units() if u.startswith("droplet-nvr-")]
    assert sorted(installed) == sorted(NVR_UNITS)
    for unit in installed:
        assert "/etc/systemd/system/{}".format(unit) in code, unit


def test_factory_reset_removes_the_root_only_state_dir():
    assert "rm -rf {}".format(STATE_DIR) in _code(FACTORY_RESET).replace("sudo ", "")


def test_factory_reset_disarms_the_guard_before_removing_anything_it_needs():
    lines = [l for l in re.sub(r"\\\n\s*", " ", _reset_block()).splitlines()
             if l.strip() and not l.strip().startswith("#")]
    lines = [re.sub(r"\s+", " ", l.strip()) for l in lines]

    def first(pattern):
        return next(i for i, l in enumerate(lines) if re.search(pattern, l))

    disarm = first(r"droplet-nvr-guard\.sh disarm")
    assert "|| true" in lines[disarm]
    assert disarm < first(r"rm -f /etc/systemd/system/droplet-nvr-guard")
    assert disarm < first(r"rm -f .*/usr/local/sbin/droplet-nvr-guard\.sh")
    assert disarm < first(r"rm -rf /var/lib/droplet-nvr")
    # The units are disabled before their files go.
    assert first(r"disable --now droplet-nvr-guard-release\.timer") < \
        first(r"rm -f /etc/systemd/system/droplet-nvr-guard")
    assert first(r"disable --now droplet-nvr-guard\.service") < \
        first(r"rm -f /etc/systemd/system/droplet-nvr-guard")
    # ...and the unit files are reloaded away.
    assert first(r"rm -f /etc/systemd/system/droplet-nvr-guard") < \
        first(r"systemctl daemon-reload")


def test_factory_reset_never_aborts_on_a_failing_step():
    for line in re.sub(r"\\\n\s*", " ", _reset_block()).splitlines():
        line = line.strip()
        if line.startswith("sudo "):
            assert line.endswith("|| true"), line


@_posix_only
def test_factory_reset_block_disarms_first_then_removes_everything(tmp_path):
    sbin, units, state = tmp_path / "sbin", tmp_path / "units", tmp_path / "state"
    for d in (sbin, units, state):
        d.mkdir()
    (state / "guard.json").write_text("{}")
    (state / "migration.json").write_text("{}")
    for unit in NVR_UNITS:
        (units / unit).write_text("[Unit]\n")
    keep = units / "droplet-storage-pool-apply.service"      # NOT ours: must survive
    keep.write_text("[Unit]\n")
    shim_log = tmp_path / "reset.log"
    watched = [str(units / u) for u in NVR_UNITS] + [str(sbin / s) for s in NVR_SCRIPTS] \
        + [str(state)]
    _shim(sbin, "droplet-nvr-guard.sh",
          'printf \'disarm-call %s\\n\' "$*" >> "$SHIM_LOG"\n'
          'for f in $WATCHED; do\n'
          '  if [ -e "$f" ]; then printf \'present %s\\n\' "$f" >> "$SHIM_LOG";\n'
          '  else printf \'ABSENT %s\\n\' "$f" >> "$SHIM_LOG"; fi\n'
          'done')
    for script in NVR_SCRIPTS:
        if script != "droplet-nvr-guard.sh":
            (sbin / script).write_text("#!/bin/sh\n")

    block = (_reset_block()
             .replace("/usr/local/sbin", str(sbin))
             .replace("/etc/systemd/system", str(units))
             .replace(STATE_DIR, str(state)))
    prelude = (
        "set -euo pipefail\n"
        "log_success() { printf 'OK: %s\\n' \"$*\"; }\n"
        "sudo() { \"$@\"; }\n"
        "systemctl() { printf 'systemctl %s\\n' \"$*\" >> \"$SHIM_LOG\"; }\n"
    )
    env = {**os.environ, "SHIM_LOG": str(shim_log), "WATCHED": " ".join(watched)}
    proc = _run_section(prelude + block, env=env)
    assert proc.returncode == 0, proc.stderr + proc.stdout

    calls = _log_lines(shim_log)
    # disarm ran exactly once, and BEFORE anything was removed.
    assert calls.count("disarm-call disarm") == 1
    assert not [c for c in calls if c.startswith("ABSENT")], calls
    assert len([c for c in calls if c.startswith("present")]) == len(watched)
    disarm_at = calls.index("disarm-call disarm")
    assert calls.index("systemctl disable --now droplet-nvr-guard-release.timer") > disarm_at
    assert calls.index("systemctl disable --now droplet-nvr-guard.service") > disarm_at
    assert calls[-1] == "systemctl daemon-reload"
    # Everything the installer added is gone; nothing else was touched.
    for unit in NVR_UNITS:
        assert not (units / unit).exists(), unit
    for script in NVR_SCRIPTS:
        assert not (sbin / script).exists(), script
    assert not state.exists()
    assert keep.exists()
    assert "Removed NVR recordings boot guard" in proc.stdout


@_posix_only
def test_factory_reset_block_is_a_silent_no_op_on_a_box_that_never_had_it(tmp_path):
    sbin, units, state = tmp_path / "sbin", tmp_path / "units", tmp_path / "state"
    sbin.mkdir()
    units.mkdir()                                   # nothing installed, no state dir
    shim_log = tmp_path / "reset.log"
    block = (_reset_block()
             .replace("/usr/local/sbin", str(sbin))
             .replace("/etc/systemd/system", str(units))
             .replace(STATE_DIR, str(state)))
    prelude = (
        "set -euo pipefail\n"
        "log_success() { printf 'OK: %s\\n' \"$*\"; }\n"
        "sudo() { \"$@\"; }\n"
        "systemctl() { printf 'systemctl %s\\n' \"$*\" >> \"$SHIM_LOG\"; }\n"
    )
    proc = _run_section(prelude + block, env={**os.environ, "SHIM_LOG": str(shim_log)})
    assert proc.returncode == 0, proc.stderr
    assert _log_lines(shim_log) == []
    assert proc.stdout == ""


# ---------------------------------------------------------------------------
# units: only what the wiring depends on (content is pinned by their own suites)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("unit", ON_DEMAND_UNITS + (GUARD_UNITS[1],))
def test_units_that_are_never_enabled_have_no_install_section(unit):
    # The installer neither enables nor boot-starts these; an [Install] section
    # would invite someone to.
    assert not re.search(r"^\[Install\]", _unit_text(unit), re.M)


@pytest.mark.parametrize("unit,wanted_by", [
    ("droplet-nvr-guard.service", "multi-user.target"),
    ("droplet-nvr-guard-release.timer", "timers.target"),
])
def test_units_the_installer_enables_have_an_install_section(unit, wanted_by):
    text = _unit_text(unit)
    assert re.search(r"^\[Install\]", text, re.M)
    assert re.search(r"^WantedBy={}$".format(re.escape(wanted_by)), text, re.M)


@pytest.mark.parametrize("unit,script", [
    ("droplet-nvr-storage-apply.service", "droplet-nvr-storage-apply.sh"),
    ("droplet-nvr-migrate.service", "droplet-nvr-migrate.sh"),
    ("droplet-nvr-guard.service", "droplet-nvr-guard.sh"),
    ("droplet-nvr-guard-release.service", "droplet-nvr-guard.sh"),
])
def test_unit_exec_start_runs_a_script_the_installer_installs(unit, script):
    execs = re.findall(r"^Exec(?:Start|Stop)=-?(/\S+)", _unit_text(unit), re.M)
    assert "/usr/local/sbin/{}".format(script) in execs
    installed = {"/usr/local/sbin/{}".format(s) for s in _installer_scripts()}
    for path in execs:
        if path.startswith("/usr/local/sbin/"):
            assert path in installed, "{} runs {} which the installer does not install".format(
                unit, path)


@pytest.mark.parametrize("unit", NVR_UNITS)
def test_units_with_the_repo_root_placeholder_are_substituted_by_the_installer(unit):
    # `@REPO_ROOT@` is only ever resolved by the installer's sed — and only for
    # units in its loop.
    if "@REPO_ROOT@" in _unit_text(unit):
        assert unit in _installer_units()
