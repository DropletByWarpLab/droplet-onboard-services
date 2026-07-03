"""KAN-8 — SDK semantics for the router firmware upgrade + factory-reset path.

These wrap the `openwrt/scripts/upgrade-router.sh` semantics behind typed
`SystemApi` methods so the routing service (and the orchestrator above it) never
shell out to a parallel box script — the brick-risk dispatch goes through the
SAME `file.exec` ubus surface the rest of the SDK already uses.

DANGER SURFACE. `sysupgrade` and `jffs2reset` can brick the device. This file
proves ONLY the dispatch shape (which command + flags get issued), the version
compare read, and that a transport loss mid-flash maps to the typed
`ConnectionLost` the upgrade script tolerates (the router reboots and the SSH/ubus
connection drops — that is the EXPECTED success path of a flash, not an error to
surface). It NEVER runs against a real device.

Gating to the PRIMARY_ROUTER deployment shape and the owner-only Tier-3 confirm
live ABOVE this layer (the routing route + the orchestrator); the SDK is the raw
mechanism.
"""

from __future__ import annotations

import pytest

from droplet_openwrt_sdk import (
    ConnectionLost,
    SystemApi,
    UbusError,
    compare_firmware_version,
)


class _RecordingRouter:
    """Captures the `file.exec` calls SystemApi issues so we can assert the
    exact command + params the upgrade-router.sh semantics map to, without a
    real ubus transport.

    Mirrors how the rest of the SDK dispatches a privileged action
    (`exec_command` → `file.exec`); the recorder stands in for that one seam.
    """

    def __init__(
        self,
        *,
        board: dict | None = None,
        raise_on_exec: Exception | None = None,
        raise_on_command: tuple[str, Exception] | None = None,
    ):
        self.exec_calls: list[tuple[str, list[str] | None]] = []
        self._board = board or {
            "model": "Droplet Router",
            "board_name": "droplet,router-v2-6",
            "release": {"distribution": "OpenWrt", "version": "24.10.0"},
        }
        # raise_on_exec: raise for EVERY exec (models a fault on the first call).
        # raise_on_command: raise only for one command, e.g. ("reboot", exc) —
        # needed for multi-exec flows like factory_reset (jffs2reset then reboot)
        # where only the reboot is expected to drop the connection.
        self._raise_on_exec = raise_on_exec
        self._raise_on_command = raise_on_command

    def exec_command(self, command: str, params: list[str] | None = None) -> dict:
        self.exec_calls.append((command, params))
        if self._raise_on_command is not None and command == self._raise_on_command[0]:
            raise self._raise_on_command[1]
        if self._raise_on_exec is not None:
            raise self._raise_on_exec
        return {"code": 0, "stdout": "", "stderr": ""}

    # SystemApi.board_info() reads through this in the real SDK.
    def _call(self, obj: str, method: str, args: dict | None = None) -> dict:
        assert (obj, method) == ("system", "board")
        return self._board


# ---------------------------------------------------------------------------
# Firmware version compare (read-only — AC 4)
# ---------------------------------------------------------------------------


class TestCompareFirmwareVersion:
    def test_up_to_date_when_running_matches_pinned(self) -> None:
        result = compare_firmware_version(
            board={"release": {"version": "24.10.0"}},
            pinned_image="openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz",
        )
        assert result["current_version"] == "24.10.0"
        assert result["pinned_version"] == "24.10.0"
        assert result["up_to_date"] is True
        assert result["upgrade_available"] is False

    def test_upgrade_available_when_pinned_is_newer(self) -> None:
        result = compare_firmware_version(
            board={"release": {"version": "23.05.5"}},
            pinned_image="openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz",
        )
        assert result["current_version"] == "23.05.5"
        assert result["pinned_version"] == "24.10.0"
        assert result["up_to_date"] is False
        # An explicit boolean, never inferred from the absence of a match (rule 10).
        assert result["upgrade_available"] is True

    def test_pinned_version_unknown_when_image_name_has_no_version(self) -> None:
        # A pinned image whose name carries no parseable version must NOT be
        # guessed equal to the running one — the compare is explicitly undetermined.
        result = compare_firmware_version(
            board={"release": {"version": "24.10.0"}},
            pinned_image="custom-build-sysupgrade.img.gz",
        )
        assert result["current_version"] == "24.10.0"
        assert result["pinned_version"] is None
        assert result["up_to_date"] is None
        assert result["upgrade_available"] is None

    def test_reads_version_from_board_release_block(self) -> None:
        # board_info() shape: the version lives under release.version, not at top
        # level — the helper must read the SAME field /system/info exposes.
        api = SystemApi(_RecordingRouter())
        check = api.firmware_version_check(
            pinned_image="openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz"
        )
        assert check["current_version"] == "24.10.0"
        assert check["pinned_version"] == "24.10.0"
        assert check["up_to_date"] is True
        # Pure read — no exec issued.
        assert api._r.exec_calls == []  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# sysupgrade dispatch (AC 1)
# ---------------------------------------------------------------------------


class TestSysupgradeDispatch:
    def test_dispatches_sysupgrade_preserving_config_by_default(self) -> None:
        router = _RecordingRouter()
        api = SystemApi(router)
        api.sysupgrade("/tmp/openwrt-24.10.0-droplet-sysupgrade.img.gz")

        assert len(router.exec_calls) == 1
        command, params = router.exec_calls[0]
        assert command == "sysupgrade"
        assert params is not None
        # -v verbose (matches upgrade-router.sh SYSUPGRADE_OPTS) and the image
        # path; NO -n, because config preservation is the default.
        assert "-n" not in params
        assert params[-1] == "/tmp/openwrt-24.10.0-droplet-sysupgrade.img.gz"

    def test_no_preserve_passes_dash_n(self) -> None:
        # upgrade-router.sh --no-preserve → `sysupgrade -v -n` (clean flash).
        router = _RecordingRouter()
        api = SystemApi(router)
        api.sysupgrade("/tmp/img.gz", preserve_config=False)

        _command, params = router.exec_calls[0]
        assert params is not None
        assert "-n" in params

    def test_rejects_empty_image_path_without_dispatching(self) -> None:
        router = _RecordingRouter()
        api = SystemApi(router)
        with pytest.raises(ValueError):
            api.sysupgrade("")
        # Brick-safety: a bad arg must never reach file.exec.
        assert router.exec_calls == []

    def test_flash_connection_drop_is_expected_not_an_error(self) -> None:
        # The router reboots as it flashes; the ubus/SSH connection drops. That
        # is the SUCCESS path of a sysupgrade, so a ConnectionLost during dispatch
        # must be swallowed (the caller learns success via the reboot), not raised.
        router = _RecordingRouter(raise_on_exec=ConnectionLost("router rebooting"))
        api = SystemApi(router)
        # Does not raise.
        result = api.sysupgrade("/tmp/img.gz")
        assert result["status"] == "flashing"

    def test_real_ubus_fault_propagates(self) -> None:
        # A genuine fault BEFORE the reboot (e.g. PERMISSION_DENIED — the ACL
        # doesn't grant file.exec) is a real failure and must surface, not be
        # masked as a "flashing" success.
        router = _RecordingRouter(raise_on_exec=UbusError(6, "Permission denied"))
        api = SystemApi(router)
        with pytest.raises(UbusError):
            api.sysupgrade("/tmp/img.gz")


# ---------------------------------------------------------------------------
# factory_reset dispatch (AC 1) — the most dangerous surface
# ---------------------------------------------------------------------------


class TestFactoryResetDispatch:
    def test_dispatches_jffs2reset_and_reboot(self) -> None:
        router = _RecordingRouter()
        api = SystemApi(router)
        api.factory_reset()

        commands = [c for c, _ in router.exec_calls]
        # jffs2reset wipes the overlay (UCI defaults); the reboot makes it take
        # effect — the exact upgrade-router.sh-adjacent reset semantics.
        assert "jffs2reset" in commands

    def test_connection_drop_during_reset_is_expected(self) -> None:
        # factory_reset runs jffs2reset (must succeed) THEN reboot. Only the
        # reboot is expected to drop the connection; that ConnectionLost is the
        # success path and is swallowed. A jffs2reset fault would (correctly)
        # propagate, so raise ONLY on the reboot call.
        router = _RecordingRouter(
            raise_on_command=("reboot", ConnectionLost("rebooting"))
        )
        api = SystemApi(router)
        result = api.factory_reset()
        assert result["status"] == "resetting"
        # Both steps were dispatched, in order.
        assert [c[0] for c in router.exec_calls] == ["jffs2reset", "reboot"]

    def test_connection_drop_during_jffs2reset_propagates(self) -> None:
        # A transport loss during the overlay WIPE is not the success path — the
        # reset may be incomplete, so it must surface rather than be masked as a
        # "resetting" success. Only the reboot phase tolerates a drop.
        router = _RecordingRouter(
            raise_on_command=("jffs2reset", ConnectionLost("dropped mid-wipe"))
        )
        api = SystemApi(router)
        with pytest.raises(ConnectionLost):
            api.factory_reset()

    def test_real_ubus_fault_propagates(self) -> None:
        router = _RecordingRouter(raise_on_exec=UbusError(6, "Permission denied"))
        api = SystemApi(router)
        with pytest.raises(UbusError):
            api.factory_reset()
