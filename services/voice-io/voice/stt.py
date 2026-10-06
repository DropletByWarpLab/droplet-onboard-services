"""STT via Wyoming protocol — Rhasspy's TCP pub/sub for voice components.

The wake-detect loop (`voice.pipeline`) calls into this module after a
WakeEvent: it streams the captured utterance to a Wyoming STT
sidecar container and gets a transcript back.

We use Wyoming because it's the Home Assistant Voice ecosystem's
standard. The server owns model loading and inference; this client
works with both the CPU Qwen ASR server and the Whisper fallback.

Wyoming wire format (newline-delimited JSON header, optional binary
payload immediately after):

    {"type": "transcribe", "data": {"language": "en"}, "payload_length": 0}\\n
    {"type": "audio-start", "data": {"rate": 16000, "width": 2,
     "channels": 1}, "payload_length": 0}\\n
    {"type": "audio-chunk", "data": {"rate": 16000, "width": 2,
     "channels": 1}, "payload_length": 1280}\\n<1280 bytes of int16 PCM>
    ... more audio-chunk frames ...
    {"type": "audio-stop", "data": null, "payload_length": 0}\\n

Server responds with:

    {"type": "transcript", "data": {"text": "what time is it"},
     "payload_length": 0}\\n

Implementation choices:

  - Synchronous sockets (not asyncio) — the wake-pipeline thread is
    blocking on `stream.read()` anyway; introducing an event loop just
    to talk to a single TCP peer is overhead with no win.
  - No `wyoming` package dependency. The protocol is ~30 lines of
    JSON-frame parsing; pinning rhasspy's library to dance around its
    API churn is more drag than the parser itself.
  - Streaming send. We push each captured 80 ms frame as it arrives
    rather than batching the full utterance in the voice service.
    The server returns the final transcript after audio-stop.

`StreamingSTT` is the abstract interface (mockable for tests).
`WyomingSTT` is the production client. `MockSTT` returns scripted
transcripts for unit tests + the dev-mode "press a button to wake"
shim where there's no real STT server.
"""
from __future__ import annotations

import json
import logging
import math
import socket
import time
from abc import ABC, abstractmethod
from typing import Optional

logger = logging.getLogger("voice.stt")


# Wyoming defaults. Overrides are resolved by build_stt_from_env.
DEFAULT_STT_HOST = "qwen-stt"
DEFAULT_STT_PORT = 10300
DEFAULT_STT_LANGUAGE = "en"
DEFAULT_CONNECT_TIMEOUT_S = 5.0
DEFAULT_TRANSCRIPT_TIMEOUT_S = 90.0  # CPU inference budget after audio-stop
# Total wall-clock ceiling on _read_transcript, independent of the per-recv
# timeout above (which resets on every event). Bounds a chatty/misbehaving
# server that drips non-transcript events forever. See GW-16.

# Audio payload metadata (Wyoming requires this on every audio event).
SAMPLE_RATE = 16_000
SAMPLE_WIDTH_BYTES = 2  # int16
SAMPLE_CHANNELS = 1


class STTUnavailable(Exception):
    """Raised when the STT server isn't reachable or returns an error.

    The pipeline catches this and transitions to state='error' with the
    message exposed via /voice/status — so the dashboard surfaces
    "STT degraded" instead of the entire voice service crashing.
    """


class _ResponseDeadlineExceeded(STTUnavailable):
    """Shared Wyoming read budget expired, independent of the socket timer."""


# ────────────────────────────────────────────────────────────────────
# Abstract interface
# ────────────────────────────────────────────────────────────────────

class StreamingSTT(ABC):
    """One transcription session. Use as a context manager:

        with stt_client.session() as session:
            for frame in audio_frames:
                session.send_chunk(frame)
            transcript = session.finish()

    `session()` returns the session object; the context manager handles
    socket cleanup on exit.
    """

    @abstractmethod
    def session(self) -> "STTSession":
        """Start a new transcription session."""

    @property
    @abstractmethod
    def available(self) -> bool:
        """True iff the STT server is reachable. Status endpoints surface this."""


class STTSession(ABC):
    """One in-flight transcription. Lifecycle:
      1. Construction does the TCP connect + sends `transcribe` + `audio-start`.
      2. send_chunk() may be called any number of times.
      3. finish() sends `audio-stop` and blocks for the transcript.
      4. Context-manager `__exit__` closes the socket regardless.
    """

    @abstractmethod
    def send_chunk(self, audio_bytes: bytes) -> None: ...

    @abstractmethod
    def finish(self) -> str: ...

    @abstractmethod
    def close(self) -> None: ...

    def __enter__(self) -> "STTSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


# ────────────────────────────────────────────────────────────────────
# Wyoming — production client
# ────────────────────────────────────────────────────────────────────

class _WyomingSession(STTSession):
    def __init__(
        self,
        sock: socket.socket,
        language: str,
        transcript_timeout_s: float,
        total_deadline_s: float | None = None,
    ):
        self._sock = sock
        self._closed = False
        self._language = language
        self._transcript_timeout_s = transcript_timeout_s
        # Total wall-clock budget for _read_transcript. Defaults to the
        # per-recv timeout so a chatty server can't hold the worker
        # thread indefinitely (GW-16).
        self._total_deadline_s = (
            total_deadline_s
            if total_deadline_s is not None
            else transcript_timeout_s
        )
        # `transcribe` is the "start a new transcription" event; data
        # carries the language hint. The server uses this to seed the
        # decoder language without us needing to ship a language-
        # detection pass first.
        self._send_event("transcribe", {"language": language})
        self._send_event("audio-start", _audio_metadata())

    def send_chunk(self, audio_bytes: bytes) -> None:
        # The wake-pipeline's 80 ms frame is 1280 int16 samples = 2560 bytes.
        # Wyoming's audio-chunk wraps it 1:1.
        self._send_event("audio-chunk", _audio_metadata(), payload=audio_bytes)

    def finish(self) -> str:
        """Send audio-stop and block for the transcript event."""
        self._send_event("audio-stop")
        return self._read_transcript()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._sock.close()
        except OSError:
            pass

    # ── wire format helpers ──────────────────────────────────────

    def _send_event(
        self,
        event_type: str,
        data: Optional[dict] = None,
        payload: bytes = b"",
    ) -> None:
        # One Wyoming event = JSON header line + (optional) binary payload.
        header = {"type": event_type, "data": data, "payload_length": len(payload)}
        line = (json.dumps(header) + "\n").encode("utf-8")
        try:
            self._sock.sendall(line)
            if payload:
                self._sock.sendall(payload)
        except OSError as exc:
            raise STTUnavailable(f"send {event_type} failed: {exc}") from exc

    def _read_transcript(self) -> str:
        """Block until the server sends a `transcript` event.

        The server emits one final transcript after `audio-stop`.

        GW-16: ``settimeout`` only bounds each individual ``recv``, and it's
        reset on every event. A misbehaving/old server that streams a steady
        drip of non-transcript events (partials, acks) would keep resetting the
        per-recv clock forever, so the total time the (single-threaded) pipeline
        worker is blocked in ``finish()`` is unbounded — wake detection stalls
        indefinitely. We therefore also enforce a TOTAL wall-clock deadline
        (``_total_deadline_s``) across all events, independent of per-recv
        resets.
        """
        self._sock.settimeout(self._transcript_timeout_s)
        deadline = time.monotonic() + self._total_deadline_s
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise STTUnavailable(
                        f"transcript wall-clock deadline exceeded "
                        f"({self._total_deadline_s:.1f} s) — server streamed "
                        f"events but no final transcript"
                    )
                event = _read_event(self._sock, deadline=deadline)
                # The wire helpers also bound each recv (including incomplete
                # events). Recheck after parsing before accepting a late result.
                if time.monotonic() >= deadline:
                    raise STTUnavailable(
                        f"transcript wall-clock deadline exceeded "
                        f"({self._total_deadline_s:.1f} s) — server streamed "
                        f"events but no final transcript"
                    )
                if event is None:
                    raise STTUnavailable("server closed connection before transcript")
                header, _payload = event  # payload already drained by _read_event
                if header.get("type") == "error":
                    data = header.get("data") or {}
                    code = data.get("code") or "stt_error"
                    raise STTUnavailable(f"STT server error: {code}")
                if header.get("type") == "transcript":
                    text = (header.get("data") or {}).get("text", "")
                    return text.strip()
                # Other event types we currently ignore (e.g. server-
                # emitted `audio-stop` ack from older Wyoming versions).
        except _ResponseDeadlineExceeded as exc:
            raise STTUnavailable(
                f"transcript wall-clock deadline exceeded ({self._total_deadline_s:.1f} s)"
            ) from exc
        except socket.timeout as exc:
            if time.monotonic() >= deadline:
                raise STTUnavailable(
                    f"transcript wall-clock deadline exceeded "
                    f"({self._total_deadline_s:.1f} s)"
                ) from exc
            raise STTUnavailable(
                f"transcript timeout after {self._transcript_timeout_s:.1f} s"
            ) from exc
        except OSError as exc:
            raise STTUnavailable(f"recv failed: {exc}") from exc


class WyomingSTT(StreamingSTT):
    def __init__(
        self,
        host: str = DEFAULT_STT_HOST,
        port: int = DEFAULT_STT_PORT,
        language: str = DEFAULT_STT_LANGUAGE,
        connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
        transcript_timeout_s: float = DEFAULT_TRANSCRIPT_TIMEOUT_S,
        total_deadline_s: float | None = None,
    ):
        self._host = host
        self._port = port
        self._language = language
        self._connect_timeout_s = connect_timeout_s
        self._transcript_timeout_s = transcript_timeout_s
        # Total wall-clock ceiling for the transcript read (GW-16). None →
        # the session derives it from transcript_timeout_s.
        self._total_deadline_s = total_deadline_s

    @property
    def available(self) -> bool:
        """Cheap reachability probe. Opens + closes a TCP connection;
        does NOT issue a transcribe (which would be expensive and would
        leave a half-session on the server).

        We call this once at startup to flip /voice/status's sttLoaded
        flag; subsequent failures surface via session() raising.
        """
        try:
            with socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout_s,
            ):
                return True
        except OSError as exc:
            logger.info("wyoming STT %s:%d unreachable: %s", self._host, self._port, exc)
            return False

    def session(self) -> STTSession:
        try:
            sock = socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout_s,
            )
        except OSError as exc:
            raise STTUnavailable(
                f"connect to wyoming STT {self._host}:{self._port} failed: {exc}"
            ) from exc
        # socket.create_connection's timeout only governs the connect.
        # The socket reverts to blocking afterwards, so a stalled wyoming
        # peer (TCP send buffer full, container OOM-pause, etc.) would
        # hang every `sendall` in _send_event / send_chunk forever and
        # wedge the pipeline worker thread. Pin send-side timeout to the
        # same connect-timeout budget; _read_transcript already does the
        # same on the read side via settimeout(transcript_timeout_s) at
        # send-stop. See PR #227 review.
        sock.settimeout(self._connect_timeout_s)
        return _WyomingSession(
            sock, language=self._language,
            transcript_timeout_s=self._transcript_timeout_s,
            total_deadline_s=self._total_deadline_s,
        )


# ────────────────────────────────────────────────────────────────────
# Mock — tests + dev-mode no-STT-server fallback
# ────────────────────────────────────────────────────────────────────

class _MockSession(STTSession):
    """One mock session. Pops from the parent's shared script list so
    successive sessions see successive transcripts — the natural shape
    when tests script N wakes in a row.
    """

    def __init__(self, parent: "MockSTT"):
        self._parent = parent
        self._sent_chunks = 0
        self._closed = False

    def send_chunk(self, audio_bytes: bytes) -> None:
        self._sent_chunks += 1

    def finish(self) -> str:
        if not self._parent._scripts:
            return ""
        return self._parent._scripts.pop(0)

    def close(self) -> None:
        self._closed = True


class MockSTT(StreamingSTT):
    """Returns scripted transcripts. Tests inject this directly; the
    runtime never picks it unless `STT_URL=__mock__` is set."""

    def __init__(
        self,
        scripted_transcripts: Optional[list[str]] = None,
        available: bool = True,
    ):
        # Shared mutable list — each session pops the next transcript
        # from this. Tests that script N wakes get N distinct
        # transcripts in order.
        self._scripts: list[str] = list(scripted_transcripts or [])
        self._available = available
        self._sessions_opened = 0

    @property
    def available(self) -> bool:
        return self._available

    def session(self) -> STTSession:
        self._sessions_opened += 1
        return _MockSession(self)

    @property
    def sessions_opened(self) -> int:
        return self._sessions_opened


# ────────────────────────────────────────────────────────────────────
# Wire helpers
# ────────────────────────────────────────────────────────────────────

def _audio_metadata() -> dict:
    return {
        "rate": SAMPLE_RATE,
        "width": SAMPLE_WIDTH_BYTES,
        "channels": SAMPLE_CHANNELS,
    }


def _read_json_line(
    sock: socket.socket, deadline: float | None = None,
) -> Optional[dict]:
    """Read bytes up to the next \\n and decode as JSON.

    Returns None if the peer closed cleanly before sending anything.
    Raises STTUnavailable if the line isn't valid JSON.
    """
    buf = bytearray()
    while True:
        b = _recv_before_deadline(sock, 1, deadline)
        if not b:
            return None if not buf else _raise_partial(buf)
        if b == b"\n":
            break
        buf.extend(b)
    try:
        return json.loads(buf.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise STTUnavailable(f"bad JSON from server: {buf!r}: {exc}") from exc


def _read_event(
    sock: socket.socket,
    deadline: float | None = None,
) -> Optional[tuple[dict, bytes]]:
    """Read one complete Wyoming event: header + optional data block +
    optional binary payload. Returns (header_with_normalized_data, payload).

    Wyoming has two wire formats for the `data` field:
      v1: data inline in the header — `{"type":"x", "data":{...},
          "payload_length":N}\\n` then N payload bytes.
      v2: data in a separate JSON block — `{"type":"x", "data_length":M,
          "payload_length":N}\\n<M bytes JSON><N bytes payload>`.

    Different rhasspy/wyoming-* image versions pick different formats
    (Whisper-current ships v1, Piper-current ships v2). The Wyoming
    spec allows either; we normalize so callers only see one shape:
    `header["data"]` is either the inline dict or the parsed v2 block,
    whichever the server sent. Callers never have to know.

    Returns None on clean peer close before any data arrived.
    """
    header = _read_json_line(sock, deadline)
    if header is None:
        return None
    data_length = int(header.get("data_length") or 0)
    if data_length > 0:
        # v2 path: read the separate JSON data block. Overrides any
        # inline `data` field (servers should send one or the other,
        # not both — but if both, the v2 block is the authoritative
        # one because it's the bytes that just hit the wire).
        raw = _read_exactly(sock, data_length, deadline)
        try:
            header["data"] = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise STTUnavailable(
                f"bad JSON data block from server: {raw!r}: {exc}"
            ) from exc
    payload_length = int(header.get("payload_length") or 0)
    payload = _read_exactly(sock, payload_length, deadline) if payload_length > 0 else b""
    return header, payload


def _raise_partial(buf: bytearray) -> None:
    raise STTUnavailable(f"peer closed mid-line: {bytes(buf)!r}")


def _bound_read_timeout(sock: socket.socket, deadline: float | None) -> bool:
    """Bound every recv, including partial headers/data, by the total budget."""
    if deadline is None:
        return False
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _ResponseDeadlineExceeded("Wyoming response wall-clock deadline exceeded")
    current = sock.gettimeout()
    sock.settimeout(min(current, remaining) if current is not None else remaining)
    # Subtracting monotonic timestamps can add a fractional microsecond;
    # that must not relabel an equal total/socket budget as a socket timeout.
    return current is None or remaining <= current + 1e-6


def _recv_before_deadline(sock: socket.socket, count: int, deadline: float | None) -> bytes:
    deadline_bound = _bound_read_timeout(sock, deadline)
    try:
        return sock.recv(count)
    except socket.timeout as exc:
        # Socket timers can expire slightly early on Windows. Classify by
        # which budget bounded the read, rather than comparing clocks again.
        if deadline_bound:
            raise _ResponseDeadlineExceeded("Wyoming response wall-clock deadline exceeded") from exc
        raise


def _read_exactly(
    sock: socket.socket, n: int, deadline: float | None = None,
) -> bytes:
    """Block until exactly n bytes are received; raise if peer closes early."""
    buf = bytearray()
    while len(buf) < n:
        chunk = _recv_before_deadline(sock, n - len(buf), deadline)
        if not chunk:
            raise STTUnavailable(
                f"peer closed after {len(buf)}/{n} payload bytes",
            )
        buf.extend(chunk)
    return bytes(buf)


# ────────────────────────────────────────────────────────────────────
# Factory — picks the right STT client for the current env.
# ────────────────────────────────────────────────────────────────────

def build_stt_from_env() -> StreamingSTT:
    """Resolve env config → STT client.

    `STT_URL` accepts:
      - `tcp://host:port`  → WyomingSTT
      - `__mock__`         → MockSTT (dev mode, no real server)
      - (empty / unset)    → WyomingSTT against the default in-compose host
    """
    import os
    import urllib.parse

    raw = (os.environ.get("STT_URL") or "").strip()
    language = (os.environ.get("STT_LANGUAGE") or DEFAULT_STT_LANGUAGE).strip() or DEFAULT_STT_LANGUAGE
    if raw == "__mock__":
        logger.info("STT_URL=__mock__ → MockSTT (dev only, no transcripts)")
        return MockSTT()
    timeout_raw = (os.environ.get("STT_TRANSCRIPT_TIMEOUT_S") or "").strip()
    try:
        timeout = float(timeout_raw) if timeout_raw else DEFAULT_TRANSCRIPT_TIMEOUT_S
        if not math.isfinite(timeout) or not 1.0 <= timeout <= 300.0:
            raise ValueError("timeout must be between 1 and 300 seconds")
    except ValueError:
        logger.warning("invalid STT_TRANSCRIPT_TIMEOUT_S; using %.1f s", DEFAULT_TRANSCRIPT_TIMEOUT_S)
        timeout = DEFAULT_TRANSCRIPT_TIMEOUT_S
    if not raw:
        return WyomingSTT(language=language, transcript_timeout_s=timeout)
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "tcp" or not parsed.hostname or not parsed.port:
        logger.warning(
            "STT_URL=%r not in tcp://host:port form; falling back to default", raw,
        )
        return WyomingSTT(language=language, transcript_timeout_s=timeout)
    return WyomingSTT(
        host=parsed.hostname, port=parsed.port, language=language,
        transcript_timeout_s=timeout,
    )
