"""Guards for the hardware watchdog wiring (WARP-2192).

The hardware watchdog is configuration, not code, and its failure mode is
**silence**: if any one piece is missing the box simply has no watchdog, while
every file on disk still reads correctly and nothing logs an error. Three ways
to get that silence, each guarded here:

  * no `sp5100_tco` in modules-load.d  -> /dev/watchdog never exists, because
    systemd does not load watchdog drivers itself;
  * no `RuntimeWatchdogSec` drop-in    -> PID1 never opens or pets the device
    (the setting is `off` by default);
  * `daemon-reload` instead of `daemon-reexec` in the installer -> system.conf
    is only read by PID1 at startup, so the setting stays inert on a provision
    run while the file on disk looks correct.

These are static assertions over the shipped files. They cannot prove the
watchdog arms on real silicon — that needs the board (see scripts/host/README
for the boot_id procedure) — but they do stop a refactor from quietly deleting
half the mechanism.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MODULES_CONF = REPO / "scripts" / "host" / "etc-modules-load.d" / "droplet-watchdog-hw.conf"
SYSTEMD_CONF = (
    REPO / "scripts" / "host" / "etc-systemd-system.conf.d" / "droplet-watchdog.conf"
)
INSTALLER = REPO / "scripts" / "lib" / "single-box.sh"


def _uncommented(path: Path) -> list[str]:
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def _shell_code(path: Path) -> str:
    """Installer source with whole-line comments stripped.

    Every assertion below must run against THIS, not the raw file. These blocks
    are heavily commented and the comments name the very commands being
    asserted on, so a raw substring search is satisfied by prose — the guard
    then passes even after the real command is deleted. Caught by mutation:
    rewriting `daemon-reexec` to `daemon-reload` left the test green because
    the word survived in the comment explaining why reexec is required.
    """
    return "\n".join(_uncommented(path))


def test_modules_load_actually_names_the_driver():
    assert MODULES_CONF.is_file(), f"{MODULES_CONF} is missing"
    assert "sp5100_tco" in _uncommented(MODULES_CONF), (
        "modules-load.d fragment must name sp5100_tco on an uncommented line — "
        "systemd does not load watchdog drivers itself, so without it "
        "/dev/watchdog never appears and the watchdog is a silent no-op"
    )


def test_runtime_watchdog_is_set_and_nonzero():
    assert SYSTEMD_CONF.is_file(), f"{SYSTEMD_CONF} is missing"
    body = SYSTEMD_CONF.read_text(encoding="utf-8")
    assert "[Manager]" in body, "drop-in must carry the [Manager] section header"

    match = re.search(r"^RuntimeWatchdogSec=(\S+)", body, re.MULTILINE)
    assert match, "RuntimeWatchdogSec is not set — PID1 would never pet the device"

    value = match.group(1)
    assert value not in ("0", "off", "no"), (
        "RuntimeWatchdogSec=%s disables the watchdog entirely" % value
    )
    seconds = int(re.sub(r"(s|sec)$", "", value))
    # systemd pets at HALF this value. Too tight and a transient stall reboots a
    # healthy appliance; too loose and a real hang sits there.
    assert 30 <= seconds <= 600, (
        "RuntimeWatchdogSec=%ds is outside the sane band (30-600); systemd pets "
        "at half this, so a short value risks spurious reboots" % seconds
    )


def test_installer_ships_both_halves():
    """Either half missing makes the whole thing a silent no-op."""
    body = _shell_code(INSTALLER)
    assert "etc-modules-load.d/droplet-watchdog-hw.conf" in body, (
        "single-box.sh does not install the modules-load fragment"
    )
    assert "etc-systemd-system.conf.d/droplet-watchdog.conf" in body, (
        "single-box.sh does not install the RuntimeWatchdogSec drop-in"
    )


def test_installer_reexecs_rather_than_only_reloading():
    """system.conf is read by PID1 at startup; daemon-reload does not apply it."""
    body = _shell_code(INSTALLER)
    assert "daemon-reexec" in body, (
        "single-box.sh must `systemctl daemon-reexec` after writing the "
        "system.conf.d drop-in — a plain daemon-reload leaves RuntimeWatchdogSec "
        "inert while the file on disk looks correct"
    )


def test_installer_loads_the_module_on_this_run():
    """modules-load.d only fires at boot, so a provision run must modprobe."""
    body = _shell_code(INSTALLER)
    assert re.search(r"modprobe\s+sp5100_tco", body), (
        "single-box.sh must modprobe sp5100_tco so the watchdog is live on the "
        "provision run itself, not only after the next reboot"
    )


def test_watchdog_config_files_are_lf_pinned():
    """A trailing CR silently breaks both parsers — see .gitattributes."""
    attrs = (REPO / ".gitattributes").read_text(encoding="utf-8")
    for pattern in (
        "scripts/host/etc-modules-load.d/*",
        "scripts/host/etc-systemd-system.conf.d/*",
    ):
        assert f"{pattern} text eol=lf" in attrs, (
            f"{pattern} is not pinned to LF; a CR would make modules-load look "
            "for a module named 'sp5100_tco\\r' and systemd parse "
            "'RuntimeWatchdogSec=120\\r'"
        )
