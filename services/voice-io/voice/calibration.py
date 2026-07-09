"""Persisted mic-calibration record (WARP-1055).

The dashboard's calibration wizard measures the room (noise floor,
speech peak, wake responsiveness, echo check) and applies ONE write:
POST /voice/calibration. The record lands here as a small JSON file so
it survives container restarts (compose mounts a named volume at
/data), and main.py re-applies the tuned input gain + wake threshold
over the env defaults at every startup.

The store is deliberately dumb — a dict in, the same dict out. Schema
validation belongs to main.py's pydantic request model; keeping the
store schema-free means old records never brick a newer service (any
unknown fields ride along, missing ones read as absent).
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("voice.calibration")

# Default lives under the compose-mounted named volume (`voice-calibration`
# → /data) so a calibration survives container restarts + recreates.
# Override via VOICE_CALIBRATION_PATH (tests point it at tmp_path).
DEFAULT_CALIBRATION_PATH = "/data/calibration.json"


class CalibrationStore:
    """JSON-file persistence for the calibration record.

    Construction is cheap and reads the env each time, so handlers can
    build a fresh store per request (no stale module-level path when
    the env changes between tests).
    """

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = Path(
            path
            or (os.environ.get("VOICE_CALIBRATION_PATH") or "").strip()
            or DEFAULT_CALIBRATION_PATH,
        )

    def load(self) -> Optional[dict[str, Any]]:
        """Return the persisted record, or None when there isn't one.

        A corrupt or unreadable file reads as "not calibrated" rather
        than raising — the wizard can always re-calibrate over it.
        """
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as exc:
            logger.warning("calibration file %s unreadable: %s", self.path, exc)
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("calibration file %s is corrupt — ignoring", self.path)
            return None
        if not isinstance(data, dict):
            logger.warning(
                "calibration file %s holds %s, not an object — ignoring",
                self.path, type(data).__name__,
            )
            return None
        return data

    def save(self, record: dict[str, Any]) -> None:
        """Persist atomically: write a sibling temp file, then replace.

        A crash mid-write leaves either the old record or the new one
        on disk — never a truncated half-JSON that load() would then
        treat as "not calibrated".
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(self.path.parent), prefix=".calibration-", suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2)
                # Push the bytes to disk BEFORE the rename — without the
                # fsync, ext4's delayed allocation can commit the rename
                # ahead of the data and a crash leaves an EMPTY file,
                # breaking the old-or-new guarantee claimed above.
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        logger.info("calibration saved to %s", self.path)
