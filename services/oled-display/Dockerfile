FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root. WARP-229.

# System deps are just Pillow's native libs + DejaVu for the on-screen font.
# The old SPI/GPIO/evdev build chain (gcc + python3-dev + linux-libc-dev) is
# gone along with spidev/evdev/Jetson.GPIO/luma.lcd — PyPortal needs only
# pyserial, which ships as a pure-Python wheel.
# WARP-229 — also installs openssl + ca-certificates for the FIPS provider.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libfreetype6-dev libjpeg62-turbo-dev libopenjp2-7 \
    fonts-dejavu-core \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/oled-display/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/oled-display/ .

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. `OPENSSL_CONF` is intentionally NOT set at image-baseline (see
# services/file-indexer/Dockerfile rationale).
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py

EXPOSE 8082
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8082"]
