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

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. As with services/file-indexer/Dockerfile, `OPENSSL_CONF` is
# intentionally NOT set here at image-baseline level — Python's `ssl`
# module initializes OpenSSL at import and would crash on a config
# that `.include`s a missing `/etc/ssl/fipsmodule.cnf` (the validated
# `fips.so` is layered on top by the operator separately).
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

# WARP-437: pre-download the deberta zero-shot model so first request
# doesn't pay the 110 MB cold-load latency. Soft-fail (build does not
# break on prewarm failure) but emits to stderr so build logs surface
# the issue — otherwise a silent fail makes the prewarm pointless.
RUN python -c "from query_classifier import QueryClassifierSingleton; QueryClassifierSingleton.instance()" \
    || (echo "WARP-437: query_classifier prewarm FAILED — first runtime call will pay the model-download cost" >&2; true)

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
