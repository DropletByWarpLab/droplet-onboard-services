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


# ---- _merge_segments ----------------------------------------------------


def test_merge_segments_extends_end_to_next_start():
    segs = [
        frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="A"),
        frame_ocr.FrameSegment(start_sec=10, end_sec=15, text="B"),
        frame_ocr.FrameSegment(start_sec=30, end_sec=35, text="C"),
    ]
    merged = frame_ocr._merge_segments(segs)
    assert [(s.start_sec, s.end_sec) for s in merged] == [(0, 10), (10, 30), (30, 35)]
    assert [s.text for s in merged] == ["A", "B", "C"]


def test_merge_segments_empty_returns_empty():
    assert frame_ocr._merge_segments([]) == []


def test_merge_segments_single_segment_unchanged():
    seg = frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="A")
    merged = frame_ocr._merge_segments([seg])
    assert len(merged) == 1
    assert merged[0].start_sec == 0
    assert merged[0].end_sec == 5
    assert merged[0].text == "A"


# ---- _dedup_by_phash ----------------------------------------------------


def _stub_hash(distance: int) -> MagicMock:
    """Return a fake imagehash.ImageHash whose `__sub__` always yields `distance`."""
    h = MagicMock()
    h.__sub__ = lambda self, other: distance
    return h


def test_phash_dedup_skips_similar_frames():
    """Two frames with hamming-distance < threshold -> second skipped."""
    h_a = _stub_hash(5)  # very similar
    h_b = _stub_hash(5)
    with patch("extractors.frame_ocr._phash_bytes", side_effect=[h_a, h_b]):
        kept = frame_ocr._dedup_by_phash(
            [b"frame-a", b"frame-b"],
            phash_threshold=8,
        )
    assert kept == [(0, b"frame-a")]


def test_phash_dedup_keeps_distinct_frames():
    """Two frames with hamming-distance >= threshold -> both kept."""
    h_a = _stub_hash(20)  # very different
    h_b = _stub_hash(20)
    with patch("extractors.frame_ocr._phash_bytes", side_effect=[h_a, h_b]):
        kept = frame_ocr._dedup_by_phash(
            [b"frame-a", b"frame-b"],
            phash_threshold=8,
        )
    assert [idx for idx, _ in kept] == [0, 1]


def test_phash_dedup_first_frame_always_kept():
    """The first frame has no `prev_hash` to compare against; always kept."""
    h_a = _stub_hash(0)
    with patch("extractors.frame_ocr._phash_bytes", side_effect=[h_a]):
        kept = frame_ocr._dedup_by_phash([b"frame-a"], phash_threshold=8)
    assert kept == [(0, b"frame-a")]


def test_phash_dedup_propagates_import_error():
    """If imagehash is missing, the ImportError must surface so the
    orchestrator can return frame_ocr_unavailable."""
    with patch("extractors.frame_ocr._phash_bytes",
               side_effect=ImportError("no imagehash")):
        with pytest.raises(ImportError):
            frame_ocr._dedup_by_phash([b"frame-a"], phash_threshold=8)


def test_phash_dedup_skips_corrupt_frame_silently():
    """A non-Import exception on a single frame -> skip just that frame."""
    h_a = _stub_hash(20)
    with patch("extractors.frame_ocr._phash_bytes",
               side_effect=[h_a, ValueError("corrupt JPEG"), h_a]):
        kept = frame_ocr._dedup_by_phash(
            [b"a", b"b", b"c"],
            phash_threshold=8,
        )
    # Frame 0 kept, frame 1 errored (skipped), frame 2 kept (compared
    # to frame 0's hash since frame 1 didn't update prev_hash).
    assert [idx for idx, _ in kept] == [0, 2]


# ---- extract_frame_text orchestrator -----------------------------------


def test_extract_frame_text_returns_empty_when_no_frames(tmp_path):
    """No-frame video -> empty segments + zero stats."""
    fake_video = tmp_path / "empty.mp4"
    fake_video.write_bytes(b"")
    with patch("extractors.frame_ocr._sample_frames", return_value=iter([])):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert stats.frames_sampled == 0
    assert stats.frames_ocr_run == 0
    assert stats.segments_emitted == 0
    assert stats.interval_sec_used == 5


def test_extract_frame_text_runs_ocr_on_distinct_frames(tmp_path):
    """3 distinct JPEGs -> 3 phashes + 3 OCR calls + segment merge."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8frame-1", b"\xff\xd8frame-2", b"\xff\xd8frame-3"]
    hashes = [_stub_hash(30), _stub_hash(30), _stub_hash(30)]

    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[("welcome", []), ("revenue", []), ("risk", [])]):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)

    assert [s.text for s in segs] == ["welcome", "revenue", "risk"]
    assert [s.start_sec for s in segs] == [0, 5, 10]
    assert stats.frames_sampled == 3
    assert stats.frames_ocr_run == 3
    assert stats.segments_emitted == 3
    assert stats.interval_sec_used == 5


def test_extract_frame_text_skips_empty_ocr_results(tmp_path):
    """OCR returning '' -> frame skipped (no segment emitted) but phash
    still tracked, so frames_ocr_run still counts it."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8a", b"\xff\xd8b"]
    hashes = [_stub_hash(30), _stub_hash(30)]

    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[("", []), ("real text", [])]):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)

    assert [s.text for s in segs] == ["real text"]
    assert stats.frames_sampled == 2
    assert stats.frames_ocr_run == 2  # both ran OCR
    assert stats.segments_emitted == 1


def test_extract_frame_text_dedup_reduces_ocr_calls(tmp_path):
    """If frame 2 is similar to frame 1, only frame 1 is OCR'd."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8a", b"\xff\xd8b", b"\xff\xd8c"]
    # frame 0 distant from None (always kept); frame 1 close to 0 (skipped);
    # frame 2 distant from 0 again (kept).
    hashes = [_stub_hash(30), _stub_hash(0), _stub_hash(30)]

    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[("a-text", []), ("c-text", [])]):
        segs, stats = frame_ocr.extract_frame_text(
            fake_video, interval_sec=5, phash_threshold=8,
        )

    assert stats.frames_sampled == 3
    assert stats.frames_ocr_run == 2  # only the two survivors
    assert [s.start_sec for s in segs] == [0, 10]


def test_extract_frame_text_handles_imagehash_missing(tmp_path):
    """ImportError on imagehash -> return empty + warning, don't raise."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8frame-1"]
    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes",
               side_effect=ImportError("no imagehash")):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert any("frame_ocr_unavailable" in w for w in stats.warnings)


def test_extract_frame_text_handles_ffmpeg_failure(tmp_path):
    """ffmpeg subprocess raises -> return empty + warning, don't raise."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    with patch("extractors.frame_ocr._sample_frames",
               side_effect=subprocess.SubprocessError("ffmpeg crashed")):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert any("frame_ocr_sample_failed" in w for w in stats.warnings)


def test_extract_frame_text_uses_env_defaults_when_args_omitted(tmp_path, monkeypatch):
    """If interval_sec/phash_threshold args are None, env-var parsers
    (and their defaults) are used."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "7")
    monkeypatch.setenv("VIDEO_FRAME_OCR_PHASH_THRESHOLD", "12")
    with patch("extractors.frame_ocr._sample_frames", return_value=iter([])):
        _segs, stats = frame_ocr.extract_frame_text(fake_video)
    assert stats.interval_sec_used == 7


def test_extract_frame_text_skips_failing_ocr_frame(tmp_path):
    """OCR exception on one frame -> just that frame skipped, others continue."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8a", b"\xff\xd8b"]
    hashes = [_stub_hash(30), _stub_hash(30)]
    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[RuntimeError("tesseract crash"), ("ok", [])]):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert [s.text for s in segs] == ["ok"]
    assert stats.frames_ocr_run == 2
    assert stats.segments_emitted == 1
