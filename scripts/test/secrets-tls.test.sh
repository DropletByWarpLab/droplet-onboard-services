#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — secrets.sh::_generate_tls_cert regression tests
# =============================================================================
#
# ADR-023 PR-2: _generate_tls_cert must never CLOBBER a live publicly-trusted
# (ZeroSSL / Google Trust Services / Let's Encrypt) fullchain that the box-side
# tls-issuance cron installed into docker/certs/droplet.{crt,key}. Three real
# behaviours this guards, each a separate test:
#
#   1. SELF-SIGNED + SAN-INCOMPLETE → still regenerates a fresh self-signed
#      cert AND writes the droplet.{crt,key}.bootstrap side-copies (the exact
#      bytes clients trust via trust-droplet-cert), idempotently.
#   2. PUBLIC-CA LEAF INSTALLED → _generate_tls_cert leaves docker/certs/
#      droplet.crt BYTE-IDENTICAL — a re-run must not silently revert the box
#      to self-signed until the next 04:00 issuance cron.
#   3. EXPIRED LEAF + valid .bootstrap present → restore the bootstrap pair
#      (so trust-store clients still connect) instead of -newkey'ing a fresh
#      keypair that breaks every client that imported the original cert.
#
# Harness pattern (mirrors scripts/test/ship-check.test.sh):
#   - Each test mktemp -d's an isolated REPO_ROOT/docker/certs sandbox.
#   - We source scripts/lib/logging.sh for the log_* helpers and stub
#     reload_gateway_nginx (no gateway here), then source secrets.sh so we can
#     call _generate_tls_cert directly. Real openssl throughout — no mocks.
#   - Each test returns 0/1 explicitly; _run_test surfaces pass/fail. Temp dirs
#     are rm -rf'd via trap on RETURN even on early abort.
#
# ADR-023 PR-2.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_SH="$REPO_ROOT_REAL/scripts/lib/secrets.sh"
LOGGING_SH="$REPO_ROOT_REAL/scripts/lib/logging.sh"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _RESET=''
fi

TOTAL=0
PASSED=0
FAILED=0
FAILED_NAMES=()

_pass() { PASSED=$((PASSED + 1)); printf "  ${_GREEN}PASS${_RESET}  %s\n" "$1"; }
_fail() {
  FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1")
  printf "  ${_RED}FAIL${_RESET}  %s\n" "$1"
}

_run_test() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  printf "\n${_BOLD}→ %s${_RESET}\n" "$name"
  if "$@"; then
    _pass "$name"
  else
    _fail "$name"
  fi
}

# Source secrets.sh into a SUBSHELL with REPO_ROOT pointed at the sandbox and a
# stub reload_gateway_nginx, then run _generate_tls_cert. Echoed via a function
# so each test gets a clean function table. Runs in a subshell so the sourced
# definitions never leak between tests.
_run_generate_tls_cert() {
  local sandbox="$1"
  (
    set +e
    # shellcheck source=/dev/null
    source "$LOGGING_SH" >/dev/null 2>&1 || { echo "could not source logging.sh" >&2; exit 90; }
    # Stub the gateway reload — no nginx in the sandbox. Define BEFORE sourcing
    # secrets.sh so secrets.sh sees it already declared and does not pull in
    # tls-reload.sh.
    reload_gateway_nginx() { return 0; }
    export REPO_ROOT="$sandbox"
    # shellcheck source=/dev/null
    source "$SECRETS_SH" >/dev/null 2>&1 || { echo "could not source secrets.sh" >&2; exit 91; }
    type _generate_tls_cert >/dev/null 2>&1 || { echo "_generate_tls_cert not defined" >&2; exit 92; }
    _generate_tls_cert >/dev/null 2>&1
    exit $?
  )
}

# On Git-Bash/MSYS the `-subj "/CN=..."` value gets path-mangled into a Windows
# path unless we exclude it from arg conversion. Scope the exclusion to the
# leading `/CN=` token only, so file-path args are still translated. On real
# Linux (CI / the box) MSYS2_ARG_CONV_EXCL is simply unset and ignored.
export MSYS2_ARG_CONV_EXCL='/CN='

# Generate a self-signed cert into <crt> <key> with an EXPLICIT SAN + validity.
# Used to build SAN-incomplete and expired fixtures with real openssl.
_make_self_signed() {
  local crt="$1" key="$2" san="$3" days="$4" cn="${5:-Droplet Edge Device}"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -days "$days" \
    -keyout "$key" \
    -out "$crt" \
    -subj "/CN=$cn" \
    -addext "subjectAltName=$san" \
    2>/dev/null
}

# Build a tiny CA + a leaf signed by it (a "public-CA-style" leaf: issuer !=
# subject, and `openssl verify -CAfile leaf leaf` fails self-verify). Writes the
# leaf cert+key to <leaf_crt> <leaf_key>. Real openssl, no network.
_make_ca_signed_leaf() {
  local workdir="$1" leaf_crt="$2" leaf_key="$3" leaf_days="${4:-90}"
  local ca_key="$workdir/ca.key" ca_crt="$workdir/ca.crt" csr="$workdir/leaf.csr"
  # CA
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$ca_key" -out "$ca_crt" \
    -subj "/CN=Droplet Test Root CA" 2>/dev/null
  # Leaf CSR
  openssl req -nodes -newkey rsa:2048 \
    -keyout "$leaf_key" -out "$csr" \
    -subj "/CN=d-deadbeef.devices.warp-lab.ai" 2>/dev/null
  # Sign leaf with the CA (issuer != subject). Use a real extfile rather than
  # process substitution — mingw openssl can't open a `<(...)` FD path.
  local extcnf="$workdir/leaf-ext.cnf"
  printf 'subjectAltName=DNS:d-deadbeef.devices.warp-lab.ai\n' > "$extcnf"
  openssl x509 -req -in "$csr" \
    -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
    -days "$leaf_days" \
    -extfile "$extcnf" \
    -out "$leaf_crt" 2>/dev/null
}

_sha() { openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'; }

# =============================================================================
# Test 1: self-signed + SAN-incomplete → regenerates AND creates .bootstrap
# =============================================================================
test_selfsigned_san_incomplete_regenerates_and_bootstraps() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # Install a self-signed cert that is missing required SANs (only localhost) —
  # triggers the SAN-incomplete regeneration path.
  _make_self_signed "$crt" "$key" "DNS:localhost" 3650

  local before_sha; before_sha="$(_sha "$crt")"

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on SAN-incomplete self-signed\n" >&2
    return 1
  fi

  # The cert must have been REGENERATED (different bytes; now SAN-complete).
  local after_sha; after_sha="$(_sha "$crt")"
  if [ "$before_sha" = "$after_sha" ]; then
    printf "    expected regeneration of the SAN-incomplete self-signed cert, bytes unchanged\n" >&2
    return 1
  fi
  if ! openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:droplet.lan'; then
    printf "    regenerated cert is still SAN-incomplete (missing droplet.lan)\n" >&2
    return 1
  fi

  # The .bootstrap side-copies must now exist and be byte-identical to the
  # freshly-generated pair (the exact bytes clients trust via trust-droplet-cert).
  if [ ! -f "$crt.bootstrap" ] || [ ! -f "$key.bootstrap" ]; then
    printf "    .bootstrap side-copies were not created\n" >&2
    return 1
  fi
  if [ "$(_sha "$crt")" != "$(_sha "$crt.bootstrap")" ]; then
    printf "    droplet.crt.bootstrap does not match the generated droplet.crt\n" >&2
    return 1
  fi
  if [ "$(_sha "$key")" != "$(_sha "$key.bootstrap")" ]; then
    printf "    droplet.key.bootstrap does not match the generated droplet.key\n" >&2
    return 1
  fi

  # Idempotence: a SECOND run must NOT overwrite an existing .bootstrap. Pin the
  # bootstrap bytes, force another regeneration (re-install a SAN-incomplete
  # cert into droplet.crt), and assert .bootstrap is unchanged.
  local boot_crt_sha boot_key_sha
  boot_crt_sha="$(_sha "$crt.bootstrap")"; boot_key_sha="$(_sha "$key.bootstrap")"
  _make_self_signed "$crt" "$key" "DNS:localhost" 3650
  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    second _generate_tls_cert run returned non-zero\n" >&2
    return 1
  fi
  if [ "$(_sha "$crt.bootstrap")" != "$boot_crt_sha" ] \
     || [ "$(_sha "$key.bootstrap")" != "$boot_key_sha" ]; then
    printf "    .bootstrap was overwritten on a second run (must be idempotent)\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 2: a public-CA leaf installed → droplet.crt left BYTE-IDENTICAL
# =============================================================================
test_public_ca_leaf_not_clobbered() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # Install a CA-signed leaf (issuer != subject; fails openssl self-verify).
  # Its SAN is intentionally INCOMPLETE (only the FQDN) so the SAN-incomplete
  # trigger fires — the guard must still refuse to overwrite it because it is a
  # public-CA leaf, NOT self-signed.
  _make_ca_signed_leaf "$sandbox" "$crt" "$key" 90

  local before_crt_sha before_key_sha
  before_crt_sha="$(_sha "$crt")"; before_key_sha="$(_sha "$key")"

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on an installed public-CA leaf\n" >&2
    return 1
  fi

  if [ "$(_sha "$crt")" != "$before_crt_sha" ]; then
    printf "    droplet.crt was CLOBBERED — a public-CA leaf must be left in place\n" >&2
    return 1
  fi
  if [ "$(_sha "$key")" != "$before_key_sha" ]; then
    printf "    droplet.key was overwritten — the public-CA private key must be left in place\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 3: expired leaf + valid .bootstrap → restored from bootstrap
# =============================================================================
test_expired_leaf_restores_bootstrap() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # A valid bootstrap pair exists (self-signed, SAN-complete, long-lived) — the
  # exact bytes trust-store clients imported.
  local full_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:127.0.0.1"
  _make_self_signed "$crt.bootstrap" "$key.bootstrap" "$full_san" 3650
  local boot_crt_sha boot_key_sha
  boot_crt_sha="$(_sha "$crt.bootstrap")"; boot_key_sha="$(_sha "$key.bootstrap")"

  # The INSTALLED cert is one that has already EXPIRED. openssl 3.x lets us pin
  # notBefore/notAfter in the past via -not_before/-not_after, so we get a
  # genuinely-expired leaf without clock games. (Self-signed is fine here — the
  # expired+bootstrap restore path keys on expiry + a usable bootstrap, not on
  # whether the expired cert was CA-signed.)
  local past="19990101000000Z" past_end="19990102000000Z"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$key" -out "$crt" \
    -subj "/CN=Droplet Edge Device" \
    -addext "subjectAltName=$full_san" \
    -not_before "$past" -not_after "$past_end" \
    2>/dev/null

  # Sanity: the installed cert must actually be expired (checkend 0 fails).
  if openssl x509 -checkend 0 -noout -in "$crt" >/dev/null 2>&1; then
    printf "    fixture error: installed cert is not expired\n" >&2
    return 1
  fi

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on expired-leaf + bootstrap\n" >&2
    return 1
  fi

  # The installed pair must now be the RESTORED bootstrap pair (byte-identical),
  # NOT a fresh -newkey keypair.
  if [ "$(_sha "$crt")" != "$boot_crt_sha" ]; then
    printf "    droplet.crt was not restored from droplet.crt.bootstrap\n" >&2
    return 1
  fi
  if [ "$(_sha "$key")" != "$boot_key_sha" ]; then
    printf "    droplet.key was not restored from droplet.key.bootstrap (a fresh -newkey would break trust-store clients)\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Driver
# =============================================================================
printf "\n  ${_BOLD}secrets.sh TLS-clobber regression test suite${_RESET}\n"
printf "  Real repo: %s\n" "$REPO_ROOT_REAL"
printf "  ──────────────────────────────────\n"

_run_test "self-signed + SAN-incomplete regenerates AND writes .bootstrap (idempotent)" \
  test_selfsigned_san_incomplete_regenerates_and_bootstraps

_run_test "public-CA leaf is NOT clobbered (droplet.crt byte-identical)" \
  test_public_ca_leaf_not_clobbered

_run_test "expired leaf + valid .bootstrap is restored from bootstrap" \
  test_expired_leaf_restores_bootstrap

printf "\n  ──────────────────────────────────\n"
printf "  Results: %d/%d passed" "$PASSED" "$TOTAL"
if [ "$FAILED" -gt 0 ]; then
  printf "  ${_RED}(%d failed)${_RESET}\n" "$FAILED"
  printf "  Failed: %s\n" "${FAILED_NAMES[*]}"
  exit 1
fi
printf "  ${_GREEN}(all passed)${_RESET}\n"
exit 0
