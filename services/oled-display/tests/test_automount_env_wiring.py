"""WARP-1338 — /etc/droplet/automount.env wiring + root-unit LPE guard.

The Nextcloud registration opt-in travels via /etc/droplet/automount.env,
loaded with `EnvironmentFile=` by ROOT units (droplet-automount@.service,
droplet-automount-reconcile.service, droplet-storage-pool-apply.service).
A systemd EnvironmentFile loads EVERY KEY=VALUE line of its target into the
unit's environment, so if that file were writable by the unprivileged droplet
user, a compromised bridge could inject arbitrary env into a root unit — the
exact WARP-843 local-privilege-escalation pattern
(tests/openwrt-attach-env-invariant.test.sh is the repo-wide guard; this file
pins the automount.env instance specifically).

Invariants pinned here:
  1. The units reference the env file with the non-fatal `-` prefix (a box
     provisioned before the installer ran must still automount).
  2. install.sh creates the file root:root 0644 and NEVER hands it to the
     droplet user; an operator-edited file is preserved (the opt-out), only
     ownership/mode are re-asserted.
  3. The in-script default stays NEXTCLOUD_AUTO_REGISTER=0 (deliberate
     opt-out posture) — provisioning opts in via the env file.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
AUTOMOUNT_DIR = REPO / "services" / "automount"
UNIT = AUTOMOUNT_DIR / "droplet-automount@.service"
RECONCILE_UNIT = AUTOMOUNT_DIR / "droplet-automount-reconcile.service"
INSTALL_SH = AUTOMOUNT_DIR / "install.sh"
AUTOMOUNT_SH = AUTOMOUNT_DIR / "droplet-automount.sh"
POOL_APPLY_UNIT = (
    REPO / "services" / "oled-display" / "droplet-storage-pool-apply.service"
)
ENV_PATH = "/etc/droplet/automount.env"
BASH = shutil.which("bash")


def _posix(p: Path) -> str:
    return str(p).replace("\\", "/")


class TestUnitWiring:
    def test_automount_unit_loads_the_env_file_nonfatal(self):
        text = UNIT.read_text(encoding="utf-8")
        assert f"EnvironmentFile=-{ENV_PATH}" in text, text

    def test_reconcile_unit_exists_and_is_wired(self):
        assert RECONCILE_UNIT.exists(), (
            "droplet-automount-reconcile.service missing — boot-time "
            "registration reconcile has no systemd integration"
        )
        text = RECONCILE_UNIT.read_text(encoding="utf-8")
        assert "Type=oneshot" in text, text
        assert re.search(
            r"ExecStart=.*droplet-automount\.sh reconcile", text), text
        assert f"EnvironmentFile=-{ENV_PATH}" in text, text
        # Ordered after docker (occ needs the container runtime up).
        assert "After=docker.service" in text, text
        assert "WantedBy=multi-user.target" in text, text

    def test_pool_apply_unit_loads_the_same_env_file(self):
        # droplet-storage-pool.sh registers pool mounts with Nextcloud; the
        # container name must come from the SAME env file, loaded by its
        # root apply unit.
        text = POOL_APPLY_UNIT.read_text(encoding="utf-8")
        assert f"EnvironmentFile=-{ENV_PATH}" in text, text

    def test_no_unit_declares_a_nonroot_user_for_the_env_file(self):
        # These are root units by design (mount/mdadm need root). If someone
        # later adds User=droplet AND keeps the EnvironmentFile, the LPE
        # posture flips the other way (droplet unit is fine); this pin just
        # documents the current root-unit shape the invariant reasons about.
        for unit in (UNIT, RECONCILE_UNIT, POOL_APPLY_UNIT):
            text = unit.read_text(encoding="utf-8")
            assert not re.search(r"^User=(?!root)", text, re.M), (
                f"{unit.name} grew a non-root User= — re-check the "
                "automount.env ownership reasoning"
            )


class TestInstallerEnvFile:
    """Behavioral: extract the sentinel-marked automount_env_install block
    from install.sh and run it hermetically (chown stubbed + logged — the
    test host isn't root; the assertion is on the exact invocation)."""

    def _run_install_env(self, tmp_path: Path, preexisting: str | None = None):
        env_file = tmp_path / "etc-droplet" / "automount.env"
        if preexisting is not None:
            env_file.parent.mkdir(parents=True, exist_ok=True)
            env_file.write_text(preexisting, encoding="utf-8")
        src = INSTALL_SH.read_text(encoding="utf-8")
        start = src.index("# >>> automount_env_install")
        end = src.index("# <<< automount_env_install") + len(
            "# <<< automount_env_install")
        harness = tmp_path / "env-install.sh"
        harness.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\n" + src[start:end] + "\n",
            encoding="utf-8", newline="\n")
        os.chmod(harness, 0o755)
        stub_dir = tmp_path / "stub-bin"
        stub_dir.mkdir(exist_ok=True)
        log = tmp_path / "cmd-log.txt"
        log.write_text("", encoding="utf-8")
        for tool in ("chown", "chmod"):
            stub = stub_dir / tool
            stub.write_text(
                "#!/usr/bin/env bash\n"
                f"printf '{tool} %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 0\n",
                encoding="utf-8", newline="\n")
            os.chmod(stub, 0o755)
        env = dict(os.environ)
        env.update({
            "CMD_LOG": _posix(log),
            "DROPLET_AUTOMOUNT_ENV_FILE": _posix(env_file),
            "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
        })
        proc = subprocess.run(
            [BASH, str(harness)], env=env, capture_output=True, text=True,
            timeout=60)
        cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
        content = (
            env_file.read_text(encoding="utf-8") if env_file.exists() else ""
        )
        return proc, cmds, content

    @pytest.mark.skipif(BASH is None, reason="bash not available")
    def test_creates_the_env_file_with_the_opt_in_values(self, tmp_path):
        proc, cmds, content = self._run_install_env(tmp_path)
        assert proc.returncode == 0, proc.stderr
        assert "NEXTCLOUD_AUTO_REGISTER=1" in content, content
        assert "NEXTCLOUD_CONTAINER=droplet-nextcloud-1" in content, content

    @pytest.mark.skipif(BASH is None, reason="bash not available")
    def test_asserts_root_ownership_and_0644(self, tmp_path):
        proc, cmds, _content = self._run_install_env(tmp_path)
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(r"chown root:root .*automount\.env", joined), (
            "env file not chowned root:root — a droplet-writable "
            "EnvironmentFile on a root unit is the WARP-843 LPE: %s" % joined
        )
        assert re.search(r"chmod 0?644 .*automount\.env", joined), joined

    @pytest.mark.skipif(BASH is None, reason="bash not available")
    def test_preserves_an_operator_edited_file(self, tmp_path):
        # The deliberate opt-OUT: an operator who set the register flag to 0
        # keeps that across re-provisioning; only ownership/mode re-assert.
        edited = "NEXTCLOUD_AUTO_REGISTER=0\nNEXTCLOUD_CONTAINER=droplet-nextcloud-1\n"
        proc, cmds, content = self._run_install_env(tmp_path, preexisting=edited)
        assert proc.returncode == 0, proc.stderr
        assert content == edited, content
        assert re.search(r"chown root:root .*automount\.env",
                         "\n".join(cmds)), cmds

    def test_installer_never_hands_the_env_file_to_droplet(self):
        # Static LPE pin across every provisioning script that could touch it:
        # no `chown ... droplet ...automount.env` anywhere.
        provisioning = [
            INSTALL_SH,
            REPO / "scripts" / "setup.sh",
            REPO / "scripts" / "install-device-bridge.sh",
        ]
        provisioning += sorted((REPO / "scripts" / "lib").glob("*.sh"))
        for f in provisioning:
            if not f.exists():
                continue
            for line in f.read_text(encoding="utf-8").splitlines():
                if "automount.env" in line and re.search(
                        r"\bchown\b.*\bdroplet\b", line):
                    raise AssertionError(
                        f"{f} hands automount.env to the droplet user — "
                        f"root-unit LPE (WARP-843): {line.strip()}"
                    )

    def test_installer_installs_and_enables_the_reconcile_unit(self):
        src = INSTALL_SH.read_text(encoding="utf-8")
        assert "droplet-automount-reconcile.service" in src, (
            "install.sh does not install the reconcile unit"
        )
        assert re.search(
            r"systemctl enable .*droplet-automount-reconcile", src), src


class TestOptOutDefaultPinned:
    def test_in_script_default_stays_zero(self):
        # AC: the opt-out posture is deliberate — the SCRIPT defaults to 0;
        # only provisioning's env file (a root-owned EnvironmentFile) opts in.
        src = AUTOMOUNT_SH.read_text(encoding="utf-8")
        assert 'NEXTCLOUD_AUTO_REGISTER="${NEXTCLOUD_AUTO_REGISTER:-0}"' in src

    def test_container_default_matches_the_live_compose_project(self):
        # Root cause (3) of WARP-1338: the old docker-nextcloud-1 default
        # never matched the shipping compose project name.
        src = AUTOMOUNT_SH.read_text(encoding="utf-8")
        assert 'NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-droplet-nextcloud-1}"' in src
