"""Per-person voiceprints — on-box speaker identification (WARP-1056).

The dashboard's Flow B enrollment ("so it knows it's me") captures four
scripted lines plus one no-script verify utterance on the BOX mic, turns
each capture into a fixed-length speaker embedding, and stores the mean
embedding as the person's voiceprint. Matching is cosine similarity
against the stored voiceprints, reported to callers ONLY as a plain
word ("high" / "good") — never a percentage or raw score.

Privacy invariants (design brief §3.3/§5 — enforced here, not promised):

  * Raw audio is NEVER persisted. Each capture is embedded immediately
    and the PCM buffer is dropped; what survives is a 512-float
    "mathematical summary of how you sound — not a recording".
  * Voiceprints live in per-user JSON files on the voice-calibration
    named volume (`/data/voiceprints`), on this box only. They are never
    uploaded anywhere, never written to Postgres (no interaction with
    the WARP-242 brain-encryption work), and factory-reset's volume
    sweep wipes them.
  * Delete is immediate and complete: `VoiceprintStore.delete()` is a
    synchronous file removal, and cancelling an enrollment discards the
    in-memory session embeddings on the spot.

╔════════════════════════════════════════════════════════════════════╗
║ HARD RULE — voice identity PERSONALIZES, it never AUTHENTICATES.   ║
║ A match result carries no session, no token, no role, and no       ║
║ authority: it may select whose calendar is read aloud, never       ║
║ approve a Write/Build-tier action. Confirm-tier actions triggered  ║
║ by a recognized speaker still route to the dashboard/phone for the ║
║ explicit confirm (brief §5 note, FEATURES.md §6).                  ║
╚════════════════════════════════════════════════════════════════════╝

Model: 3D-Speaker CAM++ speaker-verification model (English, trained on
VoxCeleb) exported to ONNX — Apache-2.0, ~28 MB, CPU-real-time (~36 ms
for 4 s of audio on a laptop core). The weights are baked into the
image at BUILD time with a pinned SHA-256 (same supply-chain pattern as
the Vosk wake model in the Dockerfile); the runtime never downloads
anything, keeping the telemetry-free invariant (WARP-269) and the
audited-egress posture (ADR-012) intact. Features are 80-dim Kaldi
fbanks (dither 0, snip-edges) via kaldi-native-fbank — the exact
frontend the model was trained/exported against — followed by the
global-mean normalization the model metadata declares.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

# Both deps are guarded like sounddevice in audio_io.py: onnxruntime is
# already a voice-io runtime dep (openWakeWord's backend) but may be
# absent in a dev venv; kaldi-native-fbank ships manylinux wheels for
# the container's py3.12 but may have none for a dev box's interpreter.
# Without either, the embedder reports unavailable and the enrollment
# endpoints answer 503 — the service itself keeps running.
try:
    import onnxruntime as _ort  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — import guard
    _ort = None  # type: ignore[assignment]

try:
    import kaldi_native_fbank as _knf  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — import guard
    _knf = None  # type: ignore[assignment]

logger = logging.getLogger("voice.speaker_id")

# Baked by the Dockerfile's pinned-checksum fetch (see the
# "speaker-embedding model" build step); override for tests/dev.
DEFAULT_SPEAKER_MODEL_PATH = "/app/models/speaker/campplus-voxceleb-en.onnx"
SPEAKER_MODEL_NAME = "campplus-voxceleb-en"

# Per-user voiceprint JSON files under the compose-mounted named volume
# (`voice-calibration` → /data — the same volume the calibration record
# rides; factory-reset's sweep wipes both). Override via
# VOICE_PROFILES_DIR (tests point it at tmp_path).
DEFAULT_PROFILES_DIR = "/data/voiceprints"

# Flow B shape (brief §5): 4 scripted lines, plus up to 2 "sharpen"
# lines appended after a failed no-script verify.
REQUIRED_LINES = 4
MAX_TOTAL_LINES = 6

# An abandoned enrollment session (browser tab closed mid-flow without
# the cancel DELETE landing) must not hold embeddings in RAM forever.
# Purged lazily on the next session-store access — no timer thread.
SESSION_TTL_S = 15 * 60.0

# ── Matching thresholds (documented judgment calls, not spec constants) ──
#
# CAM++/VoxCeleb cosine scores for same-speaker utterances typically land
# ~0.4–0.7 against a multi-utterance enrollment mean; different speakers
# land near 0. The two words the UI may show (§5 step 3: "confidence
# shown as a plain word (High / Good), never a percentage"):
MATCH_HIGH_SIM = 0.55
MATCH_GOOD_SIM = 0.35
# §7.6 — two ENROLLED voiceprints at/above this cosine are hard to tell
# apart (siblings); both profile rows surface the orange
# "Sometimes confused with [Name]" note instead of silently
# misattributing.
CONFUSABLE_SIM = 0.60
# Capture-quality guard (§5 step 2): a line whose peak never clears this
# is "too quiet/noisy" and gets the one re-prompt. Matches the wizard's
# speech-peak pass bar (dashboard state.ts SPEECH_PEAK_PASS_DBFS).
CAPTURE_MIN_PEAK_DBFS = -35.0
# §7.5 crosstalk guard: one talker's first and second half of the same
# line embed nearly alike; two overlapping talkers don't. Below this
# half-vs-half self-similarity (with BOTH halves carrying speech-level
# energy) the capture is rejected as crosstalk. Deliberately low —
# a false "two people" block on a solo speaker is worse than letting a
# borderline capture through (the verify step catches bad enrollments).
CROSSTALK_SELF_SIM = 0.35

# Voiceprints are keyed by the orchestrator's User UUID/cuid. The
# pattern is the path-traversal gate for the per-user filename — reject
# anything that isn't a plain id BEFORE it touches a path join.
USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class SpeakerIdUnavailable(RuntimeError):
    """Embedder can't run here (deps or model weights absent)."""


def peak_dbfs(pcm16: np.ndarray) -> float:
    """Peak level of an int16 buffer in dBFS (same math as audio_io's
    measure_input_level — duplicated locally so this module stays
    self-contained and hardware-free for tests)."""
    f = np.asarray(pcm16).astype(np.float32) / 32768.0
    if f.size == 0:
        return -120.0
    peak = float(np.max(np.abs(f)))
    return round(20.0 * float(np.log10(max(peak, 1e-6))), 1)


def compute_fbank(pcm16: np.ndarray, samplerate: int) -> np.ndarray:
    """80-dim Kaldi fbank frames (T, 80) + global-mean normalization.

    Mirrors the sherpa-onnx speaker-embedding frontend the model was
    exported against: dither off, snip-edges, samples scaled to
    [-1, 1] (the model metadata's `normalize_samples`), then per-
    utterance mean subtraction (`feature_normalize_type: global-mean`).
    """
    if _knf is None:
        raise SpeakerIdUnavailable(
            "kaldi-native-fbank not loaded — speaker features unavailable",
        )
    opts = _knf.FbankOptions()
    opts.frame_opts.samp_freq = samplerate
    opts.frame_opts.dither = 0.0
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = 80
    extractor = _knf.OnlineFbank(opts)
    samples = np.asarray(pcm16).astype(np.float32).reshape(-1) / 32768.0
    extractor.accept_waveform(samplerate, samples.tolist())
    extractor.input_finished()
    n = extractor.num_frames_ready
    if n == 0:
        raise SpeakerIdUnavailable("capture too short for a single fbank frame")
    frames = np.stack([extractor.get_frame(i) for i in range(n)])
    return frames - frames.mean(axis=0, keepdims=True)


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(v))
    return v / norm if norm > 0.0 else v


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two L2-normalized embeddings."""
    return float(np.dot(l2_normalize(a), l2_normalize(b)))


def confidence_word(sim: float) -> Optional[str]:
    """Cosine similarity → the plain word the UI may show. Returns None
    below the match floor. NEVER expose the raw similarity to clients —
    the wire contract is words only (brief §5 step 3)."""
    if sim >= MATCH_HIGH_SIM:
        return "high"
    if sim >= MATCH_GOOD_SIM:
        return "good"
    return None


class OnnxSpeakerEmbedder:
    """CAM++ ONNX speaker embedder: int16 PCM → L2-normalized (512,).

    Session load is lazy (first embed), mirroring the wake detector's
    lazy model load — constructing this at startup stays cheap."""

    def __init__(self, model_path: str) -> None:
        self.model_path = model_path
        self._session: Optional[Any] = None

    def embed(self, pcm16: np.ndarray, samplerate: int) -> np.ndarray:
        if _ort is None:
            raise SpeakerIdUnavailable(
                "onnxruntime not loaded — speaker embedding unavailable",
            )
        if self._session is None:
            try:
                self._session = _ort.InferenceSession(
                    self.model_path, providers=["CPUExecutionProvider"],
                )
            except Exception as exc:  # corrupt weights, bad SPEAKER_MODEL_PATH, etc.
                raise SpeakerIdUnavailable(
                    f"failed to load speaker model at {self.model_path}: {exc}",
                ) from exc
            logger.info("speaker model loaded: %s", self.model_path)
        feats = compute_fbank(pcm16, samplerate)[None].astype(np.float32)
        try:
            (out,) = self._session.run(None, {"x": feats})
        except Exception as exc:  # onnxruntime raises its own Fail/RuntimeException types
            raise SpeakerIdUnavailable(f"speaker embedding inference failed: {exc}") from exc
        return l2_normalize(out[0])


def build_embedder_from_env() -> Optional[OnnxSpeakerEmbedder]:
    """Embedder when the deps + baked weights are present, else None.

    None is the honest degraded mode (offline image build skipped the
    fetch, or a dev host without the wheels): the enrollment/match
    endpoints answer 503 and the dashboard keeps its entry points
    disabled — never a wizard that cannot succeed (§7.2 rule)."""
    path = (
        (os.environ.get("SPEAKER_MODEL_PATH") or "").strip()
        or DEFAULT_SPEAKER_MODEL_PATH
    )
    if _ort is None or _knf is None:
        logger.warning(
            "speaker-id unavailable: onnxruntime/kaldi-native-fbank not loaded",
        )
        return None
    if not os.path.isfile(path):
        logger.warning("speaker-id unavailable: model not found at %s", path)
        return None
    return OnnxSpeakerEmbedder(path)


EmbedFn = Callable[[np.ndarray], np.ndarray]


def assess_capture(
    pcm16: np.ndarray,
    embed: EmbedFn,
) -> tuple[Optional[np.ndarray], str]:
    """Quality-guard one enrollment capture → (embedding | None, quality).

    quality ∈ {"good", "too_quiet", "crosstalk"}:

      * too_quiet — peak never cleared CAPTURE_MIN_PEAK_DBFS; the wizard
        re-prompts once ("That one was hard to hear — once more.").
      * crosstalk (§7.5) — both halves of the capture carry speech-level
        energy but embed as DIFFERENT voices (half-vs-half cosine below
        CROSSTALK_SELF_SIM). One talker is self-similar across a single
        line; overlapping talkers are not. The wizard shows the §7.5
        copy verbatim.
      * good — the full-capture embedding is returned.
    """
    pcm = np.asarray(pcm16).reshape(-1)
    if peak_dbfs(pcm) < CAPTURE_MIN_PEAK_DBFS:
        return None, "too_quiet"
    half = pcm.size // 2
    first, second = pcm[:half], pcm[half:]
    if (
        peak_dbfs(first) >= CAPTURE_MIN_PEAK_DBFS
        and peak_dbfs(second) >= CAPTURE_MIN_PEAK_DBFS
    ):
        self_sim = cosine(embed(first), embed(second))
        if self_sim < CROSSTALK_SELF_SIM:
            return None, "crosstalk"
    return embed(pcm), "good"


# ────────────────────────────────────────────────────────────────────
# Voiceprint persistence — one JSON file per enrolled person
# ────────────────────────────────────────────────────────────────────

class VoiceprintStore:
    """Per-user voiceprint files under VOICE_PROFILES_DIR.

    Same posture as CalibrationStore: construction is cheap and reads
    the env each time (fresh store per request; tests re-point the env),
    saves are atomic (temp file + fsync + rename), corrupt files read as
    absent rather than raising. delete() is a synchronous, immediate
    file removal — the "deleted instantly when removed" caption in the
    dashboard is this method's contract, not marketing.
    """

    def __init__(self, directory: Optional[str] = None) -> None:
        self.dir = Path(
            directory
            or (os.environ.get("VOICE_PROFILES_DIR") or "").strip()
            or DEFAULT_PROFILES_DIR,
        )

    def _path(self, user_id: str) -> Path:
        if not USER_ID_RE.match(user_id):
            raise ValueError(f"invalid user id: {user_id!r}")
        return self.dir / f"{user_id}.json"

    def load(self, user_id: str) -> Optional[dict[str, Any]]:
        try:
            raw = self._path(user_id).read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as exc:
            logger.warning("voiceprint %s unreadable: %s", user_id, exc)
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("voiceprint %s is corrupt — ignoring", user_id)
            return None
        return data if isinstance(data, dict) else None

    def load_all(self) -> list[dict[str, Any]]:
        if not self.dir.is_dir():
            return []
        records = []
        for path in sorted(self.dir.glob("*.json")):
            record = self.load(path.stem) if USER_ID_RE.match(path.stem) else None
            if record:
                records.append(record)
        return records

    def save(self, record: dict[str, Any]) -> None:
        path = self._path(str(record["user_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(path.parent), prefix=".voiceprint-", suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(record, f)
                # fsync before rename — same old-or-new guarantee as
                # CalibrationStore.save (a crash never leaves a truncated
                # file that load() would half-trust).
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        logger.info("voiceprint saved for user %s", record["user_id"])

    def delete(self, user_id: str) -> bool:
        """Immediate removal. True when a voiceprint existed. Idempotent —
        a repeat delete is a no-op, never an error."""
        path = self._path(user_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        logger.info("voiceprint deleted for user %s", user_id)
        return True

    def touch_recognized(self, user_id: str, at: Optional[float] = None) -> None:
        """Stamp last_recognized_at (drives the row meta 'last recognized
        today'). Best-effort — a missing record is a no-op."""
        record = self.load(user_id)
        if not record:
            return
        record["last_recognized_at"] = at if at is not None else time.time()
        self.save(record)


def annotate_confusable(records: list[dict[str, Any]]) -> None:
    """§7.6 — mark enrolled pairs that are hard to tell apart.

    Mutates each record with `confused_with`: the OTHER user's id when
    the two stored voiceprints' cosine is at/above CONFUSABLE_SIM (the
    most-similar other wins when several collide), else None. Both rows
    get the annotation — the dashboard renders the orange
    "Sometimes confused with [Name] — re-recording either voice helps"
    meta on each; never silently misattribute without surfacing it.
    """
    embeddings = [np.asarray(r.get("embedding", []), dtype=np.float32) for r in records]
    for record in records:
        record["confused_with"] = None
    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            if embeddings[i].size == 0 or embeddings[j].size == 0:
                continue
            sim = cosine(embeddings[i], embeddings[j])
            if sim >= CONFUSABLE_SIM:
                for a, b in ((i, j), (j, i)):
                    prev = records[a].get("_confusable_sim", -1.0)
                    if sim > prev:
                        records[a]["confused_with"] = records[b]["user_id"]
                        records[a]["_confusable_sim"] = sim
    for record in records:
        record.pop("_confusable_sim", None)


def match_against(
    candidate: np.ndarray,
    records: list[dict[str, Any]],
) -> tuple[Optional[str], float]:
    """Best-matching enrolled user for a candidate embedding →
    (user_id | None, similarity). The similarity is INTERNAL — callers
    map it through confidence_word() before it crosses the API."""
    best_id: Optional[str] = None
    best_sim = -1.0
    for record in records:
        embedding = np.asarray(record.get("embedding", []), dtype=np.float32)
        if embedding.size == 0:
            continue
        sim = cosine(candidate, embedding)
        if sim > best_sim:
            best_id, best_sim = str(record["user_id"]), sim
    if best_id is None or confidence_word(best_sim) is None:
        return None, best_sim
    return best_id, best_sim


# ────────────────────────────────────────────────────────────────────
# Enrollment sessions — in-memory only, discard-on-cancel
# ────────────────────────────────────────────────────────────────────

class EnrollmentSession:
    """One Flow B run: the per-line embeddings + the verify outcome.

    Embeddings only — the PCM of each line is dropped the moment it's
    embedded, so "Cancel deletes these recordings now" is literally a
    dict.pop (there is nothing else to delete)."""

    def __init__(self, user_id: str) -> None:
        self.id = secrets.token_hex(16)
        self.user_id = user_id
        self.created_at = time.time()
        self.embeddings: list[np.ndarray] = []
        self.verify_attempts = 0
        self.verify_matched = False

    def mean_embedding(self) -> np.ndarray:
        return l2_normalize(np.mean(np.stack(self.embeddings), axis=0))


class EnrollmentSessions:
    """TTL'd in-memory session table. Purged lazily on access — no timer
    thread, and a service restart clears every half-done enrollment
    (nothing was persisted, so nothing leaks)."""

    def __init__(self, ttl_s: float = SESSION_TTL_S) -> None:
        self._ttl_s = ttl_s
        self._sessions: dict[str, EnrollmentSession] = {}
        # FastAPI runs sync `def` endpoints in a threadpool, so two requests
        # can straddle the TTL boundary concurrently. Guard every mutation
        # (and the purge-then-read sequence) with one re-entrant lock so a
        # purge racing a get/discard can never raise KeyError on an
        # already-removed session.
        self._lock = threading.RLock()

    def _purge(self) -> None:
        with self._lock:
            deadline = time.time() - self._ttl_s
            for sid in [
                sid
                for sid, s in self._sessions.items()
                if s.created_at < deadline
            ]:
                self._sessions.pop(sid, None)

    def create(self, user_id: str) -> EnrollmentSession:
        with self._lock:
            self._purge()
            session = EnrollmentSession(user_id)
            self._sessions[session.id] = session
            return session

    def get(self, session_id: str) -> Optional[EnrollmentSession]:
        with self._lock:
            self._purge()
            return self._sessions.get(session_id)

    def discard(self, session_id: str) -> bool:
        """Drop a session (cancel path). Idempotent."""
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def discard_for_user(self, user_id: str) -> None:
        """Removing a voiceprint also kills any in-flight re-record."""
        with self._lock:
            for sid in [
                sid for sid, s in self._sessions.items() if s.user_id == user_id
            ]:
                self._sessions.pop(sid, None)
