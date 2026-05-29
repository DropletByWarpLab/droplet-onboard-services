"""Video extractor: transcript spans + frame-OCR spans, both with media-timestamp anchors."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from anchor_schema import MediaTimestampAnchor
from extractors import video


def test_video_extractor_emits_transcript_and_frame_ocr_spans(tmp_path, monkeypatch):
    fake_path = tmp_path / "fake.mp4"
    fake_path.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    transcript_seg = lambda s, e, t: MagicMock(start=s, end=e, text=t)
    transcript = iter([transcript_seg(0.0, 2.0, "spoken intro"), transcript_seg(2.0, 4.0, "spoken outro")])
    transcript_info = MagicMock(language="en", duration=4.0)

    # Frame OCR finds text at 1.5s and 3.5s.
    frame_results = [
        {"timestamp_seconds": 1.5, "text": "title-card text"},
        {"timestamp_seconds": 3.5, "text": "credits text"},
    ]

    with patch.object(video, "_transcribe") as mock_t, \
         patch.object(video, "_run_frame_ocr") as mock_f:
        mock_t.return_value = (transcript, transcript_info)
        mock_f.return_value = frame_results
        doc = video.extract(str(fake_path))

    spans = doc["spans"]
    # Two transcript spans + two frame-OCR spans, sorted by startMs.
    starts = [s.anchor.startMs for s in spans]
    assert starts == sorted(starts)

    timestamps = [(s.anchor.startMs, s.text) for s in spans]
    assert (0, "spoken intro") in timestamps
    assert (1500, "title-card text") in timestamps
    assert (2000, "spoken outro") in timestamps
    assert (3500, "credits text") in timestamps

    assert all(isinstance(s.anchor, MediaTimestampAnchor) for s in spans)
