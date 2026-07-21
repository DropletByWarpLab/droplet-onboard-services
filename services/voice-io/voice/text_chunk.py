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

# Sentence-ending characters plus the newline the model uses for list-ish
# replies (already discouraged by the voice persona, but handled anyway).
_BOUNDARY_CHARS = frozenset(".?!\n")

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
    ):
        self._min_chars = max(1, int(min_chars))
        self._max_chars = max(self._min_chars, int(max_chars))
        self._buf = ""

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
                chunk = self._buf[: idx + 1].strip()
                self._buf = self._buf[idx + 1:]
                if chunk:
                    out.append(chunk)
                continue
            # No qualifying sentence boundary. Force a flush if the buffer
            # has grown past max with nothing to break on.
            if not final and len(self._buf) >= self._max_chars:
                cut = self._forced_cut()
                chunk = self._buf[:cut].strip()
                self._buf = self._buf[cut:]
                if chunk:
                    out.append(chunk)
                continue
            break
        if final:
            rem = self._buf.strip()
            self._buf = ""
            if rem:
                out.append(rem)
        return out

    def _next_split(self) -> int | None:
        """Index of the first boundary char that yields a chunk >= min_chars,
        or None if the buffer holds no such boundary yet."""
        buf = self._buf
        for i, ch in enumerate(buf):
            if ch in _BOUNDARY_CHARS and self._is_boundary(buf, i):
                if len(buf[: i + 1].strip()) >= self._min_chars:
                    return i
        return None

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
) -> Iterator[str]:
    """Convenience: run an iterable of text deltas through a fresh
    `SentenceChunker`, yielding each complete chunk then the remainder.

    Lazy — pulls from `deltas` on demand, so a live SSE iterator streams
    straight through without buffering the whole reply."""
    chunker = SentenceChunker(min_chars=min_chars, max_chars=max_chars)
    for delta in deltas:
        for chunk in chunker.push(delta):
            yield chunk
    for chunk in chunker.flush():
        yield chunk
