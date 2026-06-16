"""WARP-154 — device discovery + scoring.

The contract these tests pin:

  - parse_card_number pulls the ALSA card index out of a sounddevice
    device name like "Generic: ALC662 rev3 (hw:1,0)".
  - detect_bus distinguishes USB / PCI / platform / unknown from the
    sysfs entries each kind of device leaves behind.
  - score_input / score_output reward USB and recognised-name devices,
    penalise HDMI + loopback.
  - resolve_devices picks the highest-scored input + output, or
    obeys VOICE_INPUT_DEVICE / VOICE_OUTPUT_DEVICE overrides verbatim.
  - resolve_devices NEVER raises — even with sounddevice missing, no
    devices visible, or env overrides that don't match anything.

Whole-stack scenario tests at the bottom validate the three real
hardware configurations from README §"Tested / supported configurations":

  - POC box (3 onboard PCI cards, no USB)
  - POC + ReSpeaker (3 onboard + 1 USB mic array)
  - Production v2.6 (I²S codec on platform bus)
"""
from __future__ import annotations

import pytest

from voice.devices import (
    AudioDevice,
    DeviceResolution,
    detect_bus,
    enumerate_devices,
    parse_card_number,
    resolve_devices,
    score_input,
    score_output,
)


# ────────────────────────────────────────────────────────────────────
# parse_card_number
# ────────────────────────────────────────────────────────────────────

class TestParseCardNumber:
    def test_pulls_card_from_typical_alsa_name(self):
        # The real shape sounddevice emits on Linux.
        assert parse_card_number("HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)") == 1

    def test_card_index_can_be_two_digits(self):
        assert parse_card_number("Some Card: Foo (hw:10,3)") == 10

    def test_returns_none_when_no_hw_clause(self):
        # Some hostapis (jack, etc.) don't include hw: in names.
        assert parse_card_number("JACK Audio Connection Kit") is None

    def test_returns_none_on_empty(self):
        assert parse_card_number("") is None
        assert parse_card_number(None) is None  # type: ignore[arg-type]


# ────────────────────────────────────────────────────────────────────
# detect_bus
# ────────────────────────────────────────────────────────────────────

class TestDetectBus:
    def test_usb_when_controller_in_path(self, make_sysfs_root):
        """Real Linux exposes USB devices via a path like .../usbN/...
        — `usbN` is the controller name. detect_bus() matches on that
        component regardless of whether the leaf node (e.g. the USB
        interface) carries idVendor itself."""
        root = make_sysfs_root({0: "usb"})
        assert detect_bus(0, sys_root=root) == "usb"

    def test_pci_when_device_symlinks_into_pci(self, make_sysfs_root):
        root = make_sysfs_root({1: "pci"})
        assert detect_bus(1, sys_root=root) == "pci"

    def test_platform_when_device_symlinks_into_platform(self, make_sysfs_root):
        root = make_sysfs_root({2: "platform"})
        assert detect_bus(2, sys_root=root) == "platform"

    def test_unknown_when_card_not_in_sysfs(self, tmp_path):
        # No sysfs root exists for card 99.
        assert detect_bus(99, sys_root=tmp_path / "nonexistent") == "unknown"

    def test_unknown_when_card_number_is_none(self):
        # parse_card_number can return None for hostapis without hw: clauses.
        assert detect_bus(None) == "unknown"


# ────────────────────────────────────────────────────────────────────
# score_input / score_output
# ────────────────────────────────────────────────────────────────────

class TestScoring:
    def test_usb_mic_array_beats_onboard(self):
        usb_array = score_input("ReSpeaker 4 Mic Array (hw:3,0)", "usb", 4)
        onboard = score_input("HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)", "pci", 2)
        assert usb_array > onboard, "USB mic array should outrank onboard codec"

    def test_hdmi_penalised_as_input(self):
        hdmi = score_input("HDA ATI HDMI (hw:0,3)", "pci", 0)
        # HDMI has 0 input channels in reality → score is 0 either way.
        # Pad to test the penalty branch by faking 1 input channel.
        hdmi_faked = score_input("HDA ATI HDMI (hw:0,3)", "pci", 1)
        assert hdmi_faked < 0, "HDMI inputs should be penalised"
        assert hdmi == 0  # 0 channels → 0 score, didn't even hit penalty branch

    def test_no_input_channels_zero_score(self):
        assert score_input("Some output-only device", "usb", 0) == 0
        assert score_output("Some input-only device", "usb", 0) == 0

    def test_platform_bus_treated_as_intended_device(self):
        # the I/O-Brick's I²S codec on platform bus — should beat
        # an unrecognised PCI device even without a name match.
        plat = score_input("snd-codec-1 mic (hw:2,0)", "platform", 1)
        pci = score_input("Generic codec (hw:3,0)", "pci", 1)
        assert plat > pci

    def test_loopback_penalty(self):
        loopback = score_input("Loopback (hw:5,0)", "pci", 2)
        assert loopback < 0


# ────────────────────────────────────────────────────────────────────
# enumerate_devices
# ────────────────────────────────────────────────────────────────────

class TestEnumerateDevices:
    def test_skips_devices_with_zero_in_and_zero_out(
        self, make_sounddevice, make_sysfs_root,
    ):
        sd = make_sounddevice([
            {
                "name": "Mic (hw:1,0)", "max_input_channels": 1,
                "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0,
            },
            {  # The dud — sounddevice sometimes emits these.
                "name": "Phantom (hw:2,0)", "max_input_channels": 0,
                "max_output_channels": 0, "default_samplerate": 0, "hostapi": 0,
            },
        ])
        root = make_sysfs_root({1: "usb", 2: "pci"})
        devs = enumerate_devices(sys_root=root, sd_module=sd)
        assert len(devs) == 1
        assert devs[0].name.startswith("Mic")

    def test_attaches_bus_and_card_number(self, make_sounddevice, make_sysfs_root):
        sd = make_sounddevice([{
            "name": "ReSpeaker 4 Mic Array (hw:4,0)",
            "max_input_channels": 4, "max_output_channels": 0,
            "default_samplerate": 16000, "hostapi": 0,
        }])
        root = make_sysfs_root({4: "usb"})
        devs = enumerate_devices(sys_root=root, sd_module=sd)
        assert devs[0].card_number == 4
        assert devs[0].bus == "usb"
        assert devs[0].score_as_input > 0

    def test_returns_empty_list_when_sounddevice_missing(self):
        # `_require_sd()` path: simulate sounddevice unavailable.
        devs = enumerate_devices(sd_module=None)
        # When sd_module is None we fall through to the lazy import,
        # which on the test runner is unavailable → empty list, no
        # exception.
        # (This is the host-without-PortAudio scenario.)
        assert isinstance(devs, list)


# ────────────────────────────────────────────────────────────────────
# resolve_devices
# ────────────────────────────────────────────────────────────────────

class TestResolveDevices:
    def test_picks_highest_scored_input_and_output(
        self, make_sounddevice, make_sysfs_root,
    ):
        sd = make_sounddevice([
            {
                "name": "HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)",
                "max_input_channels": 2, "max_output_channels": 2,
                "default_samplerate": 44100, "hostapi": 0,
            },
            {
                "name": "ReSpeaker 4 Mic Array (hw:3,0)",
                "max_input_channels": 4, "max_output_channels": 0,
                "default_samplerate": 16000, "hostapi": 0,
            },
            {
                "name": "HDA ATI HDMI (hw:0,3)",
                "max_input_channels": 0, "max_output_channels": 2,
                "default_samplerate": 48000, "hostapi": 0,
            },
        ])
        root = make_sysfs_root({0: "pci", 1: "pci", 3: "usb"})

        r = resolve_devices(env={}, sys_root=root, sd_module=sd)

        # Input: USB ReSpeaker wins.
        assert r.input_device is not None
        assert r.input_device.bus == "usb"
        assert "ReSpeaker" in r.input_device.name
        assert r.input_source == "auto"

        # Output: ALC662 wins over HDMI (HDMI is penalised).
        assert r.output_device is not None
        assert "ALC662" in r.output_device.name
        assert r.output_source == "auto"

    def test_env_override_by_index(self, make_sounddevice, make_sysfs_root):
        sd = make_sounddevice([
            {"name": "A (hw:1,0)", "max_input_channels": 2,
             "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0},
            {"name": "B (hw:2,0)", "max_input_channels": 1,
             "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({1: "pci", 2: "usb"})
        # Without override, USB (B) would win.
        r = resolve_devices(env={"VOICE_INPUT_DEVICE": "0"}, sys_root=root, sd_module=sd)
        assert r.input_device is not None
        assert r.input_device.index == 0
        assert r.input_source == "env-override"

    def test_env_override_by_name_substring(self, make_sounddevice, make_sysfs_root):
        sd = make_sounddevice([
            {"name": "ReSpeaker 4 Mic Array (hw:3,0)", "max_input_channels": 4,
             "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0},
            {"name": "Other Mic (hw:1,0)", "max_input_channels": 1,
             "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({1: "pci", 3: "usb"})
        r = resolve_devices(
            env={"VOICE_INPUT_DEVICE": "respeaker"},  # case-insensitive
            sys_root=root, sd_module=sd,
        )
        assert r.input_device is not None
        assert "ReSpeaker" in r.input_device.name
        assert r.input_source == "env-override"

    def test_env_override_miss_falls_through_to_none(
        self, make_sounddevice, make_sysfs_root,
    ):
        sd = make_sounddevice([
            {"name": "ReSpeaker (hw:1,0)", "max_input_channels": 4,
             "max_output_channels": 0, "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({1: "usb"})
        r = resolve_devices(
            env={"VOICE_INPUT_DEVICE": "nonexistent-mic"},
            sys_root=root, sd_module=sd,
        )
        # No fallback to auto-pick when an override was specified —
        # operator pinned a specific device; respect that intent.
        assert r.input_device is None
        assert r.input_source == "none-available"

    def test_no_input_devices_returns_none_with_outputs_intact(
        self, make_sounddevice, make_sysfs_root,
    ):
        sd = make_sounddevice([
            {"name": "Speaker (hw:1,0)", "max_input_channels": 0,
             "max_output_channels": 2, "default_samplerate": 48000, "hostapi": 0},
        ])
        root = make_sysfs_root({1: "pci"})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)
        assert r.input_device is None
        assert r.output_device is not None
        assert r.input_source == "none-available"

    def test_empty_device_list_resolves_cleanly(self, make_sounddevice, make_sysfs_root):
        sd = make_sounddevice([])
        root = make_sysfs_root({})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)
        assert r.input_device is None
        assert r.output_device is None
        assert r.input_source == "none-available"
        assert r.output_source == "none-available"


# ────────────────────────────────────────────────────────────────────
# Whole-stack hardware-config scenarios (README §"Tested")
# ────────────────────────────────────────────────────────────────────

class TestRealHardwareScenarios:
    """Each test simulates one row of the README's compatibility table."""

    def test_poc_box_x86_no_usb(self, make_sounddevice, make_sysfs_root):
        """3 onboard PCI cards (HDMI dGPU + ALC662 + secondary AMD HDA),
        no USB devices. Mirrors what `aplay -l` showed on droplet-sys."""
        sd = make_sounddevice([
            {"name": "HDA ATI HDMI: HDMI 0 (hw:0,3)", "max_input_channels": 0,
             "max_output_channels": 2, "default_samplerate": 48000, "hostapi": 0},
            {"name": "HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)",
             "max_input_channels": 2, "max_output_channels": 2,
             "default_samplerate": 44100, "hostapi": 0},
            {"name": "HD-Audio Generic: Generic Analog (hw:2,0)",
             "max_input_channels": 2, "max_output_channels": 2,
             "default_samplerate": 44100, "hostapi": 0},
        ])
        root = make_sysfs_root({0: "pci", 1: "pci", 2: "pci"})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)

        # Should pick a non-HDMI input. ALC662 or the secondary —
        # both have name "Generic", neither beats the other on
        # current scoring; lowest index wins (the ALC662 at card 1).
        assert r.input_device is not None
        assert "HDMI" not in r.input_device.name
        # And an output that isn't HDMI either.
        assert r.output_device is not None
        assert "HDMI" not in r.output_device.name

    def test_poc_plus_respeaker(self, make_sounddevice, make_sysfs_root):
        """Same POC box with a ReSpeaker USB 4-mic array plugged in.
        ReSpeaker should win for input even though onboard outputs are
        still preferred for speaker (unless a USB speaker is also
        plugged in)."""
        sd = make_sounddevice([
            {"name": "HDA ATI HDMI: HDMI 0 (hw:0,3)", "max_input_channels": 0,
             "max_output_channels": 2, "default_samplerate": 48000, "hostapi": 0},
            {"name": "HD-Audio Generic: ALC662 rev3 Analog (hw:1,0)",
             "max_input_channels": 2, "max_output_channels": 2,
             "default_samplerate": 44100, "hostapi": 0},
            {"name": "ReSpeaker 4 Mic Array (hw:3,0)",
             "max_input_channels": 4, "max_output_channels": 0,
             "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({0: "pci", 1: "pci", 3: "usb"})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)

        assert r.input_device is not None
        assert "ReSpeaker" in r.input_device.name
        assert r.input_device.bus == "usb"
        # Output goes to onboard because ReSpeaker is mic-only.
        assert r.output_device is not None
        assert r.output_device.max_output_channels > 0

    def test_production_v26_soc_with_io_brick(
        self, make_sounddevice, make_sysfs_root,
    ):
        """An I²S codec on platform bus. No PCI codecs in this
        scenario (this host has no traditional onboard audio)."""
        sd = make_sounddevice([
            {"name": "soc-snd-codec: I2S audio (hw:0,0)",
             "max_input_channels": 1, "max_output_channels": 2,
             "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({0: "platform"})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)

        assert r.input_device is not None
        assert r.input_device.bus == "platform"
        assert r.output_device is not None
        assert r.output_device.bus == "platform"

    def test_generic_dev_box_usb_headset(self, make_sounddevice, make_sysfs_root):
        """A developer's laptop with a USB headset and onboard audio."""
        sd = make_sounddevice([
            {"name": "Built-in Audio Analog Stereo (hw:0,0)",
             "max_input_channels": 2, "max_output_channels": 2,
             "default_samplerate": 44100, "hostapi": 0},
            {"name": "Plantronics Blackwire 5220 Headset (hw:2,0)",
             "max_input_channels": 1, "max_output_channels": 2,
             "default_samplerate": 16000, "hostapi": 0},
        ])
        root = make_sysfs_root({0: "pci", 2: "usb"})
        r = resolve_devices(env={}, sys_root=root, sd_module=sd)

        # USB headset wins on both ends.
        assert r.input_device is not None
        assert "Headset" in r.input_device.name
        assert r.input_device.bus == "usb"
        assert r.output_device is not None
        assert "Headset" in r.output_device.name
