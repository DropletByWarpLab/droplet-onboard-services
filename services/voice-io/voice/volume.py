"""Speaker output volume: the gain math, the persisted {level, muted}
state, and the one controller every volume surface shares.

Mechanism: software gain on the int16 PCM right before playback
(WakePipeline._play_pcm → audio_io.play). Not a hardware mixer: it
behaves the same on every output (XVF3800, onboard codec, USB headset,
HDMI), survives a DSP reboot or USB re-enumeration, and needs no
privileges. The cost is headroom — digital gain can only attenuate, so
level 100 is exactly today's unity output and "louder than today" is not
something this layer can do.

  level_to_gain(level) = (level / 100) ** 2

A squared curve because loudness is roughly logarithmic: 50 → 0.25
(-12 dB), 10 → 0.01 (-40 dB). Never above 1.0, so it cannot clip.

State lives in an explicit JSON file on the `voice-calibration` named
volume (/data, the same one VoiceEnabledStore and CalibrationStore use),
so it survives container restarts and a factory reset sweeps it back to
the default. The file is `{"level": <int 0-100>, "muted": <bool>}`:

  - ABSENT reads as level 100, unmuted. That is the upgrade path — a box
    that never had a volume sounds exactly as it did before this module.
  - Anything else it cannot read (OSError, bad JSON, wrong types, an
    out-of-range level) ALSO reads as level 100 unmuted, but carries a
    user-facing fault. The polarity is the opposite of the voice kill
    switch on purpose: a storage fault must never make the assistant go
    quiet without anybody choosing it. The two ways to silence it are
    `muted: true` and an explicitly requested level 0.

`mute` never touches the level, so unmute restores exactly what was
there. Asking for a level (absolute or relative) unmutes — someone who
says "turn it up" to a muted box wants to hear the answer.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger("voice.volume")

# Default lives under the compose-mounted named volume (`voice-calibration`
# → /data). Override via VOICE_VOLUME_PATH (tests point it at tmp_path).
DEFAULT_VOLUME_PATH = "/data/voice-volume.json"

LEVEL_MIN = 0
LEVEL_MAX = 100
# 100 == unity == the output every box had before volume existed.
DEFAULT_LEVEL = LEVEL_MAX


def clamp_level(level: int) -> int:
    return max(LEVEL_MIN, min(LEVEL_MAX, int(level)))


def level_to_gain(level: int) -> float:
    """Amplitude multiplier for a 0-100 level: (level/100)^2, clamped.
    100 is exactly 1.0."""
    return (clamp_level(level) / LEVEL_MAX) ** 2


def apply_gain(pcm: np.ndarray, gain: float) -> np.ndarray:
    """Scale int16 PCM by `gain` (capped to 0..1), returning int16 of
    the same shape.

    int16 in and out on purpose: this sits in front of audio_io.play,
    whose resampling fallback is written for int16. Unity returns the
    input object untouched, so level 100 is byte-identical to the
    pre-volume output.
    """
    if pcm.dtype != np.int16:
        raise TypeError(f"apply_gain expects int16 PCM, got {pcm.dtype}")
    gain = min(max(float(gain), 0.0), 1.0)
    if gain == 1.0:
        return pcm
    if gain == 0.0:
        return np.zeros_like(pcm)
    # Attenuation only, so the result always fits int16 — the clip is a
    # belt for rounding at full scale, not a limiter.
    scaled = np.rint(pcm.astype(np.float32) * gain)
    return np.clip(scaled, -32768, 32767).astype(np.int16)


@dataclass(frozen=True)
class VolumeState:
    level: int
    muted: bool


_DEFAULT_STATE = VolumeState(level=DEFAULT_LEVEL, muted=False)


class VolumeStore:
    """JSON-file persistence for {level, muted}. Same posture as
    VoiceEnabledStore: cheap to construct, path from the env each time."""

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = Path(
            path
            or (os.environ.get("VOICE_VOLUME_PATH") or "").strip()
            or DEFAULT_VOLUME_PATH,
        )

    def read(self) -> tuple[VolumeState, Optional[str]]:
        """The persisted state, plus a user-facing fault when it could not
        be read. Absent → default with no fault; unreadable → the same
        audible default WITH a fault (see the module docstring)."""
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return _DEFAULT_STATE, None
        except OSError as exc:
            return self._fault(str(exc))
        except ValueError as exc:  # UnicodeDecodeError
            return self._fault(f"it is not valid UTF-8 ({exc})")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            return self._fault(f"it is not valid JSON ({exc})")
        if not isinstance(data, dict):
            return self._fault("it is not a JSON object")
        level = data.get("level")
        muted = data.get("muted")
        # bool is an int subclass: `true` is not a level.
        if not isinstance(level, int) or isinstance(level, bool):
            return self._fault(
                f"it carries no integer `level` (found {type(level).__name__})",
            )
        if not LEVEL_MIN <= level <= LEVEL_MAX:
            return self._fault(f"its level {level} is outside 0-100")
        if not isinstance(muted, bool):
            return self._fault(
                f"it carries no boolean `muted` (found {type(muted).__name__})",
            )
        return VolumeState(level=level, muted=muted), None

    def _fault(self, why: str) -> tuple[VolumeState, Optional[str]]:
        message = (
            f"The speaker volume setting at {self.path} could not be read: "
            f"{why}. Droplet is speaking at full volume until the volume "
            "is set again — this is a storage fault, not a setting anyone "
            "changed."
        )
        logger.error("%s", message)
        return _DEFAULT_STATE, message

    def save(self, state: VolumeState) -> None:
        """Persist atomically: sibling temp file, fsync, replace — the
        enabled.py pattern, so a crash leaves the old state or the new
        one, never a truncated file."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(self.path.parent), prefix=".voice-volume-", suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"level": state.level, "muted": state.muted}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        logger.info(
            "voice volume saved to %s: level=%d muted=%s",
            self.path, state.level, state.muted,
        )


@dataclass(frozen=True)
class VolumeChange:
    """One applied change: the state before, the state after, and the
    storage fault if the new state could not be saved (it still applies)."""

    previous: VolumeState
    current: VolumeState
    fault: Optional[str]


class VolumeController:
    """The single, thread-safe owner of the output level.

    main.py builds one at import and shares it between the HTTP endpoints
    and the wake pipeline, so a dashboard change and a spoken "turn it up"
    act on the same state, whether or not the pipeline is running.
    """

    def __init__(self, store: VolumeStore) -> None:
        self._store = store
        self._lock = threading.Lock()
        self._state, self._fault = store.read()

    def state(self) -> VolumeState:
        with self._lock:
            return self._state

    @property
    def fault(self) -> Optional[str]:
        with self._lock:
            return self._fault

    def gain(self) -> float:
        """The multiplier playback applies now: 0.0 when muted."""
        with self._lock:
            if self._state.muted:
                return 0.0
            return level_to_gain(self._state.level)

    def set_level(self, level: int) -> VolumeChange:
        return self._apply(lambda s: VolumeState(clamp_level(level), False))

    def change(self, delta: int) -> VolumeChange:
        return self._apply(
            lambda s: VolumeState(clamp_level(s.level + int(delta)), False),
        )

    def set_muted(self, muted: bool) -> VolumeChange:
        return self._apply(lambda s: VolumeState(s.level, bool(muted)))

    def _apply(
        self, update: Callable[[VolumeState], VolumeState],
    ) -> VolumeChange:
        with self._lock:
            previous = self._state
            current = update(previous)
            try:
                self._store.save(current)
                self._fault = None
            except OSError as exc:
                # Apply anyway: the person asked for this level NOW. The
                # fault tells them it will not survive a restart.
                self._fault = (
                    f"The speaker volume could not be saved to "
                    f"{self._store.path}: {exc}. The change applies now but "
                    "will be lost when voice restarts."
                )
                logger.error("%s", self._fault)
            self._state = current
            return VolumeChange(previous, current, self._fault)
