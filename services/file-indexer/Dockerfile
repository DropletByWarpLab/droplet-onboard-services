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
#  - openssl + ca-certificates: WARP-229 FIPS provider activation
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libpq-dev gcc \
      tesseract-ocr tesseract-ocr-eng \
      ffmpeg \
      libmagic1 \
      openssl ca-certificates && \
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

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. The config file is in place at /etc/ssl/openssl-fips.cnf BUT
# `OPENSSL_CONF` is intentionally NOT set here. Reasons:
#   1. The config `.include`s `/etc/ssl/fipsmodule.cnf`, which only
#      exists once the operator layers the validated FIPS provider on
#      top of this image. Setting `OPENSSL_CONF` baseline-on would
#      break Python's `ssl` initialization (and pip-install at build
#      time) on every image that doesn't have the module yet.
#   2. The orchestrator's docker-compose service definition (or the
#      operator's runtime env) is the right place to flip
#      `OPENSSL_CONF=/etc/ssl/openssl-fips.cnf` AND `DROPLET_FIPS_REQUIRED=true`
#      together once the FIPS module is in place.
#
# To activate FIPS at runtime, set both env vars in the container env:
#   OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
#   DROPLET_FIPS_REQUIRED=true
# Then the boot self-test in main.py will negative-probe MD5 and exit
# non-zero if the provider isn't actually enforcing.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py

CMD ["python", "main.py"]
