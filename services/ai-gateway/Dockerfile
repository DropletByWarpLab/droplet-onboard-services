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

# Build context is the monorepo root (see docker-compose.yml ai-gateway
# `context: ..`). All COPY paths are relative to the repo root. WARP-229.

# WARP-229 — System deps (openssl + ca-certificates) for the FIPS provider.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/ai-gateway/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/ai-gateway/ .

# WARP-229/WARP-967: ship the FIPS-provider OpenSSL config + shared
# self-test helper. As with services/file-indexer/Dockerfile,
# `OPENSSL_CONF` is intentionally NOT set at image-baseline level:
# FIPS is a per-customer option, default OFF (Romain, 2026-07-02).
# The validated fips.so + fipsmodule.cnf ship in this image
# (WARP-967), so setting `OPENSSL_CONF` baseline-on would activate
# FIPS for every customer — the activation flip belongs exclusively
# to WARP-318's `DROPLET_FIPS_MODE` option.
#
# To activate FIPS at runtime, the operator sets both env vars in the
# container env:
#   OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
#   DROPLET_FIPS_REQUIRED=true
# The boot self-test at the top of `main.py` then negative-probes MD5
# and exits non-zero if the provider isn't enforcing.
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

# WARP-437: pre-download the deberta zero-shot model so first request
# doesn't pay the 110 MB cold-load latency. Soft-fail (build does not
# break on prewarm failure) but emits to stderr so build logs surface
# the issue — otherwise a silent fail makes the prewarm pointless.
RUN python -c "from query_classifier import QueryClassifierSingleton; QueryClassifierSingleton.instance()" \
    || (echo "WARP-437: query_classifier prewarm FAILED — first runtime call will pay the model-download cost" >&2; true)

# WARP-644: pre-warm + availability self-check for BGE-reranker-base. Uses
# RerankerSingleton.available(), which fails closed (logs once at WARNING and
# returns False) if the optimum/onnxruntime import or model load is broken,
# so a regression surfaces in the build log instead of as silent empty-score
# Rerank responses at runtime. Soft-fail like the classifier prewarm above —
# the runtime handler already degrades gracefully.
RUN python -c "from reranker import RerankerSingleton; raise SystemExit(0 if RerankerSingleton.available() else 1)" \
    || (echo "WARP-644: reranker prewarm/self-check FAILED — Rerank will return empty scores until the optimum/onnxruntime import is repaired" >&2; true)

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
