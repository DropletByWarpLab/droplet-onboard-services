#!/usr/bin/env bash
# =============================================================================
# WARP-1021 — Docker-free checks for the FIPS-capable nginx gateway artifacts.
# =============================================================================
#
# The full build-time self-test (KATs + probes + `nginx -t` on both cipher
# profiles) runs inside docker/nginx/Dockerfile and needs a Docker build. This
# unit test validates the artifacts on any box (no Docker):
#   * the DEFAULT cipher profile is byte-equivalent to the old inline
#     nginx:alpine config (OFF-path posture unchanged),
#   * the entrypoint actually SELECTS the right profile from DROPLET_FIPS_MODE
#     (executed here against a temp dir — it's just `ln -sf`),
#   * the FIPS profile restricts TLS 1.3 to AES-GCM (drops ChaCha) + activates
#     the validated OpenSSL config,
#   * nginx.conf `include`s the active profile (not the removed inline lines),
#   * the Dockerfile builds + installs the validated provider via the real
#     shared script and self-tests both profiles.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_DIR="$REPO_ROOT/docker/nginx"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  WARP-1021 nginx-gateway FIPS artifact checks (no Docker)"
echo ""

# 1) DEFAULT profile == the old inline posture (TLS 1.2/1.3 + HIGH:!aNULL:!MD5).
def="$NGINX_DIR/cipher-profile.default.conf"
if grep -qE '^ssl_protocols[[:space:]]+TLSv1\.2 TLSv1\.3;' "$def" \
   && grep -qE '^ssl_ciphers[[:space:]]+HIGH:!aNULL:!MD5;' "$def"; then
  pass "default profile keeps the old modern posture (TLS 1.2/1.3, HIGH:!aNULL:!MD5)"
else
  fail "default profile diverged from the old inline nginx:alpine posture"
fi

# 2) FIPS profile restricts TLS 1.3 to AES-GCM (no ChaCha) + ECDHE-AES-GCM 1.2.
#    Check DIRECTIVE lines only (strip `#` comments — the rationale comment
#    legitimately mentions ChaCha as the thing being excluded).
fips="$NGINX_DIR/cipher-profile.fips.conf"
fips_directives="$(grep -vE '^[[:space:]]*#' "$fips")"
if printf '%s\n' "$fips_directives" | grep -qE '^ssl_conf_command[[:space:]]+Ciphersuites[[:space:]]+TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256;' \
   && ! printf '%s\n' "$fips_directives" | grep -qi 'chacha' \
   && printf '%s\n' "$fips_directives" | grep -qE 'ECDHE-[A-Z]+-AES256-GCM-SHA384'; then
  pass "fips profile restricts to FIPS-approved AES-GCM suites (ChaCha dropped)"
else
  fail "fips profile does not restrict to the FIPS-approved suite set"
fi

# 3) nginx.conf includes the active profile, and the removed inline lines are
#    gone (no hard-coded ssl_ciphers in the server block).
conf="$NGINX_DIR/nginx.conf"
if grep -qE 'include[[:space:]]+/etc/nginx/cipher-profile\.active\.conf;' "$conf" \
   && ! grep -qE '^[[:space:]]*ssl_ciphers[[:space:]]+HIGH:!aNULL:!MD5;' "$conf"; then
  pass "nginx.conf includes cipher-profile.active.conf (inline ciphers removed)"
else
  fail "nginx.conf still inlines ciphers or is missing the profile include"
fi

# 4) The entrypoint SELECTS the right profile from DROPLET_FIPS_MODE. Run it in a
#    sandbox that mimics /etc/nginx, once OFF once ON, and inspect the symlink.
entry="$NGINX_DIR/docker-entrypoint-fips.sh"
run_entry() {  # $1 = DROPLET_FIPS_MODE value
  local box; box="$(mktemp -d)"
  mkdir -p "$box/etc/nginx"
  : > "$box/etc/nginx/cipher-profile.default.conf"
  : > "$box/etc/nginx/cipher-profile.fips.conf"
  # Run a copy with the /etc/nginx paths rewritten to the sandbox.
  sed "s#/etc/nginx#$box/etc/nginx#g; s#/etc/ssl#$box/etc/ssl#g" "$entry" > "$box/entry.sh"
  DROPLET_FIPS_MODE="$1" sh "$box/entry.sh" >/dev/null 2>&1
  # Resolve what cipher-profile.active.conf points at.
  readlink "$box/etc/nginx/cipher-profile.active.conf" | sed "s#$box##"
  rm -rf "$box"
}
off_target="$(run_entry 0)"
on_target="$(run_entry 1)"
[ "$off_target" = "/etc/nginx/cipher-profile.default.conf" ] \
  && pass "entrypoint: DROPLET_FIPS_MODE=0 → active → default profile" \
  || fail "entrypoint OFF selected '$off_target' (expected default)"
[ "$on_target" = "/etc/nginx/cipher-profile.fips.conf" ] \
  && pass "entrypoint: DROPLET_FIPS_MODE=1 → active → fips profile" \
  || fail "entrypoint ON selected '$on_target' (expected fips)"

# 5) Dockerfile: Bookworm nginx, builds + installs the validated provider via
#    the real shared script, and self-tests the cipher profiles.
df="$NGINX_DIR/Dockerfile"
if grep -qE '^FROM nginx:1\.27-bookworm' "$df"; then
  pass "Dockerfile uses Bookworm nginx (not Alpine)"
else
  fail "Dockerfile is not FROM nginx:1.27-bookworm"
fi
if grep -q 'docker/fips/build-openssl-fips.sh' "$df" \
   && grep -q 'docker/fips/install-fips-provider.sh' "$df"; then
  pass "Dockerfile builds + installs the validated FIPS provider (shared scripts)"
else
  fail "Dockerfile does not use the shared FIPS build/install scripts"
fi
if grep -qE 'nginx -t -c /tmp/test-nginx.conf' "$df"; then
  pass "Dockerfile self-tests both cipher profiles via nginx -t"
else
  fail "Dockerfile is missing the nginx cipher-profile self-test"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mResults: %d passed, 0 failed\033[0m\n\n" "$TESTS"
  exit 0
else
  printf "  \033[31mResults: %d passed, %d failed\033[0m\n\n" "$((TESTS - FAILURES))" "$FAILURES"
  exit 1
fi
