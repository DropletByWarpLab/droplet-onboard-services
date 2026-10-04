# --- FIPS provider build stage (WARP-967) ---
# Source-builds the NIST-validated OpenSSL FIPS module (fips.so) —
# OpenSSL 3.0.9, CMVP certificate #4282. The version pin, sha256 pin,
# and full rationale live in docker/fips/build-openssl-fips.sh. This
# stage is byte-identical across every shipped service image
# (orchestrator, mcp-server, web-dashboard, file-indexer, ai-gateway)
# so BuildKit resolves it to ONE compile per builder/arch instead of
# five. Keep it in lockstep across those five Dockerfiles.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fips-builder
COPY docker/fips/build-openssl-fips.sh /tmp/build-openssl-fips.sh
RUN sh /tmp/build-openssl-fips.sh /out

FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d

# Build context is the monorepo root (see docker-compose.yml ai-gateway
# `context: ..`). All COPY paths are relative to the repo root. WARP-229.

# WARP-229 — System deps (openssl + ca-certificates) for the FIPS provider.
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates

WORKDIR /app
# WARP-3670: hash-locked. requirements.lock pins what `pip install -r requirements.txt`
# resolves to today: pip ignores the per-line `--index-url` on the torch line, so torch
# comes from PyPI, and the lock keeps exactly that. Compile recipe: docs/SECURITY.md.
COPY services/ai-gateway/requirements.lock .
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --require-hashes --no-deps -r requirements.lock
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
# WARP-1061: shared uvicorn launcher — serves the bundle + requires client
# certs when DROPLET_INTERNAL_TLS=1, byte-identical plaintext when 0.
COPY services/_shared/serve.py /app/_shared/serve.py

# WARP-967: install the NIST-validated FIPS provider (fips.so — OpenSSL
# 3.0.9, CMVP cert #4282, source-built in the fips-builder stage above)
# and run the build-time FIPS self-test (fipsinstall KATs +
# provider-active assert + MD5 negative-probe). Any failure fails the
# image build. `OPENSSL_CONF` stays intentionally NOT set (see above) —
# shipping the module changes nothing at runtime until the operator
# opts in (WARP-318).
# WARP-1063: this process hosts TWO libcrypto instances — CPython's
# system (Debian) libcrypto AND pyca `cryptography`'s statically linked
# OpenSSL (the boot self-test initializes the latter FIRST). The FIPS
# module cannot be initialized by two libcryptos resolving the SAME
# fips.so file (upstream limitation, openssl#25553: the second
# activation fails with `common libcrypto routines::init fail`, leaving
# that instance with ZERO fetchable algorithms under the fips=yes pin —
# httpx then dies constructing its TLS client with
# LIBRARY_HAS_NO_CIPHERS, the WARP-317 boot block). So EACH instance
# gets its OWN copy at its OWN baked MODULESDIR: the system dir (as
# before) plus pyca's baked dir, extracted from the wheel's Rust
# extension. The probe below fails the build if the extraction or the
# dual activation ever drifts on a cryptography upgrade.
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN pyca_so="$(python -c 'import pathlib, cryptography; print(next((pathlib.Path(cryptography.__file__).parent / "hazmat" / "bindings").glob("_rust*.so")))')" && \
    pyca_moddir="$(grep -a -o -m1 'MODULESDIR: "[^"]*"' "$pyca_so" | sed 's/^MODULESDIR: "//; s/"$//')" && \
    { [ -n "$pyca_moddir" ] || { echo "FIPS: could not extract pyca cryptography's baked MODULESDIR from $pyca_so" >&2; exit 1; }; } && \
    sh /tmp/install-fips-provider.sh /tmp/fips.so "$pyca_moddir" && \
    rm -f /tmp/fips.so /tmp/install-fips-provider.sh

# WARP-967: probe the runtime combination for Python — CPython links the
# system (Debian) libcrypto, so OPENSSL_CONF alone activates the
# provider. `_hashlib` is probed directly because `hashlib.new()` can
# silently fall back to CPython's built-in non-OpenSSL `_md5` module and
# mask enforcement. WARP-1063: pyca cryptography's static OpenSSL is
# initialized FIRST (exactly the production boot order — the self-test
# touches it before httpx builds a TLS client) to prove both libcrypto
# instances activate their own module copies side by side. OPENSSL_CONF
# is scoped to this RUN only; runtime posture is unchanged.
RUN OPENSSL_CONF=/etc/ssl/openssl-fips.cnf python - <<'PY'
from cryptography.hazmat.backends import default_backend
b = default_backend()  # pyca static OpenSSL inits FIRST (production order)
if not getattr(b, "_fips_enabled", False):
    raise SystemExit("FIPS python self-test FAILED: pyca cryptography did not enter FIPS mode")
from cryptography.hazmat.primitives import hashes
h = hashes.Hash(hashes.SHA256()); h.update(b"probe"); h.finalize()  # pyca instance alive
try:
    hm = hashes.Hash(hashes.MD5()); hm.update(b"probe"); hm.finalize()
except Exception:
    pass
else:
    raise SystemExit("FIPS python self-test FAILED: MD5 succeeded in pyca cryptography under the FIPS config")
import ssl  # system OpenSSL init under the FIPS config must not crash
ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)  # default TLS client context constructible (WARP-1063)
import _hashlib
_hashlib.new("sha256", b"probe")  # FIPS-approved digest still works (system instance alive)
try:
    _hashlib.new("md5", b"probe", usedforsecurity=True)
except ValueError as exc:
    print(f"FIPS build-time self-test OK (python dual-libcrypto): pyca + system both enforcing, TLS context OK, MD5 rejected ({exc})")
else:
    raise SystemExit("FIPS python self-test FAILED: MD5 succeeded under the FIPS config")
PY

# WARP-3426 — bake every Hugging Face asset the gateway loads; the Hub is
# off-limits at runtime (offline proof below). The appliance never phones
# home: before this, the embedding model (~130 MB) was fetched on the first
# EmbedText after every container recreate, and the classifier/reranker
# loaders re-checked the Hub on each load even when cached. The steps up to
# the HF_HUB_OFFLINE line are the image's only Hub access. Each runs the
# production loader, so the cache holds exactly what runtime asks for, at the
# commit the code pins (providers/embeddings.py PINNED_REVISIONS,
# query_classifier.py, reranker.py).
#
# Embedding model: HARD fail. EmbedText is the indexing path, and the runtime
# can no longer fetch a model this step failed to bake.
ENV HF_HOME=/var/cache/droplet/models/hf
RUN python -c "from providers.embeddings import _get_model; _get_model()"

# WARP-437: the deberta zero-shot classifier. WARP-3426 makes this a HARD
# fail: a failed prewarm used to mean "the first runtime call downloads it";
# with the runtime offline it would mean ClassifyQuery never works.
RUN python -c "from query_classifier import QueryClassifierSingleton; QueryClassifierSingleton.instance()"

# WARP-644: pre-warm + availability self-check for BGE-reranker-base. Uses
# RerankerSingleton.available(), which fails closed (logs once at WARNING and
# returns False) if the optimum/onnxruntime import or model load is broken,
# so a regression surfaces in the build log instead of as silent empty-score
# Rerank responses at runtime. Still soft-fail — the runtime handler degrades
# gracefully to unranked retrieval — but WARP-3426 checks the ONNX bytes too.
RUN (python -c "from reranker import RerankerSingleton; raise SystemExit(0 if RerankerSingleton.available() else 1)" && \
     echo "15b9a8c3da82eddf263df571281166e00e9308fe19d077084b642ebfcaf06d2b  /var/cache/droplet/models/bge-reranker-base/models--BAAI--bge-reranker-base/snapshots/2cfc18c9415c912f9d8155881c133215df768a70/onnx/model.onnx" | sha256sum -c -) \
    || (echo "WARP-644: reranker prewarm/self-check FAILED — Rerank will return empty scores until the optimum/onnxruntime import is repaired" >&2; true)

# WARP-3426: pin the bytes, not just the commit, for what defines the
# embedding space (tokenizer + weights — every stored vector came from these;
# WARP-2196) and for the classifier weights. Read off the Hub's pinned tree.
RUN echo "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66  ${HF_HOME}/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/tokenizer.json" | sha256sum -c - && \
    echo "3c9f31665447c8911517620762200d2245a2518d6e7208acc78cd9db317e21ad  ${HF_HOME}/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/model.safetensors" | sha256sum -c - && \
    echo "6e8f2af78c828dcbd5243aac40fb87430376f0b8a9c288f4993df3ea3558d557  /var/cache/droplet/models/query-classifier/models--MoritzLaurer--deberta-v3-base-zeroshot-v2.0/snapshots/8e7e5af5983a0ddb1a5b45a38b129ab69e2258e8/model.safetensors" | sha256sum -c -

# WARP-3426 — from here on the Hub does not exist. HF_HUB_OFFLINE makes every
# huggingface_hub lookup resolve from the baked cache or raise; it never
# downloads. TRANSFORMERS_OFFLINE / HF_DATASETS_OFFLINE are belt-and-braces
# for libraries that check their own flag.
# Then prove it: reload through the production loaders with no network at
# all. A missing asset, or a code pin that drifted from the bake, fails the
# image build here instead of on a customer's box. The reranker keeps its
# WARP-644 soft-fail, but an offline-only failure is named in the build log.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1
RUN --network=none python -c "from providers.embeddings import _get_model; _get_model()" && \
    python -c "from query_classifier import QueryClassifierSingleton; QueryClassifierSingleton.instance()"
RUN --network=none python -c "from reranker import RerankerSingleton; raise SystemExit(0 if RerankerSingleton.available() else 1)" \
    || (echo "WARP-3426: reranker did not load OFFLINE — Rerank will return empty scores on the box" >&2; true)

EXPOSE 8000
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "8000"]
