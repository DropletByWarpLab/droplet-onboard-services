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
# requirements.txt changes, not on every code edit.
COPY services/voice-orchestrator/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The service source.
COPY services/voice-orchestrator/ /app/

# The container joins the host's audio group at compose-time (see
# `group_add` in docker-compose.yml). We don't bake a hardcoded UID
# here — keeps the image portable across hosts whose audio GID
# differs.

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8086

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8086", "--no-server-header"]
