"""Pytest fixtures — fake sounddevice modules + fake sysfs roots so
the device-discovery logic can be unit-tested without real audio
hardware on the developer's box.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make the service's module path importable from tests/ regardless of
# which directory pytest runs from.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _FakeSoundDevice:
    """Stand-in for the `sounddevice` module.

    Constructed with a list of device dicts (matching what real
    `sounddevice.query_devices()` returns on Linux) + a hostapi list.
    """

    def __init__(self, devices, hostapis=None):
        self._devices = devices
        self._hostapis = hostapis or [{"name": "ALSA"}]

    def query_devices(self):
        return self._devices

    def query_hostapis(self):
        return self._hostapis


def make_sysfs(
    tmp_path: Path, cards: dict[int, str],
) -> Path:
    """Build a fake `/sys/class/sound` tree.

    `cards` maps card number → bus type. Bus type drives which sysfs
    files we materialise:
      - "usb"      → card N/device/idVendor present
      - "pci"      → card N/device resolves into .../pci.../
      - "platform" → card N/device resolves into .../platform/...
      - "unknown"  → card N/device exists but no markers
    """
    sys_root = tmp_path / "sys_class_sound"
    sys_root.mkdir(parents=True, exist_ok=True)
    for n, bus in cards.items():
        card_dir = sys_root / f"card{n}"
        card_dir.mkdir(exist_ok=True)
        if bus == "usb":
            device_dir = tmp_path / f"usb-card{n}"
            device_dir.mkdir(exist_ok=True)
            (device_dir / "idVendor").write_text("1234\n")
            (device_dir / "idProduct").write_text("5678\n")
            (card_dir / "device").symlink_to(device_dir)
        elif bus == "pci":
            # Real Linux path contains colons (pci0000:00 / 0000:00:1f.3),
            # but Windows filesystems can't create those — use safe names
            # that still preserve the `/pci` substring detect_bus() looks
            # for. The function checks `"/pci" in real_str` only.
            pci_dir = tmp_path / "devices" / "pci0000-00" / "0000-00-1f-3" / f"snd-card{n}"
            pci_dir.mkdir(parents=True, exist_ok=True)
            (card_dir / "device").symlink_to(pci_dir)
        elif bus == "platform":
            plat_dir = tmp_path / "devices" / "platform" / f"snd-codec-{n}"
            plat_dir.mkdir(parents=True, exist_ok=True)
            (card_dir / "device").symlink_to(plat_dir)
        else:
            unknown_dir = tmp_path / f"unknown-card{n}"
            unknown_dir.mkdir(exist_ok=True)
            (card_dir / "device").symlink_to(unknown_dir)
    return sys_root


@pytest.fixture
def make_sounddevice():
    """Factory that builds a _FakeSoundDevice with the given device list."""
    def _make(devices, hostapis=None):
        return _FakeSoundDevice(devices, hostapis)
    return _make


@pytest.fixture
def make_sysfs_root(tmp_path):
    """Factory that builds a /sys/class/sound tree for the given cards."""
    def _make(cards):
        return make_sysfs(tmp_path, cards)
    return _make


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Ensure VOICE_* env vars don't leak between tests."""
    for k in (
        "VOICE_INPUT_DEVICE",
        "VOICE_OUTPUT_DEVICE",
        "VOICE_SAMPLE_RATE",
    ):
        monkeypatch.delenv(k, raising=False)
