"""
Voice service state machine.

Five states:
  - idle        — no audio capture, no playback. Mic LED off.
  - listening   — actively capturing audio for STT (after PTT or wake).
  - processing  — captured audio is being transcribed + handed to the
                  orchestrator. Mic is closed in this state.
  - speaking    — TTS audio is being played back. Mic remains closed
                  to avoid the speaker bleeding back into the mic and
                  triggering a feedback loop.
  - muted       — operator pressed the hardware mute. Mic VDD is cut
                  (via the GPIO MOSFET on the production unit). The
                  service refuses POST /listen / POST /speak in this
                  state and the red LED is lit. Only POST /unmute can
                  return to idle.

Transitions are guarded so the state never lands in an inconsistent
combination (e.g. you can't go from speaking → listening directly
without passing through idle, which gives the speaker time to drain).
"""

from __future__ import annotations

import logging
import threading
from enum import Enum
from typing import Callable

logger = logging.getLogger("voice.state")


class State(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"
    MUTED = "muted"


_VALID_TRANSITIONS: dict[State, set[State]] = {
    State.IDLE:       {State.LISTENING, State.SPEAKING, State.MUTED},
    State.LISTENING:  {State.PROCESSING, State.IDLE, State.MUTED},
    State.PROCESSING: {State.IDLE, State.SPEAKING, State.MUTED},
    State.SPEAKING:   {State.IDLE, State.MUTED},
    State.MUTED:      {State.IDLE},
}


class StateMachine:
    """Thread-safe state holder with transition validation + a listener
    callback. The HTTP layer's GET /state reads from here; the
    `set_state` operations are called by the listen / speak / mute
    handlers."""

    def __init__(self, initial: State = State.IDLE):
        self._state = initial
        self._lock = threading.RLock()
        self._listeners: list[Callable[[State, State], None]] = []

    @property
    def current(self) -> State:
        with self._lock:
            return self._state

    def on_change(self, listener: Callable[[State, State], None]) -> None:
        """Register a callback fired on every transition. Used by the
        GPIO layer to drive the mute LED, and by tests to assert
        sequence."""
        with self._lock:
            self._listeners.append(listener)

    def set(self, new: State) -> None:
        """Transition to `new`. Raises ValueError if the transition isn't
        in the allowed graph."""
        with self._lock:
            if new == self._state:
                return
            allowed = _VALID_TRANSITIONS.get(self._state, set())
            if new not in allowed:
                raise ValueError(
                    f"invalid transition {self._state.value} -> {new.value}; "
                    f"allowed: {sorted(s.value for s in allowed)}"
                )
            old = self._state
            self._state = new
            logger.info("state: %s -> %s", old.value, new.value)
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(old, new)
            except Exception as exc:
                logger.warning("state listener raised: %s", exc)

    def force(self, new: State) -> None:
        """Bypass transition validation. Used by the mute path so the
        operator can always reach the muted state regardless of what's
        currently in flight."""
        with self._lock:
            old = self._state
            if old == new:
                return
            self._state = new
            logger.info("state: %s -> %s (forced)", old.value, new.value)
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(old, new)
            except Exception as exc:
                logger.warning("state listener raised: %s", exc)
