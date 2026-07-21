"""WARP-626 — sentence chunker contract (Wave B, client-side streaming TTS).

`voice.text_chunk.SentenceChunker` accumulates text deltas from the
orchestrator SSE stream and emits complete sentence/clause chunks so the
pipeline can synthesize + play sentence 1 while the rest of the reply is
still arriving. Pure, no I/O — every boundary case is pinned here.

The contract:

  - Splits on `. ? !` and newline.
  - A min chunk length coalesces choppy 1-word fragments into the next
    sentence (avoid synthesizing "Yes." on its own).
  - A max buffer length force-flushes a run-on clause so a comma-only
    stream never holds audio forever.
  - Common abbreviations ("Dr.", "e.g.", "p.m.") and decimals ("3.5")
    do NOT split.
  - Deltas may split a sentence across `push()` calls — the chunk spans
    the boundary correctly.
  - `flush()` emits whatever remains (ignoring the min-length gate).
  - Empty / whitespace input yields nothing.
"""
from __future__ import annotations

from voice.text_chunk import (
    DEFAULT_MAX_CHUNK_CHARS,
    DEFAULT_MIN_CHUNK_CHARS,
    SentenceChunker,
    chunk_stream,
)


class TestSinglePushBoundaries:
    def test_single_sentence_emits_on_flush(self):
        c = SentenceChunker()
        # No trailing boundary until flush — a lone sentence with a period
        # DOES have a boundary, but a fragment shorter than min coalesces.
        assert c.push("The front camera is online.") == [
            "The front camera is online.",
        ]

    def test_splits_on_question_mark(self):
        c = SentenceChunker()
        assert c.push("Is the door locked? Let me check.") == [
            "Is the door locked?",
            "Let me check.",
        ]

    def test_splits_on_exclamation(self):
        c = SentenceChunker()
        out = c.push("Everything looks great! The network is healthy.")
        assert out == ["Everything looks great!", "The network is healthy."]

    def test_terminal_punctuation_is_retained(self):
        # Piper reads intonation off the punctuation — keep it.
        c = SentenceChunker()
        out = c.push("The camera is online. All good here now.")
        assert out[0].endswith(".")
        assert out[1].endswith(".")


class TestMinLengthCoalescing:
    def test_short_leading_fragment_coalesces_into_next(self):
        # "Yes." is below the default min — it must NOT synthesize on its
        # own; it rides along with the following sentence.
        c = SentenceChunker()
        out = c.push("Yes. The kitchen light is on right now.")
        assert out == ["Yes. The kitchen light is on right now."]

    def test_default_min_is_documented_value(self):
        assert DEFAULT_MIN_CHUNK_CHARS == 12

    def test_min_length_is_configurable(self):
        # With min_chars=1 every boundary splits — isolates boundary logic.
        c = SentenceChunker(min_chars=1)
        assert c.push("Yes. No. Maybe.") == ["Yes.", "No.", "Maybe."]


class TestAbbreviations:
    def test_does_not_split_on_title_abbreviation(self):
        c = SentenceChunker(min_chars=1)
        assert c.push("Dr. Smith is here to help you now.") == [
            "Dr. Smith is here to help you now.",
        ]

    def test_does_not_split_on_eg(self):
        c = SentenceChunker(min_chars=1)
        assert c.push("Use e.g. the front door camera here.") == [
            "Use e.g. the front door camera here.",
        ]

    def test_does_not_split_on_pm(self):
        # "p.m." is an abbreviation — the reply "it is three p.m." is a
        # single spoken chunk, not "it is three p." + "m.".
        c = SentenceChunker(min_chars=1)
        assert c.push("It is three p.m. right now.") == [
            "It is three p.m. right now.",
        ]

    def test_does_not_split_on_decimal(self):
        c = SentenceChunker(min_chars=1)
        assert c.push("It is 3.5 degrees outside now.") == [
            "It is 3.5 degrees outside now.",
        ]

    def test_abbreviation_then_real_sentence_end_splits_after(self):
        c = SentenceChunker(min_chars=1)
        out = c.push("Dr. Smith is in. Come on in now.")
        assert out == ["Dr. Smith is in.", "Come on in now."]


class TestMultiDeltaSpanning:
    def test_sentence_split_across_two_deltas(self):
        c = SentenceChunker()
        # First delta ends mid-sentence — nothing complete yet.
        assert c.push("The front camera ") == []
        # Second delta completes the sentence — it spans the boundary.
        out = c.push("is online now. Nice.")
        assert out[0] == "The front camera is online now."

    def test_boundary_char_arrives_in_later_delta(self):
        c = SentenceChunker()
        # No boundary char yet → nothing emitted.
        assert c.push("Everything is working well") == []
        # The "!" arrives in its own delta and completes the boundary; the
        # 27-char sentence is >= min, so it emits on this push.
        assert c.push("!") == ["Everything is working well!"]

    def test_deltas_accumulate_then_flush_remainder(self):
        c = SentenceChunker()
        c.push("The network looks ")
        c.push("healthy and fast")
        assert c.flush() == ["The network looks healthy and fast"]


class TestFlush:
    def test_flush_emits_remainder_even_below_min(self):
        c = SentenceChunker()
        assert c.push("Hi.") == []  # below min, coalesce-pending
        assert c.flush() == ["Hi."]  # flush ignores the min gate

    def test_flush_on_empty_returns_nothing(self):
        assert SentenceChunker().flush() == []

    def test_flush_twice_is_idempotent(self):
        c = SentenceChunker()
        c.push("Remaining text here now")
        assert c.flush() == ["Remaining text here now"]
        assert c.flush() == []


class TestEmptyAndWhitespace:
    def test_empty_push_returns_nothing(self):
        c = SentenceChunker()
        assert c.push("") == []

    def test_whitespace_only_push_returns_nothing(self):
        c = SentenceChunker()
        assert c.push("   \n\t ") == []
        assert c.flush() == []

    def test_none_like_empty_delta_is_safe(self):
        c = SentenceChunker()
        assert c.push("") == []
        assert c.push("Real content arrives later here.") == [
            "Real content arrives later here.",
        ]


class TestNewlineBoundary:
    def test_newline_is_a_boundary(self):
        c = SentenceChunker(min_chars=1)
        assert c.push("a\nb\nc") == ["a", "b"]
        assert c.flush() == ["c"]

    def test_newline_stripped_from_emitted_chunk(self):
        c = SentenceChunker()
        out = c.push("The first line here\nThe second line here\n")
        assert out[0] == "The first line here"
        assert "\n" not in out[0]


class TestMaxBufferFlush:
    def test_default_max_is_documented_value(self):
        assert DEFAULT_MAX_CHUNK_CHARS == 240

    def test_runon_without_punctuation_force_flushes_at_max(self):
        # A comma-only run-on with no sentence boundary must not hold audio
        # forever — force a flush once the buffer exceeds max.
        c = SentenceChunker(min_chars=1, max_chars=10)
        out = c.push("abcdefghijklmnop")  # 16 chars, no boundary
        assert out == ["abcdefghij"]  # cut at max (no space to break on)
        assert c.flush() == ["klmnop"]

    def test_force_flush_prefers_a_space_break(self):
        c = SentenceChunker(min_chars=1, max_chars=10)
        out = c.push("aaaa bbbb cccc dddd")
        # Breaks on the last space within the max window, not mid-word.
        assert out[0] == "aaaa bbbb"

    def test_boundary_preferred_over_max_when_present(self):
        # A real sentence boundary inside the max window wins — no forced cut.
        c = SentenceChunker(min_chars=1, max_chars=200)
        assert c.push("Short one. Then more text follows here.") == [
            "Short one.",
            "Then more text follows here.",
        ]


class TestChunkStreamHelper:
    def test_chunk_stream_yields_all_sentences_in_order(self):
        deltas = ["Hello there world. ", "How are you today?"]
        assert list(chunk_stream(deltas)) == [
            "Hello there world.",
            "How are you today?",
        ]

    def test_chunk_stream_flushes_trailing_remainder(self):
        deltas = ["No terminator on ", "this final clause"]
        assert list(chunk_stream(deltas)) == ["No terminator on this final clause"]

    def test_chunk_stream_empty_input_yields_nothing(self):
        assert list(chunk_stream([])) == []
        assert list(chunk_stream(["", "   "])) == []
