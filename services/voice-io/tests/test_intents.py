"""The deterministic volume fast path's classifier (voice/intents.py).

`classify_volume_intent(transcript)` decides — with no LLM, no network
and no state — whether a post-wake transcript is a whole-utterance,
object-less speaker-volume command. It runs before the LLM on every
turn, so it is the one place a wrong match steals a command meant for
another device. The table below is therefore mostly NEGATIVES: anything
naming another object ("turn up the thermostat", "turn the TV down"),
anything that is a stop/barge-in word ("stop", "quiet", "shut up"), and
anything partial must fall through to the normal turn.

Every pattern added to intents.py gets a row here.
"""
from __future__ import annotations

import pytest

from voice.intents import (
    BIG_STEP,
    MAX_LEVEL,
    MIN_SPOKEN_LEVEL,
    STEP,
    VolumeIntent,
    classify_volume_intent,
)


def test_constants():
    assert (STEP, BIG_STEP, MAX_LEVEL, MIN_SPOKEN_LEVEL) == (10, 25, 100, 10)


# ────────────────────────────────────────────────────────────────────
# Absolute levels
# ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("transcript", "level"),
    [
        # Percent is always literal.
        ("volume 40 percent", 40),
        ("Volume 40%.", 40),
        ("volume 40 %", 40),
        ("Set volume to 40 percent.", 40),
        ("set the volume to 40%", 40),
        ("volume 5 percent", 5),
        ("volume 10 percent", 10),
        ("40 percent volume", 40),
        # A bare number above 10 is a 0-100 level.
        ("volume 40", 40),
        ("Volume, 40.", 40),
        ("set volume to 40", 40),
        ("set the volume to 75", 75),
        ("change the volume to 60", 60),
        ("volume to 30", 30),
        ("volume at 30", 30),
        ("put the volume at 20", 20),
        ("turn the volume to 55", 55),
        ("turn the volume up to 60", 60),
        ("turn volume down to 20", 20),
        ("volume level 45", 45),
        ("volume 100", 100),
        ("volume 11", 11),
        # 0-10 with no "percent" is the 0-10 scale (Alexa-style).
        ("volume 5", 50),
        ("Volume 5.", 50),
        ("set volume to 5", 50),
        ("volume 1", 10),
        ("volume 10", 100),
        ("volume 0", 0),
        # Spoken number words (Whisper writes small numbers as words).
        ("volume five", 50),
        ("Volume three.", 30),
        ("volume zero", 0),
        ("volume ten", 100),
        ("volume forty", 40),
        ("volume forty five", 45),
        ("volume forty-five", 45),
        ("volume twenty five percent", 25),
        ("volume fifteen", 15),
        ("set the volume to seventy", 70),
        ("volume one hundred", 100),
        ("volume a hundred percent", 100),
        # Out of range is clamped, not refused.
        ("volume 150", 100),
        ("volume 150 percent", 100),
        # Wake phrase, courtesy, punctuation and case are tolerated.
        ("Droplet, volume 40 percent.", 40),
        ("hey droplet volume 40", 40),
        ("Hey Droplet, set volume to 5, please.", 50),
        ("volume 40 please", 40),
        ("please set the volume to 40", 40),
        ("droplet please volume 30", 30),
    ],
)
def test_absolute_levels(transcript, level):
    assert classify_volume_intent(transcript) == VolumeIntent("set", level)


# ────────────────────────────────────────────────────────────────────
# Relative steps
# ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("transcript", "delta"),
    [
        ("turn it up", 10),
        ("Turn it up.", 10),
        ("Droplet, turn it up.", 10),
        ("hey droplet turn it up please", 10),
        ("turn it up a bit", 10),
        ("turn it up a little", 10),
        ("turn it up a little bit", 10),
        ("turn up", 10),
        ("turn up the volume", 10),
        ("turn the volume up", 10),
        ("turn volume up", 10),
        ("volume up", 10),
        ("louder", 10),
        ("Louder!", 10),
        ("a bit louder", 10),
        ("a little louder", 10),
        ("a little bit louder", 10),
        ("bit louder", 10),
        ("speak up", 10),
        ("speak louder", 10),
        ("talk louder", 10),
        ("increase the volume", 10),
        ("raise the volume", 10),
        ("increase volume", 10),
        ("turn it down", -10),
        ("turn it down a bit", -10),
        ("turn down", -10),
        ("turn down the volume", -10),
        ("turn the volume down", -10),
        ("volume down", -10),
        ("quieter", -10),
        ("Quieter, please.", -10),
        ("softer", -10),
        ("a bit quieter", -10),
        ("a little softer", -10),
        ("speak quieter", -10),
        ("speak softer", -10),
        ("talk softer", -10),
        ("lower the volume", -10),
        ("lower volume", -10),
        ("decrease the volume", -10),
        ("reduce the volume", -10),
        # Big steps.
        ("a lot louder", 25),
        ("much louder", 25),
        ("way louder", 25),
        ("turn it up a lot", 25),
        ("turn it way up", 25),
        ("a lot quieter", -25),
        ("much quieter", -25),
        ("a lot softer", -25),
        ("much softer", -25),
        ("turn it down a lot", -25),
        ("turn it way down", -25),
    ],
)
def test_relative_steps(transcript, delta):
    assert classify_volume_intent(transcript) == VolumeIntent("change", delta)


# ────────────────────────────────────────────────────────────────────
# Extremes
# ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("transcript", "level"),
    [
        ("max volume", 100),
        ("maximum volume", 100),
        ("full volume", 100),
        ("volume max", 100),
        ("volume maximum", 100),
        ("volume to max", 100),
        ("set volume to maximum", 100),
        ("set the volume to max", 100),
        ("turn it all the way up", 100),
        ("turn the volume all the way up", 100),
        # "Minimum" is quiet but audible — the only ways to silence are
        # "mute" and an explicit "volume 0".
        ("minimum volume", 10),
        ("min volume", 10),
        ("volume min", 10),
        ("volume minimum", 10),
        ("set volume to minimum", 10),
        ("lowest volume", 10),
        ("turn it all the way down", 10),
    ],
)
def test_extremes(transcript, level):
    assert classify_volume_intent(transcript) == VolumeIntent("set", level)


# ────────────────────────────────────────────────────────────────────
# Mute / unmute / query
# ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "transcript",
    [
        "mute",
        "Mute.",
        "Droplet, mute.",
        "mute yourself",
        "mute the volume",
        "mute volume",
        "mute your voice",
        "mute please",
    ],
)
def test_mute(transcript):
    assert classify_volume_intent(transcript) == VolumeIntent("mute")


@pytest.mark.parametrize(
    "transcript",
    [
        "unmute",
        "Unmute.",
        "Un-mute.",
        "un mute",
        "Droplet, unmute.",
        "unmute yourself",
        "unmute the volume",
        "unmute your voice",
    ],
)
def test_unmute(transcript):
    assert classify_volume_intent(transcript) == VolumeIntent("unmute")


@pytest.mark.parametrize(
    "transcript",
    [
        "what's the volume",
        "What's the volume?",
        "what is the volume",
        "whats the volume",
        "what's your volume",
        "what's the current volume",
        "what is the volume level",
        "what's the volume set to",
        "what's the volume at",
        "what's the volume now",
        "what volume are you at",
        "what volume are you on",
        "what volume is it",
        "what volume is it set to",
        "how loud are you",
        "Droplet, what's the volume?",
    ],
)
def test_query(transcript):
    assert classify_volume_intent(transcript) == VolumeIntent("query")


# ────────────────────────────────────────────────────────────────────
# Negatives — these MUST fall through to the normal turn
# ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "transcript",
    [
        # Another device's object: belongs to control_device / the LLM.
        "turn up the thermostat",
        "turn the thermostat up",
        "turn the lights up",
        "turn up the lights",
        "turn up the heat",
        "turn the heat down",
        "turn down the TV",
        "turn the TV down",
        "turn the volume up on the TV",
        "turn up the volume on the tv",
        "TV volume 40",
        "set the TV volume to 40",
        "turn up the music",
        "mute the TV",
        "unmute the tv",
        "set the thermostat to 40",
        "turn it up to 22 degrees",
        "turn it up to 40",
        "make the lights louder",
        "is the tv louder than you",
        # Stop / barge-in words are NOT mute (a later feature owns them).
        "stop",
        "Stop.",
        "quiet",
        "Quiet!",
        "be quiet",
        "quiet please",
        "shut up",
        "cancel",
        "silence",
        "never mind",
        "Droplet, stop.",
        # Partial / ambiguous / unrelated.
        "volume",
        "the volume",
        "louder than that",
        "what's the weather",
        "what time is it",
        "hey droplet",
        "droplet",
        "",
        "   ",
        "volume up 5",
        "max",
        "turn",
        "up",
        "mutex",
        "muted",
        "why are you so loud",
    ],
)
def test_negatives_fall_through(transcript):
    assert classify_volume_intent(transcript) is None


def test_none_input():
    assert classify_volume_intent(None) is None  # type: ignore[arg-type]
