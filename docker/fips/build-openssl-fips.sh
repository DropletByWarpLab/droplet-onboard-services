#!/bin/sh
# =============================================================================
# WARP-967 — source-build the NIST-validated OpenSSL FIPS provider (fips.so)
# =============================================================================
#
# Runs inside the dedicated `fips-builder` Docker build stage that every
# shipped service image carries (apps/orchestrator, services/mcp-server,
# apps/web-dashboard, services/file-indexer, services/ai-gateway). It
# compiles the FIPS module ONLY — runtime images keep Debian Bookworm's
# stock OpenSSL packages; the module artifact is COPY'd across stages and
# installed + self-tested by docker/fips/install-fips-provider.sh.
#
# Version pin — OpenSSL 3.0.9, NIST CMVP certificate #4282:
#   The OpenSSL FIPS provider validated under CMVP certificate #4282 (the
#   certificate this repo standardized on — see docker/openssl-fips.cnf and
#   docs/security/fips-allowed-algorithms.md) covers the module as built
#   from the 3.0.0 / 3.0.8 / 3.0.9 source releases; 3.0.9 is the newest
#   release on that certificate. Only fips.so is built from 3.0.9 —
#   libcrypto/libssl at runtime stay the distro's. That combination
#   (validated module + newer compatible 3.x libcrypto) is the deployment
#   model the OpenSSL security policy describes: the provider API isolates
#   the validated boundary inside fips.so.
#
#   https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4282
#
# The tarball URL + sha256 are pinned so the build is reproducible and the
# Docker layer cache stays stable. The sha256 was cross-checked against the
# published openssl.org checksum file
# (https://www.openssl.org/source/old/3.0/openssl-3.0.9.tar.gz.sha256).
#
# Arch-neutral by construction: `./Configure` auto-detects the target
# platform, so the same script builds linux/amd64 and linux/arm64.
set -eux

OUT_DIR="${1:-/out}"
OPENSSL_FIPS_VERSION="3.0.9"
OPENSSL_FIPS_SHA256="eb1ab04781474360f77c318ab89d8c5a03abc38e63d65a603cabbf1b00a1dc90"

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gcc make perl libc6-dev
rm -rf /var/lib/apt/lists/*

curl --fail -L -o "/tmp/openssl-${OPENSSL_FIPS_VERSION}.tar.gz" \
  "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_FIPS_VERSION}/openssl-${OPENSSL_FIPS_VERSION}.tar.gz"
echo "${OPENSSL_FIPS_SHA256}  /tmp/openssl-${OPENSSL_FIPS_VERSION}.tar.gz" | sha256sum -c -

tar -xzf "/tmp/openssl-${OPENSSL_FIPS_VERSION}.tar.gz" -C /tmp
cd "/tmp/openssl-${OPENSSL_FIPS_VERSION}"

# `enable-fips` builds providers/fips.so alongside the normal libraries.
./Configure enable-fips

# build_sw = libraries + providers + apps, skipping docs/tests. The module's
# Known Answer Tests are NOT run here — `openssl fipsinstall` executes them
# inside every runtime image (see install-fips-provider.sh), so each image
# build carries its own KAT evidence.
make -j"$(nproc)" build_sw

install -D -m 0644 providers/fips.so "${OUT_DIR}/fips.so"
