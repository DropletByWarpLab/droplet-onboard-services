"""WARP-208: frame_ocr unit tests."""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from extractors import frame_ocr


# ---- env-var parsers ----------------------------------------------------


def test_parse_interval_sec_default():
    assert frame_ocr.parse_interval_sec(None) == 5


def test_parse_interval_sec_honors_env(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "10")
    assert frame_ocr.parse_interval_sec() == 10


def test_parse_interval_sec_clamps_out_of_range(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "999")
    assert frame_ocr.parse_interval_sec() == 5


def test_parse_interval_sec_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "banana")
    assert frame_ocr.parse_interval_sec() == 5


def test_parse_interval_sec_falls_back_on_negative(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "-5")
    assert frame_ocr.parse_interval_sec() == 5


def test_parse_phash_threshold_default():
    assert frame_ocr.parse_phash_threshold(None) == 8


def test_parse_phash_threshold_honors_env(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_PHASH_THRESHOLD", "12")
    assert frame_ocr.parse_phash_threshold() == 12


def test_parse_phash_threshold_clamps_out_of_range(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_PHASH_THRESHOLD", "200")
    assert frame_ocr.parse_phash_threshold() == 8


# ---- _sample_frames -----------------------------------------------------


def test_sample_frames_invokes_ffmpeg_with_correct_filter():
    """`_sample_frames` shells out to ffmpeg with `fps=1/N` filter."""
    fake_proc = MagicMock()
    fake_proc.stdout.read.return_value = b""  # empty pipe = no frames
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc) as popen:
        list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=5))
    args = popen.call_args[0][0]
    assert "ffmpeg" in args[0]
    assert "fps=1/5" in " ".join(args)
    assert "image2pipe" in " ".join(args)
    assert "mjpeg" in " ".join(args)


def test_sample_frames_honors_custom_interval():
    fake_proc = MagicMock()
    fake_proc.stdout.read.return_value = b""
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc) as popen:
        list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=10))
    args = popen.call_args[0][0]
    assert "fps=1/10" in " ".join(args)


def test_sample_frames_yields_jpeg_chunks_separated_by_soi_marker():
    """Two JPEGs concatenated in the pipe yield two byte-chunks."""
    soi = b"\xff\xd8"
    chunk1 = soi + b"jpeg-frame-1-payload" + b"\xff\xd9"
    chunk2 = soi + b"jpeg-frame-2-payload" + b"\xff\xd9"
    fake_proc = MagicMock()
    # Simulate the SOI-split protocol: the helper reads in chunks and
    # splits on b"\xff\xd8".
    fake_proc.stdout.read.side_effect = [chunk1 + chunk2, b""]
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc):
        out = list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=5))
    assert len(out) == 2
    assert out[0].startswith(soi)
    assert out[1].startswith(soi)


def test_sample_frames_yields_zero_when_pipe_empty():
    fake_proc = MagicMock()
    fake_proc.stdout.read.return_value = b""
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc):
        out = list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=5))
    assert out == []
