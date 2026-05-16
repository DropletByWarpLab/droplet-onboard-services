"""Audio device discovery + scoring.

The voice service runs on a deliberately wide range of hardware:

  - POC dev box       — x86, onboard Realtek ALC662 + optional USB headset
  - POC + ReSpeaker   — same box plus a 4-mic USB array (the intended POC)
  - Production v2.6   — Jetson + I/O-Brick I²S codec (TBD)
  - Generic Linux box — any USB headset

We can't hardcode any of them. Instead we enumerate ALSA devices at
runtime, cross-reference each card with `/sys/class/sound/cardN/` to
discover its bus type (USB vs PCI vs platform), score every candidate
for voice use, and pick the highest-scored input + output.

Env overrides (`VOICE_INPUT_DEVICE` / `VOICE_OUTPUT_DEVICE`) skip the
scoring entirely — useful when an operator wants to pin specific
hardware in production. See README §"Device-selection algorithm".

The whole module is *importable* even when `sounddevice` / PortAudio
isn't installed (helps tests run without the system audio stack); the
fallback paths return empty device lists rather than raising.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("voice.devices")

# Lazy sounddevice import. The module's importable on systems without
# PortAudio so the tests + the FastAPI route handlers can run.
try:
    import sounddevice as _sd  # type: ignore[import-not-found]
except (ImportError, OSError):  # pragma: no cover — host without PortAudio
    _sd = None  # type: ignore[assignment]


# ────────────────────────────────────────────────────────────────────
# Data
# ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AudioDevice:
    """Snapshot of one ALSA device the host exposes."""

    index: int                          # sounddevice's internal index
    name: str                           # e.g. "HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)"
    max_input_channels: int             # >0 means it can be a mic
    max_output_channels: int            # >0 means it can be a speaker
    default_samplerate: float
    hostapi_name: str                   # "ALSA" on Linux
    bus: str                            # "usb" | "pci" | "platform" | "unknown"
    card_number: Optional[int]          # ALSA card N, parsed from name
    score_as_input: int                 # higher = better mic candidate
    score_as_output: int                # higher = better speaker candidate

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DeviceResolution:
    """Result of `resolve_devices()` — what got picked and why."""

    input_device: Optional[AudioDevice]
    output_device: Optional[AudioDevice]
    input_source: str   # "auto" | "env-override" | "none-available"
    output_source: str
    all_devices: list[AudioDevice] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "input": self.input_device.to_dict() if self.input_device else None,
            "output": self.output_device.to_dict() if self.output_device else None,
            "input_source": self.input_source,
            "output_source": self.output_source,
            "all": [d.to_dict() for d in self.all_devices],
        }


# ────────────────────────────────────────────────────────────────────
# Scoring rules — explicit & overridable.
# ────────────────────────────────────────────────────────────────────

# Patterns are matched case-insensitive against device names.
_INPUT_NAME_BONUS = [
    (re.compile(r"respeaker|seeed", re.I), 250),     # ReSpeaker family
    (re.compile(r"mic\.?\s*array", re.I), 200),      # generic "mic array"
    (re.compile(r"webcam|c920|brio", re.I), 120),    # webcams have decent mics
    (re.compile(r"headset", re.I), 110),
    (re.compile(r"\bmic(rophone)?\b", re.I), 60),
]

_INPUT_NAME_PENALTY = [
    (re.compile(r"hdmi", re.I), -300),               # HDMI is output-only in practice
    (re.compile(r"loopback|monitor of|null", re.I), -200),
]

_OUTPUT_NAME_BONUS = [
    (re.compile(r"respeaker|seeed", re.I), 80),
    (re.compile(r"speaker|headphone", re.I), 60),
]

_OUTPUT_NAME_PENALTY = [
    (re.compile(r"hdmi", re.I), -100),               # not driving monitors as speakers
    (re.compile(r"loopback|null", re.I), -200),
]


# ────────────────────────────────────────────────────────────────────
# Bus discovery — reads /sys/class/sound to distinguish USB from PCI.
# ────────────────────────────────────────────────────────────────────

_CARD_NUMBER_RE = re.compile(r"hw:(\d+)", re.I)


def parse_card_number(device_name: str) -> Optional[int]:
    """Extract ALSA card number from a sounddevice device name.

    sounddevice's device names typically end with `(hw:N,M)` on Linux —
    the `N` is the ALSA card index we use to look up `/sys/class/sound/cardN`.
    """
    m = _CARD_NUMBER_RE.search(device_name or "")
    return int(m.group(1)) if m else None


_USB_CONTROLLER_RE = re.compile(r"^usb\d+$")


def detect_bus(
    card_number: Optional[int], sys_root: Path = Path("/sys/class/sound"),
) -> str:
    """Return "usb" / "pci" / "platform" / "unknown" for an ALSA card.

    Linux sysfs path structure on a real box (verified on POC droplet-sys):

      USB device:
        /sys/class/sound/card3 -> ../../devices/pci0000:00/0000:00:08.1/
                                       0000:17:00.4/usb5/5-2/5-2:1.0/sound/card3

      Pure PCI device:
        /sys/class/sound/card1 -> ../../devices/pci0000:00/0000:00:08.1/
                                       0000:17:00.1/sound/card1

      Platform-bus codec (Jetson I/O Brick, etc.):
        /sys/class/sound/card0 -> ../../devices/platform/snd-codec/sound/card0

    The card/device symlink resolves into the *interface* node for USB
    devices (e.g. `5-2:1.0`), which doesn't carry `idVendor` itself —
    that lives a couple of levels up at the USB device root. So instead
    of looking up the file tree, we check the resolved path's
    components: a `usbN` controller in the chain means it's a USB
    device regardless of whatever PCI host adapter the controller sits
    on. Platform > PCI fall-through in the same way.
    """
    if card_number is None:
        return "unknown"
    card_dir = sys_root / f"card{card_number}"
    if not card_dir.exists():
        return "unknown"

    device_link = card_dir / "device"
    if not device_link.exists():
        return "unknown"

    try:
        real = device_link.resolve()
    except (OSError, RuntimeError):  # pragma: no cover — broken symlink
        return "unknown"

    parts = real.parts
    # USB controller component (`usb1`, `usb5`, etc.) anywhere in the
    # chain → USB device. Wins over the PCI host adapter the controller
    # may sit on, which is what we want.
    if any(_USB_CONTROLLER_RE.match(p) for p in parts):
        return "usb"
    if "platform" in parts:
        return "platform"
    if any(p.startswith("pci") for p in parts):
        return "pci"
    return "unknown"


# ────────────────────────────────────────────────────────────────────
# Scoring
# ────────────────────────────────────────────────────────────────────

def score_input(name: str, bus: str, max_input_channels: int) -> int:
    """Score a candidate input device. Higher = better mic.

    Returns 0 for non-input devices; the caller filters those out
    rather than calling this on them.
    """
    if max_input_channels <= 0:
        return 0
    score = 0
    if bus == "usb":
        score += 200
    elif bus == "platform":
        score += 80          # I²S codec on Jetson production — likely the
                             # intended primary device.
    # bus == "pci" gets 0 baseline — onboard codecs are typical but not
    # special-cased up unless their name says otherwise.

    for pat, bonus in _INPUT_NAME_BONUS:
        if pat.search(name):
            score += bonus
            break  # only the highest-tier bonus stacks
    for pat, penalty in _INPUT_NAME_PENALTY:
        if pat.search(name):
            score += penalty
    return score


def score_output(name: str, bus: str, max_output_channels: int) -> int:
    """Score a candidate output device. Higher = better speaker."""
    if max_output_channels <= 0:
        return 0
    score = 0
    if bus == "usb":
        score += 150
    elif bus == "platform":
        score += 80
    for pat, bonus in _OUTPUT_NAME_BONUS:
        if pat.search(name):
            score += bonus
            break
    for pat, penalty in _OUTPUT_NAME_PENALTY:
        if pat.search(name):
            score += penalty
    return score


# ────────────────────────────────────────────────────────────────────
# Enumeration
# ────────────────────────────────────────────────────────────────────

def enumerate_devices(
    sys_root: Path = Path("/sys/class/sound"),
    sd_module: Any = None,
) -> list[AudioDevice]:
    """Return one AudioDevice per ALSA device the host exposes.

    `sd_module` is dependency-injected so tests can pass a fake. In
    production it defaults to the real `sounddevice` module (lazily
    imported at module load).
    """
    mod = sd_module if sd_module is not None else _sd
    if mod is None:
        logger.warning(
            "sounddevice unavailable — no audio device discovery possible",
        )
        return []

    try:
        raw = mod.query_devices()
        hostapis = mod.query_hostapis()
    except Exception as exc:  # pragma: no cover — PortAudio init failure
        logger.warning("sounddevice query failed: %s", exc)
        return []

    devices: list[AudioDevice] = []
    for index, d in enumerate(raw):
        name = d.get("name", "")
        max_in = int(d.get("max_input_channels", 0))
        max_out = int(d.get("max_output_channels", 0))
        if max_in == 0 and max_out == 0:
            # Some hostapis list "loopback" entries with 0/0 — skip.
            continue
        hostapi_idx = d.get("hostapi", 0)
        hostapi_name = (
            hostapis[hostapi_idx]["name"] if hostapi_idx < len(hostapis) else "unknown"
        )
        card_n = parse_card_number(name)
        bus = detect_bus(card_n, sys_root=sys_root)
        devices.append(
            AudioDevice(
                index=index,
                name=name,
                max_input_channels=max_in,
                max_output_channels=max_out,
                default_samplerate=float(d.get("default_samplerate", 0) or 0),
                hostapi_name=hostapi_name,
                bus=bus,
                card_number=card_n,
                score_as_input=score_input(name, bus, max_in),
                score_as_output=score_output(name, bus, max_out),
            ),
        )
    return devices


# ────────────────────────────────────────────────────────────────────
# Resolution — pick the actual input + output.
# ────────────────────────────────────────────────────────────────────

def _find_by_override(
    devices: list[AudioDevice], override: str, kind: str,
) -> Optional[AudioDevice]:
    """Resolve a `VOICE_*_DEVICE` env override to an AudioDevice.

    Accepts:
      - An integer string → index into the device list
      - Anything else → substring match against the device name
        (case-insensitive). Useful for `hw:2,0` or `ReSpeaker`.

    Returns None if the override doesn't match anything; the caller
    falls back to auto-pick + emits a warning.
    """
    if not override:
        return None
    if override.isdigit():
        idx = int(override)
        for d in devices:
            if d.index == idx:
                return d
        logger.warning(
            "VOICE_%s_DEVICE=%s did not match any device index",
            kind.upper(), override,
        )
        return None
    needle = override.lower()
    for d in devices:
        if needle in d.name.lower():
            return d
    logger.warning(
        "VOICE_%s_DEVICE=%r did not match any device name (substring)",
        kind.upper(), override,
    )
    return None


def resolve_devices(
    env: Optional[dict[str, str]] = None,
    sys_root: Path = Path("/sys/class/sound"),
    sd_module: Any = None,
) -> DeviceResolution:
    """Pick the input + output devices we'll actually use.

    `env` lets tests inject a synthetic os.environ. Production passes
    `None` and we read `os.environ` directly.
    """
    e = env if env is not None else os.environ
    devs = enumerate_devices(sys_root=sys_root, sd_module=sd_module)

    inputs = [d for d in devs if d.max_input_channels > 0]
    outputs = [d for d in devs if d.max_output_channels > 0]

    # Input.
    input_override = e.get("VOICE_INPUT_DEVICE", "").strip()
    if input_override:
        picked_input = _find_by_override(inputs, input_override, "input")
        input_source = "env-override" if picked_input else "none-available"
    else:
        picked_input = None
        input_source = "none-available"

    if picked_input is None and not input_override:
        if inputs:
            # Highest score wins; ties broken by lowest index for
            # determinism (so the same device gets picked across runs).
            picked_input = sorted(
                inputs, key=lambda d: (-d.score_as_input, d.index),
            )[0]
            input_source = "auto"

    # Output.
    output_override = e.get("VOICE_OUTPUT_DEVICE", "").strip()
    if output_override:
        picked_output = _find_by_override(outputs, output_override, "output")
        output_source = "env-override" if picked_output else "none-available"
    else:
        picked_output = None
        output_source = "none-available"

    if picked_output is None and not output_override:
        if outputs:
            picked_output = sorted(
                outputs, key=lambda d: (-d.score_as_output, d.index),
            )[0]
            output_source = "auto"

    if picked_input is None:
        logger.warning(
            "No mic detected. Voice loop will start in no-mic mode; "
            "hot-plug a USB mic and re-run /audio/devices.",
        )
    if picked_output is None:
        logger.warning(
            "No speaker detected. test-tone + TTS playback will fail "
            "until one is plugged in.",
        )

    return DeviceResolution(
        input_device=picked_input,
        output_device=picked_output,
        input_source=input_source,
        output_source=output_source,
        all_devices=devs,
    )
