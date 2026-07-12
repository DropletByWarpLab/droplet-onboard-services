"""XVF3800 DSP restart over USB via the vendor `xvf_host` CLI (WARP-1057).

The ReSpeaker XVF3800's XMOS DSP has a known wedge mode: the USB audio
stream stays open while every delivered frame is pure digital silence
("listening but deaf"). Detection is WARP-1037 — the pipeline's flatline
watchdog flips `input_flatlined` and /health degrades to 503. This module
is the RECOVERY half: reboot the DSP with the exact command the host
watchdog issues (`xvf_host REBOOT 1`, scripts/host/droplet-watchdog.sh),
so the dashboard's "Restart processor" action and the watchdog share one
contract. The DSP drops off USB and re-enumerates (~10 s audio outage);
the pipeline's device self-heal (re-resolve + reopen) picks the card back
up and the flatline flag clears on the next real audio frame — no
container restart.

Env:
  XVF_HOST_PATH          — the xvf_host binary as seen inside the
                           container. Compose binds the host's
                           /usr/local/bin read-only at
                           /host/usr-local-bin and points this there, so
                           the same binary the watchdog uses is visible;
                           the bare default (/usr/local/bin/xvf_host)
                           only matters outside compose.
  XVF_RESTART_TIMEOUT_S  — subprocess deadline (default 10 s). A REBOOT
                           write is normally near-instant; a hang means
                           the USB control path itself is broken.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from typing import Any, Callable

logger = logging.getLogger("voice.dsp")

DEFAULT_XVF_HOST_PATH = "/usr/local/bin/xvf_host"
DEFAULT_RESTART_TIMEOUT_S = 10.0

# The watchdog's proven heal command — keep the two call sites identical.
REBOOT_ARGS = ("REBOOT", "1")


class DspRestartError(Exception):
    """The DSP restart could not be issued or did not complete.

    `detail` is the user-facing message the API layer relays verbatim;
    every cause is an operational fault the caller can act on (install
    the tool, check the USB path, retry), so the HTTP mapping is a
    uniform 503 — matching the rest of voice-io's fault contract.
    """

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def xvf_host_path() -> str:
    """Configured xvf_host location. Empty env = default (compose passes
    the var through as "" when unset, same convention as main.py)."""
    return (os.environ.get("XVF_HOST_PATH") or "").strip() or DEFAULT_XVF_HOST_PATH


def restart_timeout_s() -> float:
    raw = (os.environ.get("XVF_RESTART_TIMEOUT_S") or "").strip()
    try:
        value = float(raw) if raw else DEFAULT_RESTART_TIMEOUT_S
    except ValueError:
        return DEFAULT_RESTART_TIMEOUT_S
    return value if value > 0 else DEFAULT_RESTART_TIMEOUT_S


def restart_dsp(
    run: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run,
) -> dict[str, Any]:
    """Issue `xvf_host REBOOT 1`. Returns the success payload for the API
    caller; raises DspRestartError on any fault.

    `run` is injectable for tests — the real seam is one subprocess call.
    """
    path = xvf_host_path()
    # isfile guards the docker bind-mount failure shape where a missing
    # host path materialises as an (executable-bit) directory.
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise DspRestartError(
            f"The DSP restart tool isn't available at {path}. Install the "
            "vendor xvf_host CLI on this box (the host watchdog uses the "
            "same tool), then try again."
        )
    timeout = restart_timeout_s()
    try:
        proc = run(
            [path, *REBOOT_ARGS],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise DspRestartError(
            f"xvf_host REBOOT 1 timed out after {timeout:.0f}s — the USB "
            "control path to the XVF3800 isn't responding. A power cycle "
            "of the Droplet usually clears this."
        )
    except OSError as exc:
        # Exec failure past the isfile/X_OK gate (wrong arch/libc, ENOEXEC).
        raise DspRestartError(f"Couldn't execute {path}: {exc}")
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        detail = f" ({tail[-1].strip()})" if tail else ""
        raise DspRestartError(
            f"xvf_host REBOOT 1 failed (exit {proc.returncode}){detail} — "
            "check the USB connection to the XVF3800."
        )
    logger.info("issued 'xvf_host REBOOT 1' — DSP rebooting (~10s audio outage)")
    return {"ok": True, "method": "xvf_host", "restarted_at": time.time()}
