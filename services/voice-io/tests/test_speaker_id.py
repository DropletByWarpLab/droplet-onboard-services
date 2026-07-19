"""WARP-1056 — per-person voiceprints: engine + endpoint contract.

Covers voice/speaker_id.py (store round-trip, capture quality guard,
matching words, §7.6 confusability, sessions) and the /speaker/*
endpoints via TestClient with the audio + embedder layers stubbed —
no hardware, no ONNX weights, no network.

Wire-contract pins worth calling out:

  * Confidence is a plain WORD ("high"/"good") or null — the §5 rule
    "never a percentage" is asserted structurally: no numeric
    similarity/score field ever appears in a match/verify response.
  * Delete is immediate: the voiceprint FILE is gone the moment the
    DELETE returns, and repeat deletes are an idempotent no-op.
  * Profile listings never include the embedding vector.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from voice.speaker_id import (
    CAPTURE_MIN_PEAK_DBFS,
    CONFUSABLE_SIM,
    EnrollmentSessions,
    MATCH_GOOD_SIM,
    MATCH_HIGH_SIM,
    REQUIRED_LINES,
    VoiceprintStore,
    annotate_confusable,
    assess_capture,
    confidence_word,
    cosine,
    match_against,
    peak_dbfs,
)


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def profiles_dir(tmp_path, monkeypatch):
    """Point the voiceprint store at a per-test dir via the env override."""
    d = tmp_path / "voiceprints"
    monkeypatch.setenv("VOICE_PROFILES_DIR", str(d))
    return d


@dataclass
class _FakeDevice:
    name: str = "fake"
    index: int = 0


@dataclass
class _FakeResolution:
    input_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)
    output_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)


def _unit(dim: int, axis: int) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float32)
    v[axis] = 1.0
    return v


def _mix(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    v = (1.0 - t) * a + t * b
    return v / np.linalg.norm(v)


class _FakeEmbedder:
    """Maps a tiny marker value baked into the PCM to a fixed embedding.

    The capture stub below tags sample 0 of BOTH halves with a voice
    marker (10·n — far below any level gate); the embedder returns a
    per-marker unit vector, so means/similarities behave like the real
    thing without any DSP and the §7.5 half-vs-half check sees one
    consistent voice per capture.
    """

    def embed(self, pcm: np.ndarray, samplerate: int) -> np.ndarray:
        marker = int(np.asarray(pcm).reshape(-1)[0]) // 10
        return _unit(8, marker % 8)


def _install_capture(monkeypatch, voices: list[int], level: int = 8000):
    """Stub main's capture: each call emits a buffer 'spoken by' the next
    voice in `voices` (marker at the start of each half, `level` fill)."""
    calls = {"n": 0}

    def fake_capture(seconds: float) -> np.ndarray:
        marker = voices[min(calls["n"], len(voices) - 1)]
        calls["n"] += 1
        pcm = np.full(16000, level, dtype=np.int16)
        pcm[0] = marker * 10
        pcm[8000] = marker * 10  # first sample of the second half
        return pcm

    monkeypatch.setattr(main, "_capture_speaker_pcm", fake_capture)
    return calls


@pytest.fixture
def speaker_env(profiles_dir, monkeypatch):
    """Endpoint fixture: fake embedder + device + a fresh session table."""
    embedder = _FakeEmbedder()
    monkeypatch.setattr(main, "_speaker_embedder", embedder)
    monkeypatch.setattr(main, "_speaker_embedder_built", True)
    monkeypatch.setattr(main, "_enroll_sessions", EnrollmentSessions())
    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    return embedder


# ── engine: levels + quality guard ─────────────────────────────────

def test_peak_dbfs_silence_and_fullscale():
    assert peak_dbfs(np.zeros(1600, dtype=np.int16)) == -120.0
    loud = np.full(1600, 32767, dtype=np.int16)
    assert peak_dbfs(loud) == pytest.approx(0.0, abs=0.1)


def test_assess_capture_too_quiet():
    quiet = np.full(16000, 100, dtype=np.int16)  # ≈ -50 dBFS
    emb, quality = assess_capture(quiet, lambda p: _unit(8, 0))
    assert quality == "too_quiet"
    assert emb is None


def test_assess_capture_crosstalk_two_voices():
    # §7.5 — both halves loud, but they embed as DIFFERENT voices.
    pcm = np.full(16000, 8000, dtype=np.int16)
    pcm[8000] = 7999  # marks the second half for the stub embedder
    emb, quality = assess_capture(
        pcm,
        lambda p: _unit(8, 0) if int(p[0]) == 8000 else _unit(8, 1),
    )
    assert quality == "crosstalk"
    assert emb is None


def test_assess_capture_good_single_voice():
    pcm = np.full(16000, 8000, dtype=np.int16)
    emb, quality = assess_capture(pcm, lambda p: _unit(8, 3))
    assert quality == "good"
    assert emb is not None and float(emb[3]) == 1.0


def test_capture_min_peak_matches_wizard_pass_bar():
    # The guard reuses the dashboard's speech-peak pass bar — a capture
    # the wizard would call "good" is never rejected as too quiet.
    assert CAPTURE_MIN_PEAK_DBFS == -35.0


# ── engine: matching words ──────────────────────────────────────────

def test_confidence_word_bands():
    assert confidence_word(MATCH_HIGH_SIM + 0.01) == "high"
    assert confidence_word((MATCH_HIGH_SIM + MATCH_GOOD_SIM) / 2) == "good"
    assert confidence_word(MATCH_GOOD_SIM - 0.01) is None


def test_match_against_picks_best_or_none():
    a, b = _unit(8, 0), _unit(8, 1)
    records = [
        {"user_id": "alice", "embedding": a.tolist()},
        {"user_id": "bob", "embedding": b.tolist()},
    ]
    user, _sim = match_against(_mix(a, b, 0.1), records)
    assert user == "alice"
    # Orthogonal to everyone → below the floor → no match.
    user, _sim = match_against(_unit(8, 7), records)
    assert user is None


# ── engine: §7.6 confusability ──────────────────────────────────────

def test_annotate_confusable_marks_both_rows():
    a = _unit(8, 0)
    close = _mix(a, _unit(8, 1), 0.1)  # ≈0.99 cosine to a
    far = _unit(8, 2)
    records = [
        {"user_id": "alice", "embedding": a.tolist()},
        {"user_id": "sibling", "embedding": close.tolist()},
        {"user_id": "carol", "embedding": far.tolist()},
    ]
    assert cosine(a, close) >= CONFUSABLE_SIM
    annotate_confusable(records)
    assert records[0]["confused_with"] == "sibling"
    assert records[1]["confused_with"] == "alice"
    assert records[2]["confused_with"] is None
    assert all("_confusable_sim" not in r for r in records)


# ── engine: store ───────────────────────────────────────────────────

def test_store_round_trip_and_immediate_delete(profiles_dir):
    store = VoiceprintStore()
    store.save({"user_id": "u1", "embedding": [1.0, 0.0], "enrolled_at": 1.0})
    path = profiles_dir / "u1.json"
    assert path.exists()
    assert VoiceprintStore().load("u1")["embedding"] == [1.0, 0.0]
    assert store.delete("u1") is True
    assert not path.exists()          # gone the moment delete() returns
    assert store.delete("u1") is False  # idempotent repeat


def test_store_rejects_path_traversal_ids(profiles_dir):
    store = VoiceprintStore()
    for bad in ("../evil", "a/b", "", "x" * 65, "hey droplet"):
        with pytest.raises(ValueError):
            store.load(bad)


def test_store_corrupt_file_reads_absent(profiles_dir):
    profiles_dir.mkdir(parents=True)
    (profiles_dir / "u1.json").write_text("{not json", encoding="utf-8")
    assert VoiceprintStore().load("u1") is None
    assert VoiceprintStore().load_all() == []


# ── endpoints: availability gates ───────────────────────────────────

def test_enroll_start_503_without_model(client, profiles_dir, monkeypatch):
    monkeypatch.setattr(main, "_speaker_embedder", None)
    monkeypatch.setattr(main, "_speaker_embedder_built", True)
    res = client.post("/speaker/enroll/start", json={"user_id": "u1"})
    assert res.status_code == 503
    assert "voice model" in res.json()["detail"]


def test_profiles_reports_model_availability(client, profiles_dir, monkeypatch):
    monkeypatch.setattr(main, "_speaker_embedder", None)
    monkeypatch.setattr(main, "_speaker_embedder_built", True)
    res = client.get("/speaker/profiles")
    assert res.status_code == 200
    assert res.json() == {"speaker_model_available": False, "profiles": []}


def test_enroll_start_503_without_mic(client, speaker_env, monkeypatch):
    monkeypatch.setattr(
        main, "_resolve", lambda: _FakeResolution(input_device=None),
    )
    res = client.post("/speaker/enroll/start", json={"user_id": "u1"})
    assert res.status_code == 503


def test_enroll_start_rejects_bad_user_id(client, speaker_env):
    res = client.post("/speaker/enroll/start", json={"user_id": "../evil"})
    assert res.status_code == 400


# ── endpoints: the full Flow B happy path ───────────────────────────

def _start(client, user_id="alice"):
    res = client.post("/speaker/enroll/start", json={"user_id": user_id})
    assert res.status_code == 200
    assert res.json()["lines_required"] == REQUIRED_LINES
    return res.json()["session_id"]


def test_full_enrollment_flow(client, speaker_env, profiles_dir, monkeypatch):
    _install_capture(monkeypatch, voices=[1])  # every capture = voice 1
    sid = _start(client)

    for n in range(1, REQUIRED_LINES + 1):
        res = client.post("/speaker/enroll/capture", json={"session_id": sid})
        assert res.status_code == 200
        assert res.json() == {
            "quality": "good", "captured": n, "required": REQUIRED_LINES,
        }

    res = client.post("/speaker/enroll/verify", json={"session_id": sid})
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is True
    assert body["confidence"] == "high"
    # §5 wire rule: words only — no numeric similarity ever crosses
    # (bools are ints in Python; only real numbers are the violation).
    assert not any(
        isinstance(v, float) or (isinstance(v, int) and not isinstance(v, bool))
        for v in body.values()
    )

    res = client.post("/speaker/enroll/commit", json={"session_id": sid})
    assert res.status_code == 200
    profile = res.json()["profile"]
    assert profile["user_id"] == "alice"
    assert profile["learning"] is False
    assert profile["last_recognized_at"] is not None
    assert "embedding" not in profile  # the vector never leaves the box
    assert (profiles_dir / "alice.json").exists()

    # Committed session is gone — a second commit can't double-write.
    res = client.post("/speaker/enroll/commit", json={"session_id": sid})
    assert res.status_code == 404

    # The profile shows up in the listing, embedding-free.
    res = client.get("/speaker/profiles")
    assert res.json()["speaker_model_available"] is True
    (row,) = res.json()["profiles"]
    assert row["user_id"] == "alice"
    assert "embedding" not in row


def test_capture_quality_guard_rides_back(client, speaker_env, monkeypatch):
    calls = _install_capture(monkeypatch, voices=[1], level=100)  # too quiet
    sid = _start(client)
    res = client.post("/speaker/enroll/capture", json={"session_id": sid})
    assert res.status_code == 200
    assert res.json()["quality"] == "too_quiet"
    assert res.json()["captured"] == 0  # nothing stored
    assert calls["n"] == 1


def test_capture_redo_replaces_line(client, speaker_env, monkeypatch):
    _install_capture(monkeypatch, voices=[1])
    sid = _start(client)
    for _ in range(2):
        client.post("/speaker/enroll/capture", json={"session_id": sid})
    res = client.post(
        "/speaker/enroll/capture",
        json={"session_id": sid, "replace_index": 0},
    )
    assert res.status_code == 200
    assert res.json()["captured"] == 2  # replaced, not appended
    res = client.post(
        "/speaker/enroll/capture",
        json={"session_id": sid, "replace_index": 5},
    )
    assert res.status_code == 400


def test_verify_requires_four_lines(client, speaker_env, monkeypatch):
    _install_capture(monkeypatch, voices=[1])
    sid = _start(client)
    res = client.post("/speaker/enroll/verify", json={"session_id": sid})
    assert res.status_code == 400
    res = client.post("/speaker/enroll/commit", json={"session_id": sid})
    assert res.status_code == 400


# ── endpoints: §5 step-3 mismatch → sharpen → honest fallback ──────

def test_mismatch_then_learning_commit(client, speaker_env, profiles_dir, monkeypatch):
    # 4 lines by voice 1, then verify captures voice 2 (someone else /
    # unrecognizable room): matched=False. Two sharpen lines land, the
    # re-verify still mismatches → commit saves with learning=True.
    _install_capture(monkeypatch, voices=[1, 1, 1, 1, 2, 1, 1, 2])
    sid = _start(client)
    for _ in range(REQUIRED_LINES):
        client.post("/speaker/enroll/capture", json={"session_id": sid})

    res = client.post("/speaker/enroll/verify", json={"session_id": sid})
    assert res.json() == {"quality": "good", "matched": False, "confidence": None}

    for n in (5, 6):
        res = client.post("/speaker/enroll/capture", json={"session_id": sid})
        assert res.json()["captured"] == n
    # Session is full — a 7th line is rejected.
    res = client.post("/speaker/enroll/capture", json={"session_id": sid})
    assert res.status_code == 400

    res = client.post("/speaker/enroll/verify", json={"session_id": sid})
    assert res.json()["matched"] is False

    res = client.post("/speaker/enroll/commit", json={"session_id": sid})
    assert res.status_code == 200
    assert res.json()["profile"]["learning"] is True
    assert res.json()["profile"]["last_recognized_at"] is None


def test_verify_mismatches_when_a_sibling_matches_better(
    client, speaker_env, profiles_dir, monkeypatch,
):
    # An enrolled sibling (voice 1) already exists; the new enrollment's
    # lines are ALSO voice 1 (bad captures), and the verify utterance is
    # voice 1 — recognizing the sibling better than (not worse than) the
    # new mean must NOT pass. Equal similarity fails the strictly-greater
    # gate: never silently attribute the new voice over an existing one.
    store = VoiceprintStore()
    store.save({
        "user_id": "sibling",
        "embedding": _unit(8, 1).tolist(),
        "enrolled_at": 1.0, "updated_at": 1.0,
    })
    _install_capture(monkeypatch, voices=[1])
    sid = _start(client, user_id="newkid")
    for _ in range(REQUIRED_LINES):
        client.post("/speaker/enroll/capture", json={"session_id": sid})
    res = client.post("/speaker/enroll/verify", json={"session_id": sid})
    assert res.json()["matched"] is False


# ── endpoints: cancel discards immediately ──────────────────────────

def test_enroll_cancel_discards_session(client, speaker_env, monkeypatch):
    _install_capture(monkeypatch, voices=[1])
    sid = _start(client)
    client.post("/speaker/enroll/capture", json={"session_id": sid})
    res = client.delete(f"/speaker/enroll/{sid}")
    assert res.json() == {"discarded": True}
    # The session (and its embeddings) are gone NOW.
    res = client.post("/speaker/enroll/capture", json={"session_id": sid})
    assert res.status_code == 404
    # Idempotent repeat.
    assert client.delete(f"/speaker/enroll/{sid}").json() == {"discarded": False}


# ── endpoints: match + delete ───────────────────────────────────────

def _enroll(client, monkeypatch, user_id: str, voice: int):
    _install_capture(monkeypatch, voices=[voice])
    sid = _start(client, user_id=user_id)
    for _ in range(REQUIRED_LINES):
        client.post("/speaker/enroll/capture", json={"session_id": sid})
    client.post("/speaker/enroll/verify", json={"session_id": sid})
    res = client.post("/speaker/enroll/commit", json={"session_id": sid})
    assert res.status_code == 200


def test_match_words_only_and_touches_last_recognized(
    client, speaker_env, profiles_dir, monkeypatch,
):
    _enroll(client, monkeypatch, "alice", voice=1)
    before = VoiceprintStore().load("alice")["last_recognized_at"]

    _install_capture(monkeypatch, voices=[1])
    res = client.post("/speaker/match")
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is True
    assert body["user_id"] == "alice"
    assert body["confidence"] in ("high", "good")
    # HARD wire rule: no numeric similarity/score field, ever.
    assert set(body) == {"matched", "user_id", "confidence"}
    assert VoiceprintStore().load("alice")["last_recognized_at"] >= before

    # An unknown voice is a guest — matched False, no best-guess id.
    _install_capture(monkeypatch, voices=[5])
    res = client.post("/speaker/match")
    assert res.json() == {"matched": False, "user_id": None, "confidence": None}


def test_match_without_profiles_never_captures(client, speaker_env, monkeypatch):
    calls = _install_capture(monkeypatch, voices=[1])
    res = client.post("/speaker/match")
    assert res.json()["matched"] is False
    assert calls["n"] == 0  # no profiles → no reason to record anyone


def test_profile_delete_is_immediate_and_idempotent(
    client, speaker_env, profiles_dir, monkeypatch,
):
    _enroll(client, monkeypatch, "alice", voice=1)
    path = profiles_dir / "alice.json"
    assert path.exists()
    res = client.delete("/speaker/profiles/alice")
    assert res.json() == {"deleted": True}
    assert not path.exists()  # gone before the response, not "soon"
    assert client.delete("/speaker/profiles/alice").json() == {"deleted": False}
    assert client.get("/speaker/profiles").json()["profiles"] == []


def test_profile_delete_kills_inflight_reenroll(
    client, speaker_env, profiles_dir, monkeypatch,
):
    _enroll(client, monkeypatch, "alice", voice=1)
    _install_capture(monkeypatch, voices=[1])
    sid = _start(client, user_id="alice")  # re-record in flight
    client.delete("/speaker/profiles/alice")
    res = client.post("/speaker/enroll/capture", json={"session_id": sid})
    assert res.status_code == 404  # session discarded with the voiceprint


def test_profile_delete_rejects_bad_ids(client, speaker_env):
    res = client.delete("/speaker/profiles/..%2Fevil")
    assert res.status_code in (400, 404)


# ── endpoints: §7.6 in the listing ──────────────────────────────────

def test_profiles_listing_flags_confusable_pair(
    client, speaker_env, profiles_dir, monkeypatch,
):
    _enroll(client, monkeypatch, "alice", voice=1)
    _enroll(client, monkeypatch, "twin", voice=1)  # same voice → confusable
    rows = client.get("/speaker/profiles").json()["profiles"]
    by_id = {r["user_id"]: r for r in rows}
    assert by_id["alice"]["confused_with"] == "twin"
    assert by_id["twin"]["confused_with"] == "alice"
