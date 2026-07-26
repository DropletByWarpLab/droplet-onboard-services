"""Persisted voice on/off flag — the admin kill switch (WARP-1599).

An owner/admin can turn the assistant OFF from the dashboard. "Off" is
not a mute and not a suppression window (that's calibration mode,
WARP-1059, which keeps the capture stream open): it is deliberately
entering the same pipeline-absent state a mic-less box boots into — no
wake pipeline, no worker thread, no open mic stream, so nothing reads
PCM at all. And unlike a mic-less boot it STICKS: the flag lands here as
a small JSON file so it survives container restarts and recreates
(compose mounts the `voice-calibration` named volume at /data, the same
one CalibrationStore and the voiceprints use).

On-box file, not Postgres — deliberate. voice-io has to honour the
switch inside its OWN startup path, before the orchestrator, the
database, or anything else in the stack is necessarily up; a box that
boots faster than its DB must not spend that window listening.

An absent, corrupt, unreadable, or non-boolean file reads as ENABLED.
That is a back-compat default, not a safety preference: boxes upgrading
into WARP-1599 have no flag file and must keep listening exactly as they
did before. The file only ever says "off" because an admin said so —
POST /voice/enabled is its single writer, and a value we can't read as a
real boolean is not evidence of anyone's intent.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger("voice.enabled")

# Default lives under the compose-mounted named volume (`voice-calibration`
# → /data) so the switch survives container restarts + recreates.
# Override via VOICE_ENABLED_PATH (tests point it at tmp_path).
DEFAULT_ENABLED_PATH = "/data/voice-enabled.json"


class VoiceEnabledStore:
    """JSON-file persistence for the voice on/off flag.

    Same posture as CalibrationStore: construction is cheap and reads
    the env each time, so handlers can build a fresh store per request
    (no stale module-level path when the env changes between tests).
    """

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = Path(
            path
            or (os.environ.get("VOICE_ENABLED_PATH") or "").strip()
            or DEFAULT_ENABLED_PATH,
        )

    def load(self) -> bool:
        """True when the assistant may listen.

        Every shape this can't read with confidence returns True — see
        the module docstring for why "unknown" means "keep listening"
        rather than "stay silent".
        """
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return True
        except OSError as exc:
            logger.warning("voice-enabled file %s unreadable: %s", self.path, exc)
            return True
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning(
                "voice-enabled file %s is corrupt — assuming enabled", self.path,
            )
            return True
        enabled = data.get("enabled") if isinstance(data, dict) else None
        if not isinstance(enabled, bool):
            logger.warning(
                "voice-enabled file %s carries no boolean `enabled` — "
                "assuming enabled",
                self.path,
            )
            return True
        return enabled

    def save(self, enabled: bool) -> None:
        """Persist atomically: write a sibling temp file, then replace.

        A crash mid-write leaves either the old flag or the new one on
        disk — never a truncated half-JSON, which load() would read as
        "enabled" and silently re-arm a mic the admin just switched off.
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(self.path.parent), prefix=".voice-enabled-", suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"enabled": enabled}, f)
                # fsync before the rename — same old-or-new guarantee as
                # CalibrationStore.save: without it, ext4's delayed
                # allocation can commit the rename ahead of the data and
                # a crash leaves an EMPTY file.
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        logger.info("voice enabled flag saved to %s: %s", self.path, enabled)
