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

WARP-3729 (first-clause emission, so first audio does not wait for the
persona's whole one-sentence reply):

  - `;` / `:` followed by whitespace are ordinary boundaries (Kokoro
    already synthesizes those parts separately).
  - The FIRST chunk may end at a `, ` once the clause is >= 24 chars,
    the next word is not a number and >= 12 chars of tail have arrived
    with no boundary among them (a short tail cancels the cut).
  - The chunk after a clause cut is cut at its last `, ` once 80 chars
    are buffered; later sentences keep the 240-char forced cut only.
  - A trailing `,` `;` `:` waits for the next delta; "1,000" / "3:45"
    never split.
"""
from __future__ import annotations

from voice.text_chunk import (
    DEFAULT_CLAUSE_SOFT_MAX_CHARS,
    DEFAULT_FIRST_CLAUSE_MIN_CHARS,
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


class TestFirstClause:
    """WARP-3729 — the FIRST chunk may end at a ', ' once the clause is long
    enough and the tail after it can stand as a chunk of its own, so first
    audio does not wait for the whole first sentence."""

    def test_default_first_clause_min_is_documented_value(self):
        assert DEFAULT_FIRST_CLAUSE_MIN_CHARS == 24

    def test_first_chunk_splits_at_a_comma_once_long_enough(self):
        c = SentenceChunker()
        assert c.push("The front camera is online, and the network looks healthy.") == [
            "The front camera is online,",
            "and the network looks healthy.",
        ]

    def test_short_opener_does_not_split(self):
        # "Sure," (5 chars) is an interjection, not a clause worth a synth.
        c = SentenceChunker()
        assert c.push("Sure, the kitchen light is on.") == [
            "Sure, the kitchen light is on.",
        ]

    def test_short_fragment_before_the_clause_rides_along(self):
        c = SentenceChunker()
        out = c.push("Yes. The kitchen light is on, and the hallway is off.")
        assert out == ["Yes. The kitchen light is on,", "and the hallway is off."]

    def test_only_the_first_chunk_uses_commas(self):
        c = SentenceChunker()
        assert c.push("First one here now. Second one here, with more.") == [
            "First one here now.",
            "Second one here, with more.",
        ]

    def test_comma_waits_for_a_tail_of_min_chars(self):
        c = SentenceChunker()
        # The comma is the last char: nothing yet (it might be "1,000").
        assert c.push("The front camera is online,") == []
        # Three chars of tail are short of the 12-char tail guard: wait.
        assert c.push(" and") == []
        # 15 chars of tail with no boundary among them: the clause emits.
        assert c.push(" the network") == ["The front camera is online,"]
        assert c.flush() == ["and the network"]

    def test_short_tail_cancels_the_comma_cut(self):
        # A tail under 12 chars ("yes.", "sorry.", "though.") would be a
        # standalone synth after a pitch reset for no gain — the sentence
        # stays whole.
        for reply in (
            "The kitchen light is on, yes.",
            "I can't see the garage camera right now, sorry.",
            "The network looks healthy right now, by the way.",
            "Everything on the network looks fine, though.",
        ):
            assert SentenceChunker().push(reply) == [reply], reply

    def test_short_tail_arriving_in_a_later_delta_cancels_too(self):
        c = SentenceChunker()
        assert c.push("The front camera is online,") == []
        assert c.push(" and more.") == ["The front camera is online, and more."]

    def test_a_tail_of_exactly_min_chars_still_splits(self):
        # "all searchable." is 15 chars: a chunk of its own, so the cut holds
        # (and the thousands separator in "1,000" is not a clause end).
        c = SentenceChunker()
        assert c.push("We have 1,000 files indexed, all searchable.") == [
            "We have 1,000 files indexed,",
            "all searchable.",
        ]

    def test_digit_after_the_comma_is_not_a_clause_end(self):
        # The date/time reply: never cut before the year.
        c = SentenceChunker()
        out = c.push(
            "It's Tuesday, October 10, 2026, and it's a quarter to four in the afternoon."
        )
        assert out == [
            "It's Tuesday, October 10, 2026,",
            "and it's a quarter to four in the afternoon.",
        ]

    def test_clock_time_and_abbreviation_before_the_clause(self):
        c = SentenceChunker()
        assert c.push("It is 3:45 p.m. right now, and the office is quiet.") == [
            "It is 3:45 p.m. right now,",
            "and the office is quiet.",
        ]

    def test_thousands_separator_and_clock_time_never_split(self):
        c = SentenceChunker()
        assert c.push("We have 1,000 devices and it is 3:45 today.") == [
            "We have 1,000 devices and it is 3:45 today.",
        ]

    def test_sentence_boundary_inside_the_tail_window_wins(self):
        # "yes." ends the sentence 4 chars after the comma: the comma cut is
        # cancelled and the next sentence is its own chunk, as today.
        c = SentenceChunker()
        assert c.push("The kitchen light is on, yes. The hallway is dark.") == [
            "The kitchen light is on, yes.",
            "The hallway is dark.",
        ]

    def test_none_restores_sentence_only_first_chunks(self):
        # The one-line rollback.
        text = "The front camera is online, and the network looks healthy."
        assert SentenceChunker(first_clause_min_chars=None).push(text) == [text]

    def test_first_clause_min_is_configurable(self):
        text = "The front camera is online, and the network looks healthy."
        assert SentenceChunker(first_clause_min_chars=40).push(text) == [text]
        # "The light is on," is 16 chars: under the default, at the floor
        # when the floor is lowered to 16.
        short = "The light is on, and the hallway is dark."
        assert SentenceChunker().push(short) == [short]
        assert SentenceChunker(first_clause_min_chars=16).push(short) == [
            "The light is on,",
            "and the hallway is dark.",
        ]


class TestSegmentBoundaries:
    """WARP-3729 — ';' and ':' followed by whitespace are ordinary boundaries
    for any chunk (Kokoro's split_text already synthesizes those parts on
    their own, so the audio is unchanged)."""

    def test_semicolon_splits_the_first_chunk(self):
        c = SentenceChunker()
        assert c.push("The camera is online; the network is fine.") == [
            "The camera is online;",
            "the network is fine.",
        ]

    def test_colon_splits_at_min_chars(self):
        c = SentenceChunker()
        assert c.push("Here is the status: everything is online.") == [
            "Here is the status:",
            "everything is online.",
        ]

    def test_short_colon_lead_in_coalesces(self):
        # "Note:" is under the 12-char min — rides along as today.
        c = SentenceChunker()
        assert c.push("Note: the camera is off.") == ["Note: the camera is off."]

    def test_segment_boundaries_apply_after_the_first_chunk_too(self):
        c = SentenceChunker()
        assert c.push("All good here now. The camera is online; the network is fine.") == [
            "All good here now.",
            "The camera is online;",
            "the network is fine.",
        ]

    def test_trailing_separator_waits_for_the_next_delta(self):
        c = SentenceChunker()
        assert c.push("The camera is online;") == []
        assert c.push(" the network is fine.") == [
            "The camera is online;",
            "the network is fine.",
        ]

    def test_clock_time_colon_never_splits(self):
        c = SentenceChunker(min_chars=1)
        assert c.push("It is 3:45 in the afternoon.") == [
            "It is 3:45 in the afternoon.",
        ]


class TestSoftClauseCap:
    """WARP-3729 — the chunk right after a clause cut is cut at its last ', '
    once the buffer holds soft_max_chars, so a long remainder is synthesized
    before the short clause before it has finished playing."""

    FIRST = "The front camera is online, "
    REMAINDER = (
        "the back camera is online, the hallway camera is online, "
        "the garage camera is online, the doorbell camera is online, "
        "and the network looks healthy right now."
    )

    def test_default_soft_max_is_documented_value(self):
        assert DEFAULT_CLAUSE_SOFT_MAX_CHARS == 80

    def test_streamed_remainder_is_cut_at_clause_ends_under_the_cap(self):
        # Word-by-word deltas, as the SSE stream delivers them.
        c = SentenceChunker()
        out: list[str] = []
        for word in (self.FIRST + self.REMAINDER).split(" "):
            out += c.push(word + " ")
        out += c.flush()
        assert out == [
            "The front camera is online,",
            "the back camera is online, the hallway camera is online,",
            "the garage camera is online, the doorbell camera is online,",
            "and the network looks healthy right now.",
        ]
        assert all(len(chunk) <= DEFAULT_CLAUSE_SOFT_MAX_CHARS for chunk in out)
        assert " ".join(out) == self.FIRST + self.REMAINDER

    def test_single_delta_prefers_the_sentence_end(self):
        # The whole reply in one delta (the reply() fallback): a sentence end
        # already in the buffer wins over the soft cap, as it does over the
        # forced cut.
        c = SentenceChunker()
        assert c.push(self.FIRST + self.REMAINDER) == [
            "The front camera is online,",
            self.REMAINDER,
        ]

    def test_soft_cap_never_strands_a_short_tail(self):
        # The last ', ' inside the window leaves an 8-char tail ("and more"),
        # so the cut moves back to the previous comma.
        c = SentenceChunker()
        out = c.push(
            "The front camera is online, the back camera is online and "
            "recording the driveway all day, the lawn, and more"
        )
        assert out == [
            "The front camera is online,",
            "the back camera is online and recording the driveway all day,",
        ]
        assert c.flush() == ["the lawn, and more"]

    def test_comma_free_remainder_waits_for_the_forced_cut(self):
        c = SentenceChunker()
        assert c.push("The front camera is online, and the network") == [
            "The front camera is online,",
        ]
        runon = (
            " is doing very well with every device online and every link "
            "healthy and nothing at all to report from any of the rooms"
        )
        assert c.push(runon) == []  # > 80 chars, no comma: no soft cut
        assert c.push(".") == [("and the network" + runon + ".")]

    def test_soft_cap_does_not_apply_after_a_sentence_boundary(self):
        # Later sentences keep today's behaviour: a 100-char comma-spliced
        # run-on after a full sentence waits for its end (or the 240 cut).
        c = SentenceChunker()
        assert c.push("All good here now. ") == ["All good here now."]
        runon = (
            "the back camera is online, the hallway camera is online, "
            "the garage camera is online, the doorbell camera is online"
        )
        assert len(runon) > DEFAULT_CLAUSE_SOFT_MAX_CHARS
        assert c.push(runon) == []
        assert c.flush() == [runon]

    def test_soft_max_is_clamped_to_the_max(self):
        # TestMaxBufferFlush's tiny max still wins: the soft cap can never
        # exceed max_chars, and never drops under min_chars.
        c = SentenceChunker(min_chars=1, max_chars=10, soft_max_chars=500)
        assert c.push("abcdefghijklmnop") == ["abcdefghij"]


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

    def test_chunk_stream_passes_the_clause_kwargs_through(self):
        # WARP-3729: defaults split the first clause; None switches it off.
        text = "The front camera is online, and the network looks healthy."
        assert list(chunk_stream([text])) == [
            "The front camera is online,",
            "and the network looks healthy.",
        ]
        assert list(chunk_stream([text], first_clause_min_chars=None)) == [text]
