# --- FIPS provider build stage (WARP-967) ---
# Source-builds the NIST-validated OpenSSL FIPS module (fips.so) —
# OpenSSL 3.0.9, CMVP certificate #4282. The version pin, sha256 pin,
# and full rationale live in docker/fips/build-openssl-fips.sh. This
# stage is byte-identical across every shipped service image
# (orchestrator, mcp-server, web-dashboard, file-indexer, ai-gateway)
# so BuildKit resolves it to ONE compile per builder/arch instead of
# five. Keep it in lockstep across those five Dockerfiles.
FROM debian:bookworm-slim AS fips-builder
COPY docker/fips/build-openssl-fips.sh /tmp/build-openssl-fips.sh
RUN sh /tmp/build-openssl-fips.sh /out

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
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      libpq-dev gcc \
      tesseract-ocr tesseract-ocr-eng \
      ffmpeg \
      libmagic1 \
      openssl ca-certificates

COPY services/file-indexer/requirements.txt .
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

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

# WARP-229/WARP-967: ship the FIPS-provider OpenSSL config + shared
# self-test helper. The config is in place at /etc/ssl/openssl-fips.cnf
# BUT `OPENSSL_CONF` is intentionally NOT set here: FIPS is a
# per-customer option, default OFF (Romain, 2026-07-02). The validated
# fips.so + fipsmodule.cnf ship in this image (WARP-967), so setting
# `OPENSSL_CONF` baseline-on would activate FIPS for every customer —
# the activation flip belongs exclusively to WARP-318's
# `DROPLET_FIPS_MODE` option.
#
# To activate FIPS at runtime, set both env vars in the container env:
#   OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
#   DROPLET_FIPS_REQUIRED=true
# Then the boot self-test in main.py will negative-probe MD5 and exit
# non-zero if the provider isn't actually enforcing.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py

# WARP-967: install the NIST-validated FIPS provider (fips.so — OpenSSL
# 3.0.9, CMVP cert #4282, source-built in the fips-builder stage above)
# and run the build-time FIPS self-test (fipsinstall KATs +
# provider-active assert + MD5 negative-probe). Any failure fails the
# image build. `OPENSSL_CONF` stays intentionally NOT set (see above) —
# shipping the module changes nothing at runtime until the operator
# opts in (WARP-318).
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN sh /tmp/install-fips-provider.sh /tmp/fips.so && \
    rm -f /tmp/fips.so /tmp/install-fips-provider.sh

# WARP-967: probe the runtime combination for Python — CPython links the
# system (Debian) libcrypto, so OPENSSL_CONF alone activates the
# provider. `_hashlib` is probed directly because `hashlib.new()` can
# silently fall back to CPython's built-in non-OpenSSL `_md5` module and
# mask enforcement. OPENSSL_CONF is scoped to this RUN only; runtime
# posture is unchanged.
RUN OPENSSL_CONF=/etc/ssl/openssl-fips.cnf python - <<'PY'
import ssl  # OpenSSL init under the FIPS config must not crash
import _hashlib
_hashlib.new("sha256", b"probe")  # FIPS-approved digest still works
try:
    _hashlib.new("md5", b"probe", usedforsecurity=True)
except ValueError as exc:
    print(f"FIPS build-time self-test OK (python/_hashlib): MD5 rejected ({exc})")
else:
    raise SystemExit("FIPS python self-test FAILED: MD5 succeeded under the FIPS config")
PY

CMD ["python", "main.py"]
