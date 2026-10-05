FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS native
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libc6-dev libopenblas-dev curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# MIT native CPU runtime: immutable commit + archive hash. No CUDA/HIP build.
RUN curl -fL --retry 3 https://codeload.github.com/antirez/qwen-asr/tar.gz/924694251d9e0f18e5d86bbd06aa3ab5f870002d -o source.tar.gz \
    && echo 'c197e4381a14019f254b910260fdbae08ea28fdfb7ec3003dbf22560f37f839f  source.tar.gz' | sha256sum -c - \
    && tar -xzf source.tar.gz --strip-components=1 \
    && gcc -shared -fPIC -O3 -march=x86-64-v3 -DUSE_BLAS -DUSE_OPENBLAS -I/usr/include/x86_64-linux-gnu/openblas-pthread \
       qwen_asr.c qwen_asr_kernels.c qwen_asr_kernels_generic.c qwen_asr_kernels_neon.c \
       qwen_asr_kernels_avx.c qwen_asr_audio.c qwen_asr_encoder.c qwen_asr_decoder.c \
       qwen_asr_tokenizer.c qwen_asr_safetensors.c -o libqwen_asr.so -lopenblas -lm -lpthread

FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS model
COPY services/qwen-stt/download_model.py /download_model.py
RUN python /download_model.py

FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
RUN apt-get update && apt-get install -y --no-install-recommends libopenblas0-pthread \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home speech
WORKDIR /app
COPY --from=native /src/libqwen_asr.so /app/libqwen_asr.so
COPY --from=native /src/LICENSE /app/licenses/qwen-asr-LICENSE
COPY --from=model /models /models
COPY services/qwen-stt/MODEL-LICENSE /models/qwen3-asr-1.7b/LICENSE
COPY services/qwen-stt/README.md /app/README.md
COPY services/qwen-stt/server.py services/qwen-stt/healthcheck.py /app/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=4 OMP_NUM_THREADS=4
USER 10001:10001
EXPOSE 10300
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD ["python", "/app/healthcheck.py"]
CMD ["python", "/app/server.py"]
