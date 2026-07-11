# voice-io — Droplet's always-on voice loop (WARP-154).
#
# Multi-arch (single-box x86 + multi-box/v2.6 inference-host deployment shapes).
# Base is python:3.12-slim; the audio stack adds ALSA + PortAudio +
# ffmpeg (for any audio format conversion the TTS pipe needs later).
FROM python:3.12-slim AS base

# Audio + build deps. libasound2-dev gives ALSA headers for the
# sounddevice C extension's link step; libportaudio2 is the runtime
# library sounddevice actually loads at import time. alsa-utils gives
# `aplay`/`arecord` for in-container debug — small package, worth it.
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends \
        libportaudio2 \
        libasound2 \
        libasound2-plugins \
        alsa-utils \
        ffmpeg \
        curl \
        ca-certificates

WORKDIR /app

# Pip layer cached separately from source — re-runs only when
# requirements*.txt changes, not on every code edit. We install BOTH
# the runtime and dev (pytest) deps so `docker compose run
# voice-io pytest tests/` works against the same image
# that's running in production. Image size impact: tiny
# (pytest + pluggy + iniconfig + packaging, ~3 MB).
COPY services/voice-io/requirements.txt \
     services/voice-io/requirements-dev.txt \
     /app/
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /app/requirements-dev.txt && \
    # openWakeWord 0.6.0's setup.py pins `tflite-runtime` which has no
    # Python 3.12 wheel for x86_64. The ONNX-side deps are already pinned
    # in requirements.txt; here we install openwakeword itself with
    # --no-deps so pip doesn't try to resolve tflite-runtime.
    pip install --no-deps openwakeword==0.6.0

# Pre-warm the bundled model cache so the first /voice/status hit
# doesn't pay the model-download tax. openWakeWord stashes models in
# ~/.local/share/openwakeword/resources/models — bake them in. If the
# download fails (no network at build time) we don't fail the build;
# the runtime lazy-load will retry on first predict().
RUN python -c "from openwakeword.utils import download_models; download_models(['hey_jarvis_v0.1', 'alexa_v0.1', 'hey_mycroft_v0.1'])" || \
    echo "openwakeword model pre-fetch skipped (offline build OK; runtime will fetch)"

# Bundle the Vosk small English model (Apache-2.0, ~40 MB) so the
# default wake engine recognizes "hey droplet" — and any in-vocabulary
# phrase — out of the box for every customer, with no per-box training
# and no licensing fee. Extracted to the stable path the detector
# resolves by default (see VOSK_DEFAULT_MODEL_DIRNAME in voice/wake.py;
# override with VOSK_MODEL_PATH).
#
# Supply-chain hardening (WARP-154 review item 5): the archive is a
# third-party artifact that becomes acoustic-model bytes Kaldi loads, so
# we don't trust it blindly.
#   1. PIN the SHA-256 of the exact release and verify the download
#      before touching it. A swapped/compromised artifact fails the
#      build instead of silently shipping. Recompute on a model bump:
#        curl -fsSL .../${VOSK_MODEL}.zip | sha256sum
#   2. Validate every zip member before extracting — reject absolute
#      paths and `..` traversal so a malicious archive can't write
#      outside /app/models (zip-slip). We do NOT use the stdlib's bare
#      extractall(), which has no such guard.
#
# Offline-build tolerant ONLY for a genuine fetch failure (no network at
# build time): if curl can't retrieve the archive we skip bundling and
# the factory falls back to openWakeWord until the model is present at
# runtime. A present-but-tampered artifact (checksum mismatch or
# zip-slip) is a HARD failure — never swallowed by the fallback.
ARG VOSK_MODEL=vosk-model-small-en-us-0.15
ARG VOSK_MODEL_SHA256=30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498
COPY services/voice-io/scripts/fetch_vosk_model.py /tmp/fetch_vosk_model.py
RUN ( curl -fsSL "https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip" -o /tmp/vosk.zip \
        || { echo "vosk model fetch skipped (offline build OK; runtime falls back to openWakeWord until the model is present)"; exit 0; } ) && \
    python /tmp/fetch_vosk_model.py \
        --zip /tmp/vosk.zip \
        --sha256 "${VOSK_MODEL_SHA256}" \
        --dest /app/models \
        --expected-root "${VOSK_MODEL}" \
        --rename-to vosk-model-small-en-us && \
    rm -f /tmp/vosk.zip /tmp/fetch_vosk_model.py

# WARP-236 — shared internal-mTLS helper (same COPY pattern as other services).
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py

# The service source.
COPY services/voice-io/ /app/

# The container joins the host's audio group at compose-time (see
# `group_add` in docker-compose.yml). We don't bake a hardcoded UID
# here — keeps the image portable across hosts whose audio GID
# differs.

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8086

# Container-level healthcheck. `docker ps` reports healthy / unhealthy
# from this; scripts/verify.sh and the dashboard's roll-up rely on
# the same signal. Interval kept conservative (15 s) — checking the
# in-process FastAPI is cheap, no need to hammer it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8086/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8086", "--no-server-header"]
