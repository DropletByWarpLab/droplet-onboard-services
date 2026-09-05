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

An ABSENT file reads as ENABLED. That is a back-compat default, not a
safety preference: boxes upgrading into WARP-1599 have no flag file and
must keep listening exactly as they did before.

Every OTHER shape this cannot read — an OSError, a corrupt or empty
body, undecodable bytes, a non-boolean value — reads as DISABLED
(WARP-1620). POST /voice/enabled is the file's single writer, so the
file only ever EXISTS because an admin wrote it, and a read that fails
is not evidence they changed their mind. It is evidence that we cannot
tell, and for a kill switch "cannot tell" has to resolve to OFF: this
box has a documented root-filesystem failure history (WARP-1501), and
reading a read-only remount or an I/O error as "keep listening" turns a
storage fault into an unannounced privacy change in someone's home.

Absence and unreadability are therefore NOT the same signal, and this is
the one place in the codebase where the "never derive state from
absence" rule is inverted on purpose: absence is a legitimate, writable-
by-nobody signal here; unreadability must never be treated as absence.

Failing closed silently would trade one lie for another, so `read()`
returns the decision AND the fault behind it. A box that went quiet
because of a storage fault says so — /voice/status carries the fault as
`error_message` and the capture endpoints quote it in their 409 — rather
than leaving an owner to believe they switched voice off themselves.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("voice.enabled")

# Default lives under the compose-mounted named volume (`voice-calibration`
# → /data) so the switch survives container restarts + recreates.
# Override via VOICE_ENABLED_PATH (tests point it at tmp_path).
DEFAULT_ENABLED_PATH = "/data/voice-enabled.json"


@dataclass(frozen=True)
class VoiceEnabledState:
    """The switch's value, and — when it could not be read — why.

    `fault` is None on exactly the two shapes the reader can trust: an
    absent file (nobody ever wrote one) and a real JSON boolean. Every
    other shape carries `enabled=False` AND a fault string, and the two
    always travel together on purpose: a caller cannot surface the
    silence without also having the reason for it to hand.

    The fault text is user-facing. It reaches the /voice page as
    `error_message` and the capture endpoints' 409 detail, so it names
    the file and the reason in a sentence an owner can act on without
    reading a container log.
    """

    enabled: bool
    fault: Optional[str] = None


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

    def read(self) -> VoiceEnabledState:
        """The switch, plus the fault if the switch could not be read.

        Exactly two shapes are trusted (see the module docstring):

          - the file is ABSENT      → enabled, no fault (the upgrade path)
          - it holds a JSON boolean → that boolean, no fault

        Anything else is a fault and resolves to DISABLED.
        """
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            # Nobody ever wrote a flag. The ONE indeterminate-looking
            # state that is not indeterminate at all: the single writer
            # has never run, so there is no admin decision to honour and
            # the pre-WARP-1599 behaviour (listening) is correct.
            return VoiceEnabledState(enabled=True)
        except OSError as exc:
            # The WARP-1501 family: EACCES, EIO, ESTALE, EROFS, and a
            # path that is not a file. An admin wrote this flag; the
            # volume — not the admin — is what changed.
            return self._fault(str(exc))
        except ValueError as exc:
            # UnicodeDecodeError on binary residue. It is a ValueError,
            # NOT an OSError, so before WARP-1620 it escaped this method
            # entirely: a 500 out of the capture guard and an unhandled
            # exception out of the startup hook, rather than a decision.
            return self._fault(f"it is not valid UTF-8 ({exc})")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            # Covers the empty file too — the exact residue of a
            # truncated write. save() fsyncs before its rename so this
            # shape cannot be produced here, but a failing disk can
            # still hand it back on the way out.
            return self._fault(f"it is not valid JSON ({exc})")
        enabled = data.get("enabled") if isinstance(data, dict) else None
        if not isinstance(enabled, bool):
            # A hand-edited `"false"` string is no more evidence of an
            # admin's intent than an I/O error is — and "not evidence of
            # intent" resolves to OFF. The wire agrees by refusing the
            # same value: POST /voice/enabled takes StrictBool, so a
            # string is a 422 there and a fault here. Neither layer
            # guesses; they just have different ways of saying so.
            return self._fault(
                "it carries no boolean `enabled` "
                f"(found {type(enabled).__name__})",
            )
        return VoiceEnabledState(enabled=enabled)

    def load(self) -> bool:
        """True when the assistant may listen.

        The boolean half of `read()`, for callers that only gate on the
        switch. Callers that must tell an owner WHY the box is silent —
        /voice/status and the capture guard — use `read()` instead.
        """
        return self.read().enabled

    def _fault(self, why: str) -> VoiceEnabledState:
        """Fail closed, and say so — in one place, once per read.

        ERROR, not WARNING: the box is refusing to listen for a reason
        nobody chose, and that is not routine. Logged at the same rate
        the old WARNING was (once per unreadable read), so a polled
        /voice/status cannot turn a fault into a log flood any faster
        than it already could.
        """
        message = (
            f"The voice-enabled flag at {self.path} could not be read: "
            f"{why}. Voice fails closed on a switch it cannot read, so "
            "the microphone stays off until the flag is readable again "
            "— this is a storage fault, not a setting anyone changed."
        )
        logger.error("%s", message)
        return VoiceEnabledState(enabled=False, fault=message)

    def save(self, enabled: bool) -> None:
        """Persist atomically: write a sibling temp file, then replace.

        A crash mid-write leaves either the old flag or the new one on
        disk — never a truncated half-JSON. Since WARP-1620 that residue
        would fail closed rather than re-arm the mic, so the atomicity
        no longer guards a privacy failure; it guards the OTHER half of
        the switch, which is just as load-bearing. Without it a crash
        during "turn voice ON" leaves a box that reads its own flag as a
        fault and stays deaf until someone notices.
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
