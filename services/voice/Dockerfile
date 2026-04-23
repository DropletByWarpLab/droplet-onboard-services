# Voice service for the Droplet edge appliance.
#
# Runs FastAPI under uvicorn. Heavy ML libs (faster-whisper, piper-tts,
# openWakeWord) are installed but the corresponding *models* are NOT baked
# in — they're downloaded on first run into a mounted volume at /data so
# image rebuilds don't have to ship hundreds of MB.
#
# Audio + GPIO require host-level access; see docker/docker-compose.yml
# for the device mounts (/dev/snd and /dev/gpiochip*) which are added on
# the Jetson under `profile: voice`.

FROM python:3.12-slim AS base

# libportaudio2 = sounddevice's Python ↔ ALSA bridge.
# libsndfile1 = WAV codec used by piper internally.
# ffmpeg = format conversion fallback (some uploads aren't strict WAV).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libportaudio2 \
      libsndfile1 \
      ffmpeg \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
# --no-cache-dir keeps the image lean. Install before copying source so
# layer cache survives source-only edits.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# /data is the mount point for downloaded model files (whisper, piper voice).
RUN mkdir -p /data/voices /data/wakeword

ENV PYTHONUNBUFFERED=1 \
    VOICE_LISTEN_HOST=0.0.0.0 \
    VOICE_LISTEN_PORT=8090 \
    VOICE_AUDIO_BACKEND=mock \
    VOICE_STT_BACKEND=mock \
    VOICE_TTS_BACKEND=mock \
    VOICE_GPIO_BACKEND=noop

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8090/health >/dev/null 2>&1 || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
