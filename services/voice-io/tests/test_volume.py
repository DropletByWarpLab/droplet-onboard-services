"""Speaker output volume — the gain math, the persisted state, and the
controller every volume surface shares (voice/volume.py).

Contract pinned here:

  - level_to_gain is (level/100)^2 over a clamped 0..100 level, and 100
    is EXACTLY unity — today's output, byte for byte. It never exceeds
    1.0, so the gain stage is attenuation-only and cannot clip;
  - apply_gain takes int16 and returns int16 (a float32 buffer would hit
    the resampler's float path and the float/int ambiguity it had), keeps
    the shape (stereo too), and never wraps;
  - the store is an explicit {level, muted} JSON file on the /data volume
    with the enabled.py atomic write. ABSENT reads as level 100 unmuted
    (the upgrade path: boxes keep sounding exactly as they did). Every
    OTHER unreadable shape reads as the same audible default AND carries a
    user-facing fault — a storage fault must never silently mute the box;
  - the controller clamps, persists every change, keeps the level when
    muting, and treats a failed save as a visible fault while still
    applying the change the user asked for.
"""
from __future__ import annotations

import errno
import json
import threading
from pathlib import Path

import numpy as np
import pytest

from voice.volume import (
    DEFAULT_LEVEL,
    LEVEL_MAX,
    LEVEL_MIN,
    VolumeController,
    VolumeState,
    VolumeStore,
    apply_gain,
    level_to_gain,
)


@pytest.fixture(autouse=True)
def volume_path(tmp_path, monkeypatch):
    """Point the store at tmp_path — no test may read or write /data."""
    path = tmp_path / "voice-volume.json"
    monkeypatch.setenv("VOICE_VOLUME_PATH", str(path))
    return path


# ────────────────────────────────────────────────────────────────────
# Gain math
# ────────────────────────────────────────────────────────────────────

class TestLevelToGain:
    def test_constants(self):
        assert (LEVEL_MIN, LEVEL_MAX) == (0, 100)
        # Back-compat: a box with no volume file sounds exactly as today.
        assert DEFAULT_LEVEL == 100

    @pytest.mark.parametrize(
        ("level", "gain"),
        [(100, 1.0), (50, 0.25), (10, 0.01), (0, 0.0), (70, 0.49)],
    )
    def test_anchor_points(self, level, gain):
        assert level_to_gain(level) == pytest.approx(gain)

    def test_one_hundred_is_exactly_unity(self):
        # Not approx: the identity short-circuit in apply_gain keys on it.
        assert level_to_gain(100) == 1.0

    def test_monotonic_and_never_above_unity(self):
        gains = [level_to_gain(level) for level in range(0, 101)]
        assert gains == sorted(gains)
        assert max(gains) == 1.0
        assert min(gains) == 0.0

    @pytest.mark.parametrize(("level", "gain"), [(-20, 0.0), (250, 1.0)])
    def test_out_of_range_levels_clamp(self, level, gain):
        assert level_to_gain(level) == gain


class TestApplyGain:
    def test_unity_returns_the_input_untouched(self):
        pcm = np.array([1, -2, 32767, -32768], dtype=np.int16)
        assert apply_gain(pcm, 1.0) is pcm

    def test_zero_gain_is_exact_silence(self):
        pcm = np.array([1000, -1000, 32767], dtype=np.int16)
        out = apply_gain(pcm, 0.0)
        assert out.dtype == np.int16
        assert not out.any()

    def test_half_gain_scales_and_stays_int16(self):
        pcm = np.array([1000, -1000, 32767, -32768], dtype=np.int16)
        out = apply_gain(pcm, 0.5)
        assert out.dtype == np.int16
        assert out.tolist() == [500, -500, 16384, -16384]

    def test_never_wraps_at_full_scale(self):
        pcm = np.array([32767, -32768] * 8, dtype=np.int16)
        for level in range(0, 101, 5):
            out = apply_gain(pcm, level_to_gain(level))
            assert int(out.max()) <= 32767 and int(out.min()) >= -32768
            # Sign is preserved: attenuation never flips a sample.
            assert (out[0::2] >= 0).all() and (out[1::2] <= 0).all()

    def test_gain_above_unity_is_capped(self):
        # Attenuation-only by construction: a caller can't ask it to clip.
        pcm = np.array([30000, -30000], dtype=np.int16)
        assert apply_gain(pcm, 4.0).tolist() == [30000, -30000]

    def test_preserves_stereo_shape(self):
        pcm = np.array([[1000, -1000], [2000, -2000]], dtype=np.int16)
        out = apply_gain(pcm, 0.25)
        assert out.shape == (2, 2)
        assert out.tolist() == [[250, -250], [500, -500]]

    def test_rejects_non_int16(self):
        with pytest.raises(TypeError):
            apply_gain(np.zeros(4, dtype=np.float32), 0.5)


# ────────────────────────────────────────────────────────────────────
# The store
# ────────────────────────────────────────────────────────────────────

class TestVolumeStore:
    def test_absent_file_reads_the_audible_default_with_no_fault(self, volume_path):
        assert not volume_path.exists()
        state, fault = VolumeStore().read()
        assert state == VolumeState(level=100, muted=False)
        assert fault is None

    def test_round_trip(self, volume_path):
        VolumeStore().save(VolumeState(level=40, muted=True))
        assert json.loads(volume_path.read_text(encoding="utf-8")) == {
            "level": 40, "muted": True,
        }
        # A fresh store is what a restarted process builds.
        assert VolumeStore().read() == (VolumeState(level=40, muted=True), None)

    def test_save_creates_missing_parent_directories(self, tmp_path, monkeypatch):
        path = tmp_path / "fresh" / "volume" / "voice-volume.json"
        monkeypatch.setenv("VOICE_VOLUME_PATH", str(path))
        VolumeStore().save(VolumeState(level=30, muted=False))
        assert VolumeStore().read()[0].level == 30

    def test_explicit_path_wins_over_the_env(self, tmp_path, volume_path):
        explicit = tmp_path / "explicit.json"
        VolumeStore(str(explicit)).save(VolumeState(level=20, muted=False))
        assert VolumeStore(str(explicit)).read()[0].level == 20
        assert not volume_path.exists()

    def test_save_leaves_no_temp_files_behind(self, volume_path):
        VolumeStore().save(VolumeState(level=55, muted=False))
        assert sorted(p.name for p in volume_path.parent.iterdir()) == [
            "voice-volume.json",
        ]

    # ── present-but-unreadable: audible default + a visible fault ──
    #
    # The opposite polarity from the voice kill switch, on purpose. A
    # storage fault must never make the box go quiet without anyone
    # choosing it: "Droplet stopped answering" with no reason on screen is
    # the failure this guards. So every unreadable shape falls back to the
    # SAME audible default an absent file gives — and, unlike absence,
    # says so.

    @pytest.mark.parametrize(
        "body",
        [
            "{not json",
            "",
            "[40, false]",
            '{"level": "40", "muted": false}',
            '{"level": 40.5, "muted": false}',
            '{"level": true, "muted": false}',
            '{"level": 140, "muted": false}',
            '{"level": -1, "muted": false}',
            '{"level": 40, "muted": "true"}',
            '{"level": 40}',
            '{"muted": true}',
        ],
    )
    def test_unreadable_shapes_read_audible_with_a_fault(self, volume_path, body):
        volume_path.write_text(body, encoding="utf-8")
        state, fault = VolumeStore().read()
        assert state == VolumeState(level=DEFAULT_LEVEL, muted=False)
        assert fault is not None
        assert str(volume_path) in fault

    def test_undecodable_bytes_read_audible_with_a_fault(self, volume_path):
        volume_path.write_bytes(b"\xff\xfe\x00garbage")
        state, fault = VolumeStore().read()
        assert state.muted is False and state.level == DEFAULT_LEVEL
        assert fault is not None

    def test_a_directory_at_the_path_reads_audible_with_a_fault(
        self, tmp_path, monkeypatch,
    ):
        directory = tmp_path / "not-a-file.json"
        directory.mkdir()
        monkeypatch.setenv("VOICE_VOLUME_PATH", str(directory))
        state, fault = VolumeStore().read()
        assert state == VolumeState(level=DEFAULT_LEVEL, muted=False)
        assert fault is not None

    @pytest.mark.parametrize(
        "exc",
        [
            PermissionError(errno.EACCES, "Permission denied"),
            OSError(errno.EIO, "Input/output error"),
        ],
    )
    def test_an_os_error_reads_audible_with_a_fault(
        self, volume_path, monkeypatch, exc,
    ):
        # A persisted MUTE that can no longer be read must not stay muted
        # silently — the fault is how the owner finds out.
        volume_path.write_text('{"level": 10, "muted": true}', encoding="utf-8")

        def _raise(*_args, **_kwargs):
            raise exc

        monkeypatch.setattr(Path, "read_text", _raise)
        state, fault = VolumeStore().read()
        assert state == VolumeState(level=DEFAULT_LEVEL, muted=False)
        assert fault is not None


# ────────────────────────────────────────────────────────────────────
# The controller
# ────────────────────────────────────────────────────────────────────

def _controller(level: int = 100, muted: bool = False) -> VolumeController:
    VolumeStore().save(VolumeState(level=level, muted=muted))
    return VolumeController(VolumeStore())


class TestVolumeController:
    def test_loads_the_persisted_state(self):
        ctl = _controller(level=35, muted=True)
        assert ctl.state() == VolumeState(level=35, muted=True)
        assert ctl.fault is None

    def test_a_fresh_box_is_at_unity(self):
        ctl = VolumeController(VolumeStore())
        assert ctl.state() == VolumeState(level=100, muted=False)
        assert ctl.gain() == 1.0

    def test_set_level_persists_and_reports_before_and_after(self, volume_path):
        ctl = _controller(level=70)
        change = ctl.set_level(40)
        assert change.previous == VolumeState(level=70, muted=False)
        assert change.current == VolumeState(level=40, muted=False)
        assert change.fault is None
        assert json.loads(volume_path.read_text(encoding="utf-8")) == {
            "level": 40, "muted": False,
        }
        assert ctl.gain() == pytest.approx(0.16)

    @pytest.mark.parametrize(("asked", "got"), [(-5, 0), (0, 0), (100, 100), (180, 100)])
    def test_set_level_clamps(self, asked, got):
        assert _controller().set_level(asked).current.level == got

    @pytest.mark.parametrize(
        ("start", "delta", "got"),
        [(50, 10, 60), (50, -10, 40), (95, 10, 100), (5, -10, 0), (50, -25, 25)],
    )
    def test_change_is_relative_and_clamped(self, start, delta, got):
        assert _controller(level=start).change(delta).current.level == got

    def test_mute_keeps_the_level(self, volume_path):
        ctl = _controller(level=60)
        change = ctl.set_muted(True)
        assert change.current == VolumeState(level=60, muted=True)
        assert ctl.gain() == 0.0
        assert json.loads(volume_path.read_text(encoding="utf-8")) == {
            "level": 60, "muted": True,
        }
        # Unmute restores exactly what was there before.
        assert ctl.set_muted(False).current == VolumeState(level=60, muted=False)
        assert ctl.gain() == pytest.approx(0.36)

    @pytest.mark.parametrize("op", ["set_level", "change"])
    def test_a_level_change_unmutes(self, op):
        # Asking for a level is asking to hear it: "turn it up" on a muted
        # box that stayed muted would answer "Volume 70." into silence.
        ctl = _controller(level=60, muted=True)
        change = ctl.set_level(30) if op == "set_level" else ctl.change(10)
        assert change.current.muted is False
        assert change.previous.muted is True

    def test_level_zero_is_silent_but_not_muted(self):
        ctl = _controller()
        assert ctl.set_level(0).current == VolumeState(level=0, muted=False)
        assert ctl.gain() == 0.0

    def test_a_read_fault_surfaces_and_clears_on_the_next_good_save(self, volume_path):
        volume_path.write_text("{not json", encoding="utf-8")
        ctl = VolumeController(VolumeStore())
        assert ctl.state() == VolumeState(level=100, muted=False)
        assert ctl.fault is not None
        change = ctl.set_level(50)
        assert change.fault is None
        assert ctl.fault is None

    def test_a_failed_save_applies_the_change_and_reports_a_fault(
        self, volume_path, monkeypatch,
    ):
        ctl = _controller(level=80)

        def _boom(*_args, **_kwargs):
            raise OSError(errno.EROFS, "Read-only file system")

        monkeypatch.setattr(VolumeStore, "save", _boom)
        change = ctl.set_muted(True)
        # The user asked for silence; they get it now, and the fault says
        # it won't survive a restart.
        assert change.current == VolumeState(level=80, muted=True)
        assert ctl.gain() == 0.0
        assert change.fault is not None and "saved" in change.fault
        assert ctl.fault == change.fault

    def test_concurrent_changes_do_not_lose_updates(self):
        ctl = _controller(level=0)
        barrier = threading.Barrier(8)

        def _bump():
            barrier.wait()
            for _ in range(10):
                ctl.change(1)

        threads = [threading.Thread(target=_bump) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert ctl.state().level == 80
