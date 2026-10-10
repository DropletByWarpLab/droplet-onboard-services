"""Sentence chunker for client-side streaming TTS (WARP-626, Wave B).

The voice loop streams the orchestrator's reply as text deltas (see
`voice.llm.OrchestratorLLM.reply_stream`). To start speaking sentence 1
before the WHOLE reply has been synthesized, the pipeline feeds those
deltas through a `SentenceChunker`, which accumulates text and emits
complete sentence/clause chunks the moment one is ready. Each chunk is
then synthesized + played on its own, so first-audio moves from
"after the full decode" to "after sentence 1".

Design (all pure — no I/O, fully unit-tested on boundary cases):

  * Split on `. ? !` and newline.
  * A MIN chunk length coalesces choppy fragments ("Yes.") into the
    following sentence so Piper never synthesizes a lone word.
  * A MAX buffer length force-flushes a run-on clause (a comma-only
    stream) so audio is never held forever waiting for a period.
  * Common abbreviations ("Dr.", "e.g.", "p.m."), single-letter
    initials, and decimals ("3.5") do NOT split.
  * Deltas may split a sentence across `push()` calls — the buffer
    spans the boundary, so the same code path future-proofs the
    per-token streaming that WARP-1442 will add server-side.
  * `flush()` emits whatever remains at stream end, ignoring the min
    gate (the tail of a reply must always be spoken).

First-clause emission (WARP-3729). The voice persona pins one short
spoken sentence per reply, so with sentence-only boundaries the first
chunk IS the whole reply: first audio waits for every token of it plus
the synthesis of the full sentence (Kokoro synthesizes a whole part
before it writes any audio). The clause rules below shorten that first
chunk; everything after it is synthesized while it plays (the
synth-ahead producer in `voice.pipeline`).

  * `;` and `:` followed by whitespace are ordinary boundaries (same
    min gate, any chunk). Kokoro's own `split_text` already synthesizes
    each `[.!?;:]\\s+` part on its own, so against Kokoro the spoken
    audio is identical to today — the split only lets part 2 be
    synthesized while part 1 plays. Against the legacy Piper server
    (which does not split there) this IS a new join.
  * `,` followed by whitespace ends the FIRST chunk of an utterance
    only (`_emitted == 0`), and only when the clause is at least
    `first_clause_min_chars` long (interjection openers such as "Sure,"
    or "Right now," never split off), the next word does not start with
    a digit ("October 10, 2026" is never cut before the year), and the
    text after the comma can stand as a chunk of its own — at least
    `min_chars` have arrived after it with no boundary inside that
    window ("The kitchen light is on, yes." stays one chunk).
    `first_clause_min_chars=None` restores sentence-only first chunks:
    the one-line rollback.
  * A soft cap applies to the chunk right after a clause cut: once the
    buffer holds `soft_max_chars` with no boundary it is cut at its
    last `, ` (same digit and tail guards), so a long remainder after
    a short first clause is ready before that clause has finished
    playing. Chunks after a sentence boundary keep today's 240-char
    forced cut only.
  * A `,` `;` or `:` that is the LAST char of the buffer waits for the
    next delta (mirrors the digit-period deferral): "1,000" and "3:45"
    never split because the next char is not whitespace.
"""
from __future__ import annotations

from typing import Iterable, Iterator

# Minimum characters (after strip) a chunk must have before a sentence
# boundary is allowed to split it. Below this we keep accumulating so a
# one-word fragment ("Yes.", "Okay.") rides along with the next sentence
# instead of becoming its own choppy synth. Tuned modest: normal spoken
# sentences clear it easily, but 1-3 word fragments coalesce.
DEFAULT_MIN_CHUNK_CHARS = 12

# Maximum characters the buffer may hold with NO qualifying boundary
# before we force a flush. A reply that streams a long comma-spliced
# clause with no `.?!` would otherwise never emit until stream end,
# defeating the point of early first-audio. 240 ≈ a long spoken
# sentence; large enough that real sentences finish on punctuation first.
DEFAULT_MAX_CHUNK_CHARS = 240

# WARP-3729: the shortest first clause worth splitting off (stripped, comma
# included). Excludes interjection openers — "Sure," (5), "Right now," (10),
# "Good morning," (13), "At the moment," (14) — and includes real clauses:
# "The kitchen light is on," (24), "The front camera is online," (27). If
# the comma join sounds wrong on the box, raise this to 30-40 before
# disabling the rule (first_clause_min_chars=None).
DEFAULT_FIRST_CLAUSE_MIN_CHARS = 24

# WARP-3729: buffer length at which the chunk AFTER a clause cut is cut at
# its last comma instead of waiting for a sentence end or the 240-char
# forced cut. Continuity arithmetic (box Kokoro fp32: synth(D) = 0.12 +
# 0.18*D s for D seconds of speech; speech ~18.5 chars/s; tokens arrive at
# 200-500 chars/s): a 24-char first clause (1.3 s of speech) plays from
# t = 0.35 s to t = 1.65 s; an 80-char remainder (4.3 s) has arrived by
# t = 0.16-0.40 s and takes 0.90 s to synthesize, so it is ready at
# t = 1.25-1.30 s — 0.35-0.40 s before the first clause ends. At 100 chars
# the margin would shrink to 0.06-0.36 s.
DEFAULT_CLAUSE_SOFT_MAX_CHARS = 80

# Sentence-ending characters plus the newline the model uses for list-ish
# replies (already discouraged by the voice persona, but handled anyway).
_BOUNDARY_CHARS = frozenset(".?!\n")

# WARP-3729: segment separators (ordinary boundaries once followed by
# whitespace) and the clause separator (first chunk and soft cap only).
_SEGMENT_CHARS = frozenset(";:")
_CLAUSE_CHAR = ","
_CLAUSE_END_CHARS = _SEGMENT_CHARS | {_CLAUSE_CHAR}

# Lowercased abbreviations (WITH the trailing period) that must NOT end a
# sentence. Matched against the token immediately preceding a `.`. Kept
# deliberately small — this is "handle common abbreviations minimally",
# not a full NLP tokenizer. a.m./p.m. are here as their dotted form so
# "I am." (token "am.") still splits correctly.
_ABBREVIATIONS = frozenset(
    {
        "dr.", "mr.", "mrs.", "ms.", "prof.", "sr.", "jr.", "st.",
        "vs.", "etc.", "approx.", "dept.", "fig.", "vol.",
        "gen.", "gov.", "inc.", "ltd.", "co.", "corp.",
        "e.g.", "i.e.", "a.m.", "p.m.",
        # NOTE: "no." is deliberately absent — in a conversational spoken
        # reply "No." is the word far more often than the "number"
        # abbreviation, so it must end a sentence.
    }
)


class SentenceChunker:
    """Accumulate text deltas; emit complete sentence chunks.

    Stateful across `push()` calls so a sentence can span delta
    boundaries. Single-threaded use (the pipeline thread owns one
    instance per utterance) — no internal locking.
    """

    def __init__(
        self,
        *,
        min_chars: int = DEFAULT_MIN_CHUNK_CHARS,
        max_chars: int = DEFAULT_MAX_CHUNK_CHARS,
        first_clause_min_chars: int | None = DEFAULT_FIRST_CLAUSE_MIN_CHARS,
        soft_max_chars: int = DEFAULT_CLAUSE_SOFT_MAX_CHARS,
    ):
        self._min_chars = max(1, int(min_chars))
        self._max_chars = max(self._min_chars, int(max_chars))
        # WARP-3729: None switches the first-clause comma rule off — the
        # one-line rollback to sentence-only first chunks.
        self._first_clause_min = (
            None if first_clause_min_chars is None
            else max(self._min_chars, int(first_clause_min_chars))
        )
        self._soft_max_chars = min(
            self._max_chars, max(self._min_chars, int(soft_max_chars)),
        )
        self._buf = ""
        # Explicit state, not derived from the buffer: how many chunks have
        # been emitted (the comma rule is for the first one only) and
        # whether the LAST one ended at a clause separator (the soft cap is
        # for the chunk that follows one).
        self._emitted = 0
        self._after_clause_cut = False

    def push(self, text: str) -> list[str]:
        """Feed one text delta; return zero or more chunks now complete."""
        if text:
            self._buf += text
        return self._drain(final=False)

    def flush(self) -> list[str]:
        """End of stream: return any remaining text as a final chunk
        (ignoring the min-length gate — the reply's tail must be spoken)."""
        return self._drain(final=True)

    # ── internals ────────────────────────────────────────────────────

    def _drain(self, *, final: bool) -> list[str]:
        out: list[str] = []
        while True:
            idx = self._next_split()
            if idx is not None:
                self._emit(out, idx + 1)
                continue
            if final:
                break
            # No qualifying boundary. WARP-3729: right after a clause cut,
            # cut a long remainder at its last comma so it is synthesized
            # before the (short) chunk before it has finished playing.
            if self._after_clause_cut and len(self._buf) >= self._soft_max_chars:
                cut = self._clause_cut()
                if cut is not None:
                    self._emit(out, cut)
                    continue
            # Force a flush if the buffer has grown past max with nothing
            # to break on.
            if len(self._buf) >= self._max_chars:
                self._emit(out, self._forced_cut())
                continue
            break
        if final:
            rem = self._buf.strip()
            self._buf = ""
            if rem:
                out.append(rem)
                self._emitted += 1
                self._after_clause_cut = False
        return out

    def _emit(self, out: list[str], end: int) -> None:
        """Move `buf[:end]` out as one chunk and record how it was cut."""
        chunk = self._buf[:end].strip()
        self._buf = self._buf[end:]
        if chunk:
            out.append(chunk)
            self._emitted += 1
            self._after_clause_cut = chunk[-1] in _CLAUSE_END_CHARS

    def _next_split(self) -> int | None:
        """Index of the first boundary char that yields a chunk >= min_chars
        (or, for the first chunk, a comma that ends a long enough clause),
        or None if the buffer holds no such boundary yet."""
        buf = self._buf
        for i, ch in enumerate(buf):
            if ch in _BOUNDARY_CHARS:
                if self._is_boundary(buf, i) and self._clears_min(buf, i):
                    return i
            elif ch in _SEGMENT_CHARS:
                if self._is_segment_end(buf, i) and self._clears_min(buf, i):
                    return i
            elif ch == _CLAUSE_CHAR and self._first_clause_min is not None:
                if (
                    self._emitted == 0
                    and self._is_clause_end(buf, i)
                    and len(buf[: i + 1].strip()) >= self._first_clause_min
                    and self._tail_can_stand(buf, i)
                ):
                    return i
        return None

    def _clears_min(self, buf: str, i: int) -> bool:
        return len(buf[: i + 1].strip()) >= self._min_chars

    def _is_boundary(self, buf: str, i: int) -> bool:
        """Whether the boundary char at `buf[i]` really ends a sentence.

        `?`, `!`, and newline are unambiguous. `.` needs care: decimals,
        single-letter initials, and known abbreviations are NOT ends.
        """
        ch = buf[i]
        if ch != ".":
            return True
        prev_is_digit = i > 0 and buf[i - 1].isdigit()
        # Decimal like "3.5": digit on both sides.
        if prev_is_digit and i + 1 < len(buf) and buf[i + 1].isdigit():
            return False
        # A period after a digit that's currently the LAST char is
        # ambiguous ("3." might become "3.5" in the next delta) — defer.
        if prev_is_digit and i + 1 == len(buf):
            return False
        # Preceding token (letters + internal dots) — walk back to a space
        # or non-word char.
        start = i
        while start > 0 and (buf[start - 1].isalnum() or buf[start - 1] == "."):
            start -= 1
        token = buf[start: i + 1]  # includes the trailing period
        stripped = token.replace(".", "")
        # Single-letter initial ("J. Smith", the inner "e." of "e.g.").
        if len(stripped) == 1 and stripped.isalpha():
            return False
        if token.lower() in _ABBREVIATIONS:
            return False
        return True

    @staticmethod
    def _is_segment_end(buf: str, i: int) -> bool:
        """`;` / `:` end a segment only once the following whitespace has
        arrived (WARP-3729): "3:45" never splits, and a trailing `:` waits
        for the next delta."""
        return i + 1 < len(buf) and buf[i + 1].isspace()

    @staticmethod
    def _is_clause_end(buf: str, i: int) -> bool:
        """`,` ends a clause only once the whitespace AND the next word's
        first char have arrived, and that char is not a digit (WARP-3729):
        "1,000" never splits and "October 10, 2026" is not cut before the
        year."""
        if not (i + 1 < len(buf) and buf[i + 1].isspace()):
            return False
        rest = buf[i + 1:].lstrip()
        return bool(rest) and not rest[0].isdigit()

    def _ends_chunk_at(self, buf: str, j: int) -> bool:
        ch = buf[j]
        if ch in _BOUNDARY_CHARS:
            return self._is_boundary(buf, j)
        if ch in _SEGMENT_CHARS:
            return self._is_segment_end(buf, j)
        return False

    def _tail_can_stand(self, buf: str, i: int) -> bool:
        """Tail guard for a comma cut at `buf[i]` (WARP-3729): the text after
        the comma must make a chunk of its own — at least min_chars up to
        the next boundary, or at least min_chars already buffered when no
        boundary has arrived yet. A shorter tail ("yes.", "though.") would
        be synthesized standalone, after a pitch reset, for no gain — so
        the cut is cancelled and the sentence stays whole."""
        for j in range(i + 1, len(buf)):
            if self._ends_chunk_at(buf, j):
                return len(buf[i + 1: j + 1].strip()) >= self._min_chars
        return len(buf[i + 1:].strip()) >= self._min_chars

    def _clause_cut(self) -> int | None:
        """Soft-cap cut for the chunk after a clause cut (WARP-3729): end
        index (exclusive) of the LAST comma inside the soft window whose
        chunk clears min_chars and whose tail can stand on its own, else
        None (the 240-char forced cut then applies as before). Only commas:
        a `;`/`:` that qualified would already have split in _next_split."""
        buf = self._buf
        hi = min(self._soft_max_chars, len(buf))
        for i in range(hi - 1, -1, -1):
            if (
                buf[i] == _CLAUSE_CHAR
                and self._is_clause_end(buf, i)
                and self._clears_min(buf, i)
                and self._tail_can_stand(buf, i)
            ):
                return i + 1
        return None

    def _forced_cut(self) -> int:
        """Cut index for a run-on with no boundary: the last whitespace in
        the [min, max] window, else the hard max (mid-word as last resort)."""
        buf = self._buf
        lo = min(self._min_chars, len(buf))
        hi = min(self._max_chars, len(buf))
        for p in range(hi, lo, -1):
            if buf[p - 1].isspace():
                return p
        return hi


def chunk_stream(
    deltas: Iterable[str],
    *,
    min_chars: int = DEFAULT_MIN_CHUNK_CHARS,
    max_chars: int = DEFAULT_MAX_CHUNK_CHARS,
    first_clause_min_chars: int | None = DEFAULT_FIRST_CLAUSE_MIN_CHARS,
    soft_max_chars: int = DEFAULT_CLAUSE_SOFT_MAX_CHARS,
) -> Iterator[str]:
    """Convenience: run an iterable of text deltas through a fresh
    `SentenceChunker`, yielding each complete chunk then the remainder.

    Lazy — pulls from `deltas` on demand, so a live SSE iterator streams
    straight through without buffering the whole reply."""
    chunker = SentenceChunker(
        min_chars=min_chars,
        max_chars=max_chars,
        first_clause_min_chars=first_clause_min_chars,
        soft_max_chars=soft_max_chars,
    )
    for delta in deltas:
        for chunk in chunker.push(delta):
            yield chunk
    for chunk in chunker.flush():
        yield chunk
