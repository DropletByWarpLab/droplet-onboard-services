# voice-orchestrator — Droplet's always-on voice loop (WARP-154).
#
# Multi-arch (x86 POC + Jetson production). Base is python:3.12-slim;
# the audio stack adds ALSA + PortAudio + ffmpeg (for any audio
# format conversion the TTS pipe needs later).
FROM python:3.12-slim AS base

# Audio + build deps. libasound2-dev gives ALSA headers for the
# sounddevice C extension's link step; libportaudio2 is the runtime
# library sounddevice actually loads at import time. alsa-utils gives
# `aplay`/`arecord` for in-container debug — small package, worth it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libportaudio2 \
        libasound2 \
        libasound2-plugins \
        alsa-utils \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pip layer cached separately from source — re-runs only when
# requirements*.txt changes, not on every code edit. We install BOTH
# the runtime and dev (pytest) deps so `docker compose run
# voice-orchestrator pytest tests/` works against the same image
# that's running in production. Image size impact: tiny
# (pytest + pluggy + iniconfig + packaging, ~3 MB).
COPY services/voice-orchestrator/requirements.txt \
     services/voice-orchestrator/requirements-dev.txt \
     /app/
RUN pip install --no-cache-dir -r /app/requirements-dev.txt && \
    # openWakeWord 0.6.0's setup.py pins `tflite-runtime` which has no
    # Python 3.12 wheel for x86_64. The ONNX-side deps are already pinned
    # in requirements.txt; here we install openwakeword itself with
    # --no-deps so pip doesn't try to resolve tflite-runtime.
    pip install --no-cache-dir --no-deps openwakeword==0.6.0

# Pre-warm the bundled model cache so the first /voice/status hit
# doesn't pay the model-download tax. openWakeWord stashes models in
# ~/.local/share/openwakeword/resources/models — bake them in. If the
# download fails (no network at build time) we don't fail the build;
# the runtime lazy-load will retry on first predict().
RUN python -c "from openwakeword.utils import download_models; download_models(['hey_jarvis_v0.1', 'alexa_v0.1', 'hey_mycroft_v0.1'])" || \
    echo "openwakeword model pre-fetch skipped (offline build OK; runtime will fetch)"

# The service source.
COPY services/voice-orchestrator/ /app/

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
