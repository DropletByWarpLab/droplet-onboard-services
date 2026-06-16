"""Audio extractor: one span per Whisper segment with media-timestamp anchors."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from anchor_schema import MediaTimestampAnchor
from extractors import audio


def _fake_whisper_segments():
    """Three Whisper segments: 0.0-1.5s, 1.5-3.2s, 3.2-5.0s."""
    seg = lambda start, end, text: MagicMock(start=start, end=end, text=text)
    return iter([seg(0.0, 1.5, "hello"), seg(1.5, 3.2, "world"), seg(3.2, 5.0, "goodbye")])


def test_audio_extractor_produces_one_span_per_segment(tmp_path):
    fake_path = tmp_path / "fake.mp3"
    fake_path.write_bytes(b"\x00")  # bypass file-exists check

    fake_info = MagicMock(language="en", duration=5.0)
    with patch.object(audio, "_load_model") as mock_load:
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (_fake_whisper_segments(), fake_info)
        mock_load.return_value = mock_model
        doc = audio.extract(str(fake_path), "audio/mpeg")

    spans = doc["spans"]
    assert len(spans) == 3

    anchors = [s.anchor for s in spans]
    assert all(isinstance(a, MediaTimestampAnchor) for a in anchors)
    assert (anchors[0].startMs, anchors[0].endMs) == (0, 1500)
    assert (anchors[1].startMs, anchors[1].endMs) == (1500, 3200)
    assert (anchors[2].startMs, anchors[2].endMs) == (3200, 5000)


def test_audio_extractor_skips_empty_segments(tmp_path):
    fake_path = tmp_path / "fake.mp3"
    fake_path.write_bytes(b"\x00")
    seg = lambda start, end, text: MagicMock(start=start, end=end, text=text)
    segments = iter([seg(0.0, 1.0, "real text"), seg(1.0, 2.0, "   "), seg(2.0, 3.0, "more text")])
    fake_info = MagicMock(language="en", duration=3.0)
    with patch.object(audio, "_load_model") as mock_load:
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (segments, fake_info)
        mock_load.return_value = mock_model
        doc = audio.extract(str(fake_path), "audio/mpeg")

    # Empty-text segment is dropped.
    assert [s.anchor.startMs for s in doc["spans"]] == [0, 2000]
