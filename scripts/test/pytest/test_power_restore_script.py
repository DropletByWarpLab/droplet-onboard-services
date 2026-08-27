"""Hermetic tests for the power-loss auto-restart host script (WARP-2190).

scripts/host/usr-local-sbin/droplet-power-restore pokes a HARDWARE register -
the AMD FCH PwrFailShadow field at PM[0x5B] bits[1:0], the bit the BIOS
"Restore on AC/Power Loss" option drives. Getting the register window wrong
means writing a policy byte into an unknown register on a live board, so the
unit under test here is mostly the SAFETY behaviour:

  * it refuses to write at all unless PM[0x64] (the spec-fixed ACPI PM-timer
    block address) matches the PM_TMR_BLK the firmware published in the FADT;
  * it read-modify-writes, never clobbering the bits firmware owns;
  * it verifies bits[1:0] ONLY, because on real silicon bits[5:4] mirror
    bits[1:0] (observed: wrote 0x45, read back 0x55);
  * the RTC backstop is armed independently of whether the register write
    succeeded - that is exactly when the backstop matters.

Driven via subprocess with DROPLET_POWER_RESTORE_MEM / _FADT / _RTC pointed at
fixture files, so nothing here touches /dev/mem or real sysfs. The fake
"/dev/mem" is a SPARSE file: we pwrite at the true physical offset
(0xFED80300 + reg) so the offset arithmetic under test is the real thing, while
only a couple of blocks are actually allocated.
"""

from __future__ import annotations

import os
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "usr-local-sbin" / "droplet-power-restore"
)

# Must match the constants in the script - deliberately duplicated rather than
# imported, so a silent edit to either one fails the test.
PM_BLOCK = 0xFED80300
PM_RTC_SHADOW = 0x5B
PM_TMR_BLK_OFF = 0x64
FADT_PM_TMR_BLK_OFFSET = 76

# The value observed on the real board: bits[1:0]=00 (always-off), other bits
# owned by firmware and expected to survive our read-modify-write.
REAL_ALWAYS_OFF_BYTE = 0x44
PM_TIMER_PORT = 0x808

# The fixture writes at the true physical offset, which only stays cheap on a
# filesystem with sparse-file support. On NTFS the same pwrite would allocate
# ~4 GB, so keep this lane POSIX-only rather than ambushing a Windows dev.
pytestmark = pytest.mark.skipif(
    os.name != "posix",
    reason="drives a POSIX host script and needs sparse-file support",
)


def _write_mem(path: Path, reg: int, value: int) -> None:
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.pwrite(fd, bytes([value]), PM_BLOCK + reg)
    finally:
        os.close(fd)


def _write_mem16(path: Path, reg: int, value: int) -> None:
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.pwrite(fd, struct.pack("<H", value), PM_BLOCK + reg)
    finally:
        os.close(fd)


def _read_mem(path: Path, reg: int) -> int:
    fd = os.open(path, os.O_RDONLY)
    try:
        return os.pread(fd, 1, PM_BLOCK + reg)[0]
    finally:
        os.close(fd)


@pytest.fixture
def hw(tmp_path: Path):
    """A fake board: PM block + FADT that agree, and an unarmed RTC alarm."""
    mem = tmp_path / "mem"
    fadt = tmp_path / "FACP"
    rtc = tmp_path / "wakealarm"

    _write_mem16(mem, PM_TMR_BLK_OFF, PM_TIMER_PORT)
    _write_mem(mem, PM_RTC_SHADOW, REAL_ALWAYS_OFF_BYTE)

    table = bytearray(FADT_PM_TMR_BLK_OFFSET + 4)
    struct.pack_into("<I", table, FADT_PM_TMR_BLK_OFFSET, PM_TIMER_PORT)
    fadt.write_bytes(bytes(table))

    rtc.write_text("0\n")
    return {"mem": mem, "fadt": fadt, "rtc": rtc}


def _run(hw, *args, horizon: str | None = None):
    env = dict(os.environ)
    env.update({
        "DROPLET_POWER_RESTORE_MEM": str(hw["mem"]),
        "DROPLET_POWER_RESTORE_FADT": str(hw["fadt"]),
        "DROPLET_POWER_RESTORE_RTC": str(hw["rtc"]),
    })
    if horizon is not None:
        env["DROPLET_POWER_RESTORE_RTC_HORIZON_SEC"] = horizon
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env, capture_output=True, text=True, timeout=60,
    )


def test_sets_always_on_and_preserves_firmware_bits(hw):
    """0x44 -> 0x45: bits[1:0] become 01, every other bit survives."""
    res = _run(hw)
    assert res.returncode == 0, res.stdout + res.stderr

    got = _read_mem(hw["mem"], PM_RTC_SHADOW)
    assert got & 0b11 == 0b01, "PwrFailShadow should be always-on, got 0x%02X" % got
    assert got & ~0b11 == REAL_ALWAYS_OFF_BYTE & ~0b11, (
        "read-modify-write clobbered firmware-owned bits: 0x%02X -> 0x%02X"
        % (REAL_ALWAYS_OFF_BYTE, got)
    )


def test_refuses_to_write_when_pm_block_selfcheck_fails(hw):
    """The positive control: a window that isn't the PM block must be refused.

    This is the check that stops us writing a policy byte into an unknown
    register on unfamiliar silicon, so it has to actually fire.
    """
    # Firmware says the PM timer is somewhere else than the window claims.
    table = bytearray(FADT_PM_TMR_BLK_OFFSET + 4)
    struct.pack_into("<I", table, FADT_PM_TMR_BLK_OFFSET, 0x0600)
    hw["fadt"].write_bytes(bytes(table))

    res = _run(hw)
    assert res.returncode != 0
    assert "self-check FAILED" in res.stdout
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) == REAL_ALWAYS_OFF_BYTE, (
        "register was modified despite a failed self-check"
    )


def test_selfcheck_rejects_a_zero_pm_timer(hw):
    """An all-zero FADT field must not be allowed to 'match' an empty window."""
    hw["fadt"].write_bytes(bytes(FADT_PM_TMR_BLK_OFFSET + 4))
    _write_mem16(hw["mem"], PM_TMR_BLK_OFF, 0)

    res = _run(hw)
    assert res.returncode != 0
    assert "self-check FAILED" in res.stdout


def test_idempotent_when_already_always_on(hw):
    _write_mem(hw["mem"], PM_RTC_SHADOW, 0x55)  # bits[1:0]=01, plus the mirror
    res = _run(hw)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "no write needed" in res.stdout
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) == 0x55


def test_arms_rtc_backstop_at_the_configured_horizon(hw):
    before = int(time.time())
    res = _run(hw, horizon="900")
    assert res.returncode == 0, res.stdout + res.stderr

    armed = int(hw["rtc"].read_text().strip())
    assert before + 900 <= armed <= int(time.time()) + 900


def test_rtc_backstop_can_be_disabled(hw):
    res = _run(hw, horizon="0")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "RTC backstop disabled" in res.stdout
    assert hw["rtc"].read_text().strip() == "0", "alarm armed despite horizon=0"


def test_rtc_is_armed_even_when_the_register_write_fails(hw):
    """The two mechanisms are independent on purpose."""
    hw["fadt"].write_bytes(bytes(FADT_PM_TMR_BLK_OFFSET + 4))  # force selfcheck fail

    res = _run(hw, horizon="900")
    assert res.returncode != 0
    assert int(hw["rtc"].read_text().strip()) > 0, (
        "backstop was skipped in exactly the case it exists for"
    )


def test_missing_rtc_node_is_not_fatal(hw):
    hw["rtc"].unlink()
    res = _run(hw)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "RTC backstop unavailable" in res.stdout
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) & 0b11 == 0b01


def test_status_is_read_only(hw):
    res = _run(hw, "--status")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "always-off" in res.stdout
    assert "not armed" in res.stdout
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) == REAL_ALWAYS_OFF_BYTE
    assert hw["rtc"].read_text().strip() == "0"


def test_bad_horizon_falls_back_instead_of_dying(hw):
    res = _run(hw, horizon="not-a-number")
    assert res.returncode == 0, res.stdout + res.stderr
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) & 0b11 == 0b01
    assert int(hw["rtc"].read_text().strip()) > 0


def test_unknown_argument_is_rejected(hw):
    res = _run(hw, "--wipe-everything")
    assert res.returncode == 2
    assert _read_mem(hw["mem"], PM_RTC_SHADOW) == REAL_ALWAYS_OFF_BYTE
