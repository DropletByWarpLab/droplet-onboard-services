"""Deterministic speaker-volume commands — the voice fast path.

`classify_volume_intent(transcript)` recognises a small, closed set of
whole-utterance volume commands so "turn it up", "volume 40 percent",
"mute" and "what's the volume" are handled locally on the box: no LLM
round trip, no orchestrator call, and they keep working when the model
is down. It is pure (no I/O, no state) and runs on every transcript
before the LLM, so it is deliberately narrow:

  * WHOLE utterance, anchored. After an optional leading wake phrase
    ("droplet", "hey droplet") and "please", and an optional trailing
    "please", the entire remaining text must be one of the patterns.
  * OBJECT-LESS. Nothing that names another thing matches: "turn up the
    thermostat", "turn the lights up", "turn down the TV", "mute the TV"
    all fall through to the normal turn (and control_device).
  * NEVER a stop word. "stop", "quiet", "be quiet", "shut up", "cancel"
    and "silence" are barge-in / stop commands, not mute — a later
    feature owns them, and mapping them here would silence the box on a
    word that means "stop talking right now".

Absolute levels: "volume 40 percent" / "volume 40%" are literal; a bare
number from 0 to 10 with no "percent" is the 0-10 scale ("volume 5" →
50), anything above 10 is a 0-100 level. Out-of-range numbers clamp.

This is not an LLM tool and adds nothing to the tool registry — it is
local device control of voice-io's own speaker, sharing the one
VolumeController the HTTP endpoints use.

Every pattern here has a row in tests/test_intents.py.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

VolumeIntentKind = Literal["set", "change", "mute", "unmute", "query"]

STEP = 10             # "turn it up", "louder"
BIG_STEP = 25         # "a lot louder", "turn it way up"
MAX_LEVEL = 100
MIN_SPOKEN_LEVEL = 10  # "minimum volume": quiet but audible, never 0


@dataclass(frozen=True)
class VolumeIntent:
    """`value` is the level for "set" and the signed step for "change";
    mute / unmute / query carry no value and leave it at 0."""

    kind: VolumeIntentKind
    value: int = 0


# ── number words, 0-100 ─────────────────────────────────────────────

_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_DIGIT_WORDS = "one|two|three|four|five|six|seven|eight|nine"
_NUMBER = (
    r"(?:\d{1,3}"
    r"|(?:a |one )?hundred"
    rf"|(?:{'|'.join(_TENS)})(?: (?:{_DIGIT_WORDS}))?"
    rf"|(?:{'|'.join(_UNITS)}))"
)


def _number_value(text: str) -> int:
    if text.isdigit():
        return int(text)
    if text.endswith("hundred"):
        return 100
    words = text.split()
    if words[0] in _TENS:
        return _TENS[words[0]] + (_UNITS[words[1]] if len(words) > 1 else 0)
    return _UNITS[words[0]]


# ── patterns (applied to normalised text) ───────────────────────────

_VERB = r"(?:set|change|turn|put|make)"
_VOLUME = r"(?:the )?volume"
_BIT = r"(?: a (?:little )?bit| a little)?"

_ABSOLUTE = (
    re.compile(
        rf"^(?:{_VERB} )?{_VOLUME}(?: level)?"
        r"(?: (?:up to|down to|to|at))?"
        rf" (?P<num>{_NUMBER})(?P<pct> percent)?$",
    ),
    re.compile(rf"^(?P<num>{_NUMBER})(?P<pct> percent) volume$"),
)

_MAX = re.compile(
    r"^(?:(?:max|maximum|full) volume"
    rf"|(?:{_VERB} )?{_VOLUME}(?: to)? (?:max|maximum)"
    rf"|turn (?:it|{_VOLUME}) all the way up)$",
)
_MIN = re.compile(
    r"^(?:(?:min|minimum|lowest) volume"
    rf"|(?:{_VERB} )?{_VOLUME}(?: to)? (?:min|minimum)"
    rf"|turn (?:it|{_VOLUME}) all the way down)$",
)

_UP = re.compile(
    rf"^(?:turn (?:it|{_VOLUME}) up{_BIT}|turn up(?: {_VOLUME})?{_BIT}"
    rf"|volume up|(?:increase|raise) {_VOLUME}"
    r"|(?:(?:a )?(?:little )?bit |a little )?louder"
    r"|speak up|(?:speak|talk) louder)$",
)
_DOWN = re.compile(
    rf"^(?:turn (?:it|{_VOLUME}) down{_BIT}|turn down(?: {_VOLUME})?{_BIT}"
    rf"|volume down|(?:decrease|reduce|lower) {_VOLUME}"
    r"|(?:(?:a )?(?:little )?bit |a little )?(?:quieter|softer)"
    r"|(?:speak|talk) (?:quieter|softer))$",
)
_BIG_UP = re.compile(
    r"^(?:(?:a lot|much|way) louder|turn it up a lot|turn it way up)$",
)
_BIG_DOWN = re.compile(
    r"^(?:(?:a lot|much|way) (?:quieter|softer)"
    r"|turn it down a lot|turn it way down)$",
)

_MUTE = re.compile(r"^mute(?: yourself| (?:the )?volume| your voice)?$")
_UNMUTE = re.compile(r"^unmute(?: yourself| (?:the )?volume| your voice)?$")

_QUERY = re.compile(
    r"^(?:what(?:'s|s| is) (?:the |your )?(?:current )?volume"
    r"(?: level| set to| at| now)?"
    r"|what volume (?:are you (?:at|on)|is it(?: set to| at)?)"
    r"|how loud are you)$",
)

_WAKE_PREFIX = re.compile(r"^(?:hey )?droplet (?:please )?")


def _normalise(transcript: str) -> str:
    text = transcript.lower()
    text = text.replace("%", " percent ")
    text = text.replace("’", "'")
    # "forty-five" → "forty five", "un-mute" → "un mute" → "unmute".
    text = text.replace("-", " ")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\bun mute\b", "unmute", text)
    text = _WAKE_PREFIX.sub("", text)
    text = re.sub(r"^please ", "", text)
    text = re.sub(r" please$", "", text)
    return text


def classify_volume_intent(transcript: str) -> Optional[VolumeIntent]:
    """The volume command in `transcript`, or None to let the normal turn
    (intent gate + LLM) handle it. Pure — safe from any thread."""
    if not transcript:
        return None
    text = _normalise(transcript)
    if not text:
        return None
    for pattern in _ABSOLUTE:
        m = pattern.match(text)
        if m:
            value = _number_value(m.group("num"))
            if m.group("pct") is None and value <= 10:
                value *= 10
            return VolumeIntent("set", min(value, MAX_LEVEL))
    if _MAX.match(text):
        return VolumeIntent("set", MAX_LEVEL)
    if _MIN.match(text):
        return VolumeIntent("set", MIN_SPOKEN_LEVEL)
    if _BIG_UP.match(text):
        return VolumeIntent("change", BIG_STEP)
    if _BIG_DOWN.match(text):
        return VolumeIntent("change", -BIG_STEP)
    if _UP.match(text):
        return VolumeIntent("change", STEP)
    if _DOWN.match(text):
        return VolumeIntent("change", -STEP)
    if _MUTE.match(text):
        return VolumeIntent("mute")
    if _UNMUTE.match(text):
        return VolumeIntent("unmute")
    if _QUERY.match(text):
        return VolumeIntent("query")
    return None
