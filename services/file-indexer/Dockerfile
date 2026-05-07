FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml) so that
# `proto/` is visible alongside `services/file-indexer/`. All COPY paths
# here are therefore relative to the repo root.

WORKDIR /app

# System deps:
#  - libpq-dev + gcc: psycopg2 build deps
#  - tesseract-ocr + tesseract-ocr-eng: WARP-201 image OCR extractor
#  - ffmpeg: WARP-197 audio extractor (faster-whisper decodes via ffmpeg)
#  - libmagic1: WARP-199 email + WARP-200 archive (python-magic content-sniff)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libpq-dev gcc \
      tesseract-ocr tesseract-ocr-eng \
      ffmpeg \
      libmagic1 && \
    rm -rf /var/lib/apt/lists/*

COPY services/file-indexer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy proto from the monorepo root and generate gRPC stubs at build time.
COPY proto/ /app/proto/
RUN mkdir -p /app/grpc_generated && \
    touch /app/grpc_generated/__init__.py && \
    python -m grpc_tools.protoc \
      -I/app/proto \
      --python_out=/app/grpc_generated \
      --grpc_python_out=/app/grpc_generated \
      /app/proto/inference.proto

COPY services/file-indexer/ .

CMD ["python", "main.py"]
