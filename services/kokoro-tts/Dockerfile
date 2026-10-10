FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016 AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
COPY services/kokoro-tts/requirements.txt /build/requirements.txt
RUN /opt/venv/bin/pip install -r /build/requirements.txt
COPY services/kokoro-tts/download_assets.py services/kokoro-tts/assets.json services/kokoro-tts/voices.json /build/
# These are immutable HF revisions with SHA-256 checks. Failure aborts the build.
RUN /opt/venv/bin/python /build/download_assets.py /models

FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kokoro \
    && useradd --uid 10001 --gid kokoro --no-create-home --shell /usr/sbin/nologin kokoro
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /models /app/models
COPY services/kokoro-tts/MODEL-LICENSE /app/models/LICENSE
COPY services/kokoro-tts/server.py services/kokoro-tts/runtime.py services/kokoro-tts/voices.json \
    services/kokoro-tts/healthcheck.py services/kokoro-tts/smoke_test.py \
    services/kokoro-tts/requirements.txt services/kokoro-tts/README.md \
    services/kokoro-tts/THIRD_PARTY_NOTICES.md /app/
WORKDIR /app
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    ONNX_PROVIDER=CPUExecutionProvider CUDA_VISIBLE_DEVICES=-1 \
    OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 KOKORO_CPU_THREADS=4 TTS_VOICE=af_heart
USER 10001:10001
EXPOSE 10200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "healthcheck.py"]
CMD ["python", "server.py"]
