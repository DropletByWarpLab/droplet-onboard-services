#!/bin/sh
# =============================================================================
# WARP-967 — install the validated FIPS provider + build-time FIPS self-test
# =============================================================================
#
# Runs in each shipped service image's runtime stage. Preconditions: a
# Debian Bookworm base with the `openssl` package installed and the shared
# FIPS activation config already in place at /etc/ssl/openssl-fips.cnf
# (docker/openssl-fips.cnf). Steps:
#
#   1. Install fips.so (source-built from the OpenSSL 3.0.9 release —
#      NIST CMVP certificate #4282, see docker/fips/build-openssl-fips.sh)
#      into the system OpenSSL MODULESDIR. The dir is resolved at run time
#      (`openssl version -m`) because it is arch-dependent on Debian:
#      /usr/lib/x86_64-linux-gnu/ossl-modules vs
#      /usr/lib/aarch64-linux-gnu/ossl-modules.
#   2. `openssl fipsinstall` — executes the module's Known Answer Tests
#      (the FIPS self-test) and emits /etc/ssl/fipsmodule.cnf carrying the
#      module integrity MAC. A KAT failure fails the docker build.
#   3. Positive probe — under /etc/ssl/openssl-fips.cnf the FIPS provider
#      reports active at version 3.0.9 and a FIPS-approved digest works.
#   4. Negative probe — MD5 is not FIPS-approved; under the FIPS config it
#      must be REJECTED. If it succeeds the provider is loaded but not
#      enforcing, and the build fails. (Probed via the `openssl` CLI — the
#      runtime-native negative probes live in each Dockerfile.)
#
# Shipping fips.so + fipsmodule.cnf does NOT flip any service into FIPS
# mode: activation stays opt-in via OPENSSL_CONF + DROPLET_FIPS_REQUIRED
# in the container environment (deployment activation is WARP-318).
set -eu

FIPS_SO="${1:?usage: install-fips-provider.sh /path/to/fips.so}"
FIPS_CONF="/etc/ssl/openssl-fips.cnf"

# The Node images bake `ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf`
# image-wide (WARP-229). Until fipsinstall has emitted fipsmodule.cnf,
# that config cannot fully load — so the bootstrap openssl calls below
# pin the stock Debian config explicitly. The probes then opt back in.
BOOTSTRAP_CONF="/etc/ssl/openssl.cnf"

if [ ! -f "$FIPS_CONF" ]; then
  echo "install-fips-provider: $FIPS_CONF missing — COPY docker/openssl-fips.cnf first" >&2
  exit 1
fi

MODULESDIR="$(OPENSSL_CONF="$BOOTSTRAP_CONF" openssl version -m | sed -n 's/^MODULESDIR: "\(.*\)"$/\1/p')"
if [ -z "$MODULESDIR" ]; then
  echo "install-fips-provider: could not resolve OpenSSL MODULESDIR" >&2
  exit 1
fi

install -D -m 0644 "$FIPS_SO" "${MODULESDIR}/fips.so"

# Step 2 — run the module KATs and write the integrity-MAC config that
# /etc/ssl/openssl-fips.cnf `.include`s.
OPENSSL_CONF="$BOOTSTRAP_CONF" openssl fipsinstall \
  -module "${MODULESDIR}/fips.so" -out /etc/ssl/fipsmodule.cnf

# Step 3 — positive probes.
providers="$(OPENSSL_CONF="$FIPS_CONF" openssl list -providers)"
printf '%s\n' "$providers"
printf '%s\n' "$providers" | grep -q "OpenSSL FIPS Provider"
printf '%s\n' "$providers" | grep -q "version: 3.0.9"
active_count="$(printf '%s\n' "$providers" | grep -c "status: active")"
if [ "$active_count" -lt 2 ]; then
  echo "FIPS build-time self-test FAILED: expected base + fips providers active, got $active_count" >&2
  exit 1
fi
OPENSSL_CONF="$FIPS_CONF" openssl sha256 /dev/null >/dev/null

# Step 4 — negative probe.
if OPENSSL_CONF="$FIPS_CONF" openssl md5 /dev/null >/dev/null 2>&1; then
  echo "FIPS build-time self-test FAILED: MD5 digest succeeded under the FIPS config" >&2
  exit 1
fi

echo "FIPS build-time self-test OK — fips.so 3.0.9 (CMVP #4282) at ${MODULESDIR}/fips.so, KATs passed, MD5 rejected"
