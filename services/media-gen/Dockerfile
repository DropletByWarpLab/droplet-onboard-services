FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d

# FFmpeg is already a fleet dependency in file-indexer. Fixed H.264 MP4 encoder
# for browser playback; no remote media or codec download. See LICENSES.md.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 media && useradd --uid 1000 --gid media --shell /usr/sbin/nologin --create-home media
WORKDIR /app
COPY services/media-gen/requirements.lock .
RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements.lock
COPY services/media-gen/ .
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py
COPY services/_shared/serve.py /app/_shared/serve.py
COPY services/_shared/healthcheck.py /app/_shared/healthcheck.py
COPY services/_shared/privilege_drop.sh /app/_shared/privilege_drop.sh
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WEB_CONCURRENCY=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HOME=/tmp/huggingface MEDIA_GEN_MODEL_ROOT=/models MEDIA_GEN_DEVICE=cuda MEDIA_GEN_VIDEO_ENGINE=wan
# Compose bootstraps as root to stage TLS, then immediately drops to this uid.
USER 1000
ENTRYPOINT ["sh", "/app/_shared/privilege_drop.sh"]
EXPOSE 8040
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "8040"]
