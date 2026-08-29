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

# 6) Compose wiring: the gateway service BUILDS the FIPS-capable image (no more
#    pulled nginx:alpine), passes the knob + OPENSSL_CONF, and mounts the moved
#    nginx.conf path. Textual assertions (python3+yaml not guaranteed here);
#    scoped to the `gateway:` service block only.
compose="$REPO_ROOT/docker/docker-compose.yml"
gw_block="$(awk '/^  gateway:/{f=1; next} f && /^  [a-zA-Z]/{exit} f{print}' "$compose")"
if printf '%s\n' "$gw_block" | grep -q 'dockerfile: docker/nginx/Dockerfile' \
   && ! printf '%s\n' "$gw_block" | grep -q 'image: nginx:alpine'; then
  pass "compose gateway builds docker/nginx/Dockerfile (nginx:alpine dropped)"
else
  fail "compose gateway is not built from docker/nginx/Dockerfile"
fi
if printf '%s\n' "$gw_block" | grep -qE 'DROPLET_FIPS_MODE=\$\{DROPLET_FIPS_MODE:-0\}' \
   && printf '%s\n' "$gw_block" | grep -qE 'OPENSSL_CONF=\$\{OPENSSL_CONF:-'; then
  pass "compose gateway threads DROPLET_FIPS_MODE (default 0) + OPENSSL_CONF"
else
  fail "compose gateway is missing the DROPLET_FIPS_MODE / OPENSSL_CONF env wiring"
fi
if printf '%s\n' "$gw_block" | grep -q './nginx/nginx.conf:/etc/nginx/nginx.conf:ro'; then
  pass "compose gateway mounts the moved docker/nginx/nginx.conf read-only"
else
  fail "compose gateway does not mount ./nginx/nginx.conf:ro"
fi

# 7) CI wiring: docker-build.yml must know the gateway image (KNOWN list +
#    a per-image path filter + docker/nginx/** in the workflow triggers) —
#    otherwise the detect job's drift check fails, or gateway-scoped PRs
#    silently skip the image build.
dbw="$REPO_ROOT/.github/workflows/docker-build.yml"
if grep -q '"gateway"' "$dbw"; then
  pass "docker-build.yml KNOWN list includes gateway"
else
  fail "docker-build.yml KNOWN list is missing gateway"
fi
if grep -qE '^\s+gateway:' "$dbw" && grep -q '"docker/nginx/\*\*"' "$dbw"; then
  pass "docker-build.yml has a gateway path filter on docker/nginx/**"
else
  fail "docker-build.yml is missing the gateway per-image filter"
fi

# 8) setup.sh build phase: gateway must be in build_services (the
#    compute_build_list_drift guard + tests/setup.test.sh Phase 12 parity
#    check both key off this list).
if awk '/^  local build_services=\(/{f=1} f{print} f&&/^  \)/{exit}' \
     "$REPO_ROOT/scripts/lib/compose.sh" | grep -qE '^\s+gateway$'; then
  pass "scripts/lib/compose.sh build_services includes gateway"
else
  fail "scripts/lib/compose.sh build_services is missing gateway"
fi

# 9) This suite runs in CI: ci.yml's `fips` leg must invoke it.
#    WARP-2481 moved the FIPS static-lint job out of test-fips.yml (a
#    path-filtered workflow, whose jobs can never be required status checks)
#    and into ci.yml, where `ci-summary` aggregates it. Follow the file.
#    Match the `run:` INVOCATION, not the bare filename: the filename also
#    appears in detect's `fips:` path filter, so a substring grep stays green
#    even if the step that actually executes this suite is deleted.
ciy="$REPO_ROOT/.github/workflows/ci.yml"
if grep -qE '^[[:space:]]*run:[[:space:]]*bash tests/nginx-fips\.test\.sh[[:space:]]*$' "$ciy"; then
  pass "ci.yml's fips leg runs tests/nginx-fips.test.sh"
else
  fail "ci.yml has no step running tests/nginx-fips.test.sh"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mResults: %d passed, 0 failed\033[0m\n\n" "$TESTS"
  exit 0
else
  printf "  \033[31mResults: %d passed, %d failed\033[0m\n\n" "$((TESTS - FAILURES))" "$FAILURES"
  exit 1
fi
