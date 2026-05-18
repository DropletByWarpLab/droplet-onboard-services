"""STT via Wyoming protocol — Rhasspy's TCP pub/sub for voice components.

The wake-detect loop (`voice.pipeline`) calls into this module after a
WakeEvent: it streams the next few seconds of captured audio to a
wyoming-faster-whisper sidecar container and gets a transcript back.

We use Wyoming because it's the Home Assistant Voice ecosystem's
standard — biggest OSS surface in this space, and the
`rhasspy/wyoming-faster-whisper` image is a thin wrapper around
faster-whisper that handles model loading + GPU/CPU detection for us.

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
    rather than batching the full 5 s — faster-whisper's server can
    begin transcription as the audio flows, so total latency is
    capture-time + ~300 ms instead of capture-time + 1.5 s.

`StreamingSTT` is the abstract interface (mockable for tests).
`WyomingSTT` is the production client. `MockSTT` returns scripted
transcripts for unit tests + the dev-mode "press a button to wake"
shim where there's no real STT server.
"""
from __future__ import annotations

import json
import logging
import socket
from abc import ABC, abstractmethod
from typing import Optional

logger = logging.getLogger("voice.stt")


# Wyoming defaults. Override via env in main.py.
DEFAULT_STT_HOST = "wyoming-faster-whisper"
DEFAULT_STT_PORT = 10300
DEFAULT_STT_LANGUAGE = "en"
DEFAULT_CONNECT_TIMEOUT_S = 5.0
DEFAULT_TRANSCRIPT_TIMEOUT_S = 10.0  # max wait for final transcript after audio-stop

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
    ):
        self._sock = sock
        self._closed = False
        self._language = language
        self._transcript_timeout_s = transcript_timeout_s
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

        Wyoming-faster-whisper may emit intermediate `transcript` events
        with partial text during streaming — we ignore those and wait
        for the final one (the one sent after `audio-stop`). In practice
        the server only emits ONE transcript per session in batch mode,
        so the first event is also the last.
        """
        self._sock.settimeout(self._transcript_timeout_s)
        try:
            while True:
                event = _read_event(self._sock)
                if event is None:
                    raise STTUnavailable("server closed connection before transcript")
                header, _payload = event  # payload already drained by _read_event
                if header.get("type") == "transcript":
                    text = (header.get("data") or {}).get("text", "")
                    return text.strip()
                # Other event types we currently ignore (e.g. server-
                # emitted `audio-stop` ack from older Wyoming versions).
        except socket.timeout as exc:
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
    ):
        self._host = host
        self._port = port
        self._language = language
        self._connect_timeout_s = connect_timeout_s
        self._transcript_timeout_s = transcript_timeout_s

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


def _read_json_line(sock: socket.socket) -> Optional[dict]:
    """Read bytes up to the next \\n and decode as JSON.

    Returns None if the peer closed cleanly before sending anything.
    Raises STTUnavailable if the line isn't valid JSON.
    """
    buf = bytearray()
    while True:
        b = sock.recv(1)
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
    header = _read_json_line(sock)
    if header is None:
        return None
    data_length = int(header.get("data_length") or 0)
    if data_length > 0:
        # v2 path: read the separate JSON data block. Overrides any
        # inline `data` field (servers should send one or the other,
        # not both — but if both, the v2 block is the authoritative
        # one because it's the bytes that just hit the wire).
        raw = _read_exactly(sock, data_length)
        try:
            header["data"] = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise STTUnavailable(
                f"bad JSON data block from server: {raw!r}: {exc}"
            ) from exc
    payload_length = int(header.get("payload_length") or 0)
    payload = _read_exactly(sock, payload_length) if payload_length > 0 else b""
    return header, payload


def _raise_partial(buf: bytearray) -> None:
    raise STTUnavailable(f"peer closed mid-line: {bytes(buf)!r}")


def _read_exactly(sock: socket.socket, n: int) -> bytes:
    """Block until exactly n bytes are received; raise if peer closes early."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
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
    if not raw:
        return WyomingSTT(language=language)
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "tcp" or not parsed.hostname or not parsed.port:
        logger.warning(
            "STT_URL=%r not in tcp://host:port form; falling back to default", raw,
        )
        return WyomingSTT(language=language)
    return WyomingSTT(
        host=parsed.hostname, port=parsed.port, language=language,
    )
