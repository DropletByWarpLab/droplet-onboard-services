FROM python:3.12-slim

# Install uv as a static binary — used to enforce hash-locked dep installs
# from `requirements.lock`. Pinned to a specific release so the install
# step itself is reproducible. See WARP-285 + scripts/refresh-lockfile.sh.
COPY --from=ghcr.io/astral-sh/uv:0.4.27 /uv /uvx /usr/local/bin/

WORKDIR /app

# Install runtime deps from the locked + hashed manifest. `--require-hashes`
# turns any drift between requirements.lock and what the index serves into
# a build-time error instead of silently pulling a different version.
# `--system` installs into the base image's Python (no venv needed).
COPY services/inference-manager/requirements.lock .
RUN uv pip install --system --no-cache --require-hashes -r requirements.lock

COPY services/inference-manager/ .

# Run as an unprivileged user. The deps are installed system-wide above (as
# root, before this switch), and the app only needs to read its own code, the
# read-only manifest mount, and make outbound HTTP to Ollama — none of which
# need root. The healthcheck (python3 urllib probe) works fine as non-root.
# See LLM-12.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

EXPOSE 8002
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
