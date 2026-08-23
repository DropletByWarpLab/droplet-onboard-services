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
#
# WARP-2132: an optional second argument (space-separated IPv4s) is exported as
# DROPLET_TLS_CURRENT_IPS — secrets.sh's test hook overriding the live
# interface harvest — so IP-coverage behaviour is deterministic on any host.
_run_generate_tls_cert() {
  local sandbox="$1" current_ips="${2:-}"
  (
    set +e
    # shellcheck source=/dev/null
    source "$LOGGING_SH" >/dev/null 2>&1 || { echo "could not source logging.sh" >&2; exit 90; }
    # Stub the gateway reload — no nginx in the sandbox. Define BEFORE sourcing
    # secrets.sh so secrets.sh sees it already declared and does not pull in
    # tls-reload.sh.
    reload_gateway_nginx() { return 0; }
    export REPO_ROOT="$sandbox"
    [ -n "$current_ips" ] && export DROPLET_TLS_CURRENT_IPS="$current_ips"
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
  # WARP-2132: optional SAN override so a test can mint a CA-signed leaf that
  # ALSO satisfies _cert_has_all_required_sans (exercising the skip-guard's
  # public-CA exemption rather than the preserve branch further down).
  local san="${5:-DNS:d-deadbeef.devices.warp-lab.ai}"
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
  printf 'subjectAltName=%s\n' "$san" > "$extcnf"
  openssl x509 -req -in "$csr" \
    -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
    -days "$leaf_days" \
    -extfile "$extcnf" \
    -out "$leaf_crt" 2>/dev/null
  # Append the CA cert to form a fullchain — production tls-issuance cron writes
  # leaf + intermediate in one PEM; the fixture must match that shape so
  # _cert_is_public_ca_leaf is tested against the actual production file format.
  cat "$ca_crt" >> "$leaf_crt"
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

  # The INSTALLED cert is one that has already EXPIRED. We can't mint one live
  # here: `openssl req -x509 -not_before/-not_after` only exists in OpenSSL
  # >= 3.2, and the CI runner (ubuntu-latest = Ubuntu 24.04) ships OpenSSL
  # 3.0.13 — there those flags are rejected, no cert is written, and
  # _generate_tls_cert then mints a FRESH self-signed cert (no installed cert to
  # restore over), so the assertion below failed only on CI. `openssl req`/`x509`
  # offer no other way to backdate notAfter on 3.0.x, so we freeze the bytes of a
  # genuinely-expired SELF-SIGNED leaf (notBefore/notAfter pinned to 1999, issuer
  # == subject) as a fixture. It is a public cert — no private key is embedded.
  # (Self-signed is required here: it must NOT match _cert_is_public_ca_leaf, so
  # the expired+bootstrap restore path is the one that fires.)
  cat > "$crt" <<'EXPIRED_SELFSIGNED_CERT'
-----BEGIN CERTIFICATE-----
MIIDjjCCAnagAwIBAgIUJ+MiFDAKwfEVM8mcnrY5DruOJn8wDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTRHJvcGxldCBFZGdlIERldmljZTAeFw05OTAxMDEwMDAw
MDBaFw05OTAxMDIwMDAwMDBaMB4xHDAaBgNVBAMME0Ryb3BsZXQgRWRnZSBEZXZp
Y2UwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCjoravziFWnkCYP2QI
HxK0NA4V4kPKU5315DAxZk151P8GbnqNoLrl6XNP0MIy1p7PGdxTGK0sJCWoPkua
eZwol30baGrSfG6/8qP2uiZvDIcWC/TOM1GGwB09V7v6DjJ4UMpFlMLDLoIuDwnc
YG67KplGMQ4bUFJrgdm06KiDWZu051HifoZ6luiUf0hXxiPT7zo3Zo6kYmbRmMZu
FXPsS1MlS8QUy4zbgb3+bAvqv1OMCcOvXLVMgbMenEw0IWqD8NM4cf5P3Md8xPZj
0ZIrRTracGh8R13QsX+EN2BkHLMj8rCshwaCm4GklQGzaf0Afdf63MblMc/ZbeuM
xd4bAgMBAAGjgcMwgcAwHQYDVR0OBBYEFPToxp41dwVP2GytIXOagCHnP1fZMB8G
A1UdIwQYMBaAFPToxp41dwVP2GytIXOagCHnP1fZMA8GA1UdEwEB/wQFMAMBAf8w
bQYDVR0RBGYwZIIJbG9jYWxob3N0ggdkcm9wbGV0gg1kcm9wbGV0LmxvY2Fsggtk
cm9wbGV0LmxhboIKZHJvcGxldC1haYIQZHJvcGxldC1haS5sb2NhbIIOZHJvcGxl
dC1haS5sYW6HBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAC+plejnBZsu4F371VA8
e5a4mYFeOt6rReF0csLNSp6eN0ldDve9dd86d055/KnyY7kI8Hppn450YhttM6WC
4roxiTwc1TwF7PABOWfshArLOz2jYSYxWeZOOUwZ7Cc5mo09OM51132kxA+6UWvM
fSe7+ORcA1xqBe6YHpRXSEL17ntaNXN5HSJnqL97grMlNDrgTWSvFS4lUdhxCFpd
l+OF0oXHub7QmOJIavXVPmSrkMl01/pDw/YnneFNmPnRbuqtArcRGct1qcV3oVKC
nWHa2H1P8p9YKZlpP54UDEmr9ZIpgW5Ulzlo1Qp3pTj5pEd8TJKKGTUVmA9ezUrY
R0g=
-----END CERTIFICATE-----
EXPIRED_SELFSIGNED_CERT
  # A key file must simply EXIST so _generate_tls_cert enters the existing-cert
  # branch; the expired-restore path never reads the installed key (it overwrites
  # it from the .bootstrap copy), so a non-PEM stub is deliberate — no private
  # key material lives in the repo.
  printf 'expired-fixture stub key — never read by the restore path\n' > "$key"

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
# Test 4: a corrupt/unreadable droplet.crt is REGENERATED, not preserved
# =============================================================================
#
# A garbage/truncated droplet.crt also FAILS the openssl self-verify, so the
# public-CA-leaf detector must NOT fail-safe-preserve it (that would pin a broken
# file the gateway can't load, with no self-heal). The parse gate makes
# _cert_is_public_ca_leaf return false on an unparseable cert, so
# _generate_tls_cert falls through and mints a fresh, valid self-signed cert.
test_corrupt_cert_is_regenerated_not_preserved() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # Install a corrupt cert (and a stand-in key). Both files exist so the
  # function enters the existing-cert branch, but the cert does not parse.
  printf 'this is not a valid certificate\n' > "$crt"
  printf 'this is not a valid key\n' > "$key"

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on a corrupt installed cert\n" >&2
    return 1
  fi

  # The corrupt cert must have been REPLACED by a real, parseable, SAN-complete
  # self-signed cert — NOT preserved as the unreadable garbage.
  if ! openssl x509 -in "$crt" -noout >/dev/null 2>&1; then
    printf "    droplet.crt is still unparseable — a corrupt cert must be regenerated, not preserved\n" >&2
    return 1
  fi
  if ! openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:droplet.lan'; then
    printf "    regenerated cert is SAN-incomplete (missing droplet.lan)\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 5 (WARP-595): mismatched cert/key pair + valid .bootstrap → restored
# =============================================================================
#
# A torn write (interrupted openssl/mv from a previous run) can leave a VALID,
# SAN-complete droplet.crt next to a droplet.key from a DIFFERENT keypair. The
# old skip-guard only ever validated the cert, so this broken pair passed
# "already exists, is valid" on every re-run FOREVER while nginx failed to
# load the mismatched pair — the one genuinely non-convergent TLS state.
# With a valid bootstrap pair present, the fix must restore the bootstrap
# bytes (keeping trust-store clients connected), not keep the broken pair.
test_mismatched_pair_restores_bootstrap() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  local full_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:127.0.0.1"

  # Valid bootstrap pair — the trust anchor clients imported.
  _make_self_signed "$crt.bootstrap" "$key.bootstrap" "$full_san" 3650
  local boot_crt_sha boot_key_sha
  boot_crt_sha="$(_sha "$crt.bootstrap")"; boot_key_sha="$(_sha "$key.bootstrap")"

  # Installed: a valid SAN-complete cert whose KEY was then overwritten by a
  # different keypair's key (the torn-pair shape).
  _make_self_signed "$crt" "$key" "$full_san" 3650
  _make_self_signed "$sandbox/unrelated.crt" "$key" "$full_san" 3650

  # Fixture sanity: the installed pair must actually be mismatched.
  local cert_pub key_pub
  cert_pub="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)"
  key_pub="$(openssl pkey -in "$key" -pubout 2>/dev/null)"
  if [ "$cert_pub" = "$key_pub" ]; then
    printf "    fixture error: installed cert/key still match\n" >&2
    return 1
  fi

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on a mismatched pair + bootstrap\n" >&2
    return 1
  fi

  if [ "$(_sha "$crt")" != "$boot_crt_sha" ] || [ "$(_sha "$key")" != "$boot_key_sha" ]; then
    printf "    mismatched pair was not restored from the bootstrap (skip-guard passed a broken pair)\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 6 (WARP-595): mismatched cert/key pair, NO bootstrap → regenerated
# =============================================================================
# Same torn-pair shape as Test 5 but with no bootstrap to restore: the only
# convergent outcome is a fresh, MATCHING, SAN-complete self-signed pair.
test_mismatched_pair_regenerates_without_bootstrap() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  local full_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:127.0.0.1"
  _make_self_signed "$crt" "$key" "$full_san" 3650
  _make_self_signed "$sandbox/unrelated.crt" "$key" "$full_san" 3650

  local before_sha; before_sha="$(_sha "$crt")"

  if ! _run_generate_tls_cert "$sandbox"; then
    printf "    _generate_tls_cert returned non-zero on a mismatched pair without bootstrap\n" >&2
    return 1
  fi

  # Regenerated (bytes changed) …
  if [ "$(_sha "$crt")" = "$before_sha" ]; then
    printf "    mismatched cert was preserved — skip-guard passed a broken pair\n" >&2
    return 1
  fi
  # … the new pair must MATCH …
  local cert_pub key_pub
  cert_pub="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)"
  key_pub="$(openssl pkey -in "$key" -pubout 2>/dev/null)"
  if [ -z "$cert_pub" ] || [ "$cert_pub" != "$key_pub" ]; then
    printf "    regenerated cert/key still do not match\n" >&2
    return 1
  fi
  # … and be SAN-complete.
  if ! openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:droplet.lan'; then
    printf "    regenerated cert is SAN-incomplete (missing droplet.lan)\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 7 (WARP-595 QA note): public-CA leaf + mismatched key → preserved, but
# WARNED — never a silent success
# =============================================================================
#
# Setup cannot mint public-CA material, so preserving the fullchain is correct
# even when the on-disk key doesn't match (a torn issuance write). But the
# 04:00 issuance cron only re-issues inside the ≤30-day renew window (its
# decision is DB-state-driven; it never checks the on-disk key), so a broken
# public-CA pair can sit unloadable for weeks. The preserve branch must
# therefore surface the mismatch on stderr as a WARNING telling the operator
# to trigger re-issuance — not report unqualified success.
test_public_ca_broken_pair_preserved_but_warned() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # Public-CA-style leaf (issuer != subject) whose key is then replaced by an
  # unrelated keypair's key — the torn-issuance shape.
  _make_ca_signed_leaf "$sandbox" "$crt" "$key" 90
  local full_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:127.0.0.1"
  _make_self_signed "$sandbox/unrelated.crt" "$key" "$full_san" 3650

  local before_crt_sha before_key_sha
  before_crt_sha="$(_sha "$crt")"; before_key_sha="$(_sha "$key")"

  # Run with stderr captured so we can inspect the warning.
  local err_file="$sandbox/stderr.txt"
  (
    set +e
    # shellcheck source=/dev/null
    source "$LOGGING_SH" >/dev/null 2>&1 || exit 90
    reload_gateway_nginx() { return 0; }
    export REPO_ROOT="$sandbox"
    # shellcheck source=/dev/null
    source "$SECRETS_SH" >/dev/null 2>&1 || exit 91
    _generate_tls_cert >/dev/null 2>"$err_file"
    exit $?
  )
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "    _generate_tls_cert returned non-zero on a broken public-CA pair (must preserve + continue)\n" >&2
    return 1
  fi

  # Preservation is unchanged: both files byte-identical.
  if [ "$(_sha "$crt")" != "$before_crt_sha" ] || [ "$(_sha "$key")" != "$before_key_sha" ]; then
    printf "    broken public-CA pair was modified — preservation behaviour must not change\n" >&2
    return 1
  fi

  # …but the mismatch must be surfaced as a WARNING mentioning re-issuance.
  if ! grep -qi 'mismatch\|do not match\|does not match' "$err_file"; then
    printf "    no pair-mismatch warning on stderr — a broken public-CA pair was reported as clean success\n" >&2
    return 1
  fi
  if ! grep -qi 're-issuance\|reissuance\|issuance' "$err_file"; then
    printf "    warning does not point the operator at re-issuance\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 8 (WARP-2132): self-signed cert with STALE IP SANs → re-issued with the
# SAME key and a SAN SUPERSET; .bootstrap deliberately refreshed
# =============================================================================
#
# The install-time cert freezes the secrets-time interface harvest into its IP
# SANs. A box that changes networks then serves IP SANs for addresses it no
# longer holds — browser warnings forever — and the old skip-guard (expiry +
# DNS SANs + pair match only) passed the stale cert on every setup re-run.
# The fix must re-issue REUSING the existing private key (pairings and
# key-pinned clients survive) with a SAN superset (old IP SANs retained +
# current added), and refresh the .bootstrap side-copy on THIS path only.
test_stale_ip_sans_reissued_same_key_superset() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  # Installed: valid, DNS-SAN-complete, matched pair — but its only interface
  # IP SAN is the OLD network's address.
  local old_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:10.0.0.99,IP:127.0.0.1"
  _make_self_signed "$crt" "$key" "$old_san" 3650
  # Production state: the bootstrap side-copy of that same pair exists.
  cp "$crt" "$crt.bootstrap"; cp "$key" "$key.bootstrap"

  local before_crt_sha before_key_sha before_pub
  before_crt_sha="$(_sha "$crt")"; before_key_sha="$(_sha "$key")"
  before_pub="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)"

  # The box now lives on a different network.
  if ! _run_generate_tls_cert "$sandbox" "192.168.77.5"; then
    printf "    _generate_tls_cert returned non-zero on a stale-IP self-signed cert\n" >&2
    return 1
  fi

  # Re-issued: bytes must have changed (the pre-fix skip-guard passed expiry +
  # DNS SANs only, so the stale cert survived every re-run byte-identical).
  if [ "$(_sha "$crt")" = "$before_crt_sha" ]; then
    printf "    stale-IP cert was NOT re-issued — the skip-guard passed a cert missing the box's current IPs\n" >&2
    return 1
  fi

  # KEY REUSE: same private key on disk, same public key in the new cert.
  if [ "$(_sha "$key")" != "$before_key_sha" ]; then
    printf "    droplet.key was replaced — the IP-stale path must REUSE the key (pairings/pinned clients)\n" >&2
    return 1
  fi
  local after_pub
  after_pub="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)"
  if [ -z "$after_pub" ] || [ "$after_pub" != "$before_pub" ]; then
    printf "    re-issued cert carries a DIFFERENT public key — must be -key reuse, never -newkey\n" >&2
    return 1
  fi

  # SAN SUPERSET: current IP added, OLD IP + loopback + DNS names retained.
  local san_text
  san_text="$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null)"
  local want
  for want in 'IP Address:192.168.77.5' 'IP Address:10.0.0.99' 'IP Address:127.0.0.1' 'DNS:droplet.lan' 'DNS:droplet-ai.local'; do
    if ! printf '%s' "$san_text" | grep -qF "$want"; then
      printf "    re-issued SAN is not a superset — missing %s\n    got: %s\n" "$want" "$san_text" >&2
      return 1
    fi
  done

  # BOOTSTRAP REFRESH (this path only): the side-copy must now be the widened
  # cert + the (unchanged) key, so the expired-restore path replays the widest
  # cert ever issued instead of resurrecting the stale-IP one.
  if [ "$(_sha "$crt.bootstrap")" != "$(_sha "$crt")" ]; then
    printf "    droplet.crt.bootstrap was not refreshed with the re-issued cert\n" >&2
    return 1
  fi
  if [ "$(_sha "$key.bootstrap")" != "$(_sha "$key")" ]; then
    printf "    droplet.key.bootstrap no longer matches the (unchanged) droplet.key\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 9 (WARP-2132): current IPs all covered → still skips (byte-identical)
# =============================================================================
test_covered_ips_still_skip() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  local full_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,IP:192.168.77.5,IP:127.0.0.1"
  _make_self_signed "$crt" "$key" "$full_san" 3650

  local before_crt_sha before_key_sha
  before_crt_sha="$(_sha "$crt")"; before_key_sha="$(_sha "$key")"

  if ! _run_generate_tls_cert "$sandbox" "192.168.77.5"; then
    printf "    _generate_tls_cert returned non-zero on a fully-covering cert\n" >&2
    return 1
  fi

  if [ "$(_sha "$crt")" != "$before_crt_sha" ] || [ "$(_sha "$key")" != "$before_key_sha" ]; then
    printf "    a cert already covering every current IP was regenerated — skip-guard must still skip\n" >&2
    return 1
  fi

  return 0
}

# =============================================================================
# Test 10 (WARP-2132 / ADR-023): public-CA leaf with stale/absent IP SANs →
# untouched even by the IP-coverage trigger
# =============================================================================
#
# A public-CA leaf carries no interface-IP SANs (the per-device FQDN is its
# access path), so the IP-coverage check would always read it as "stale". The
# exemption must fire BEFORE the IP check: setup never reshapes an HQ-issued
# fullchain. This leaf is minted DNS-SAN-complete with a matching key so it
# reaches the skip-guard branch (not the later preserve branch) — the exact
# spot the WARP-2132 trigger was added.
test_public_ca_leaf_ip_stale_untouched() {
  local sandbox certs crt key
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" RETURN
  certs="$sandbox/docker/certs"
  mkdir -p "$certs"
  crt="$certs/droplet.crt"; key="$certs/droplet.key"

  local full_dns_san="DNS:localhost,DNS:droplet,DNS:droplet.local,DNS:droplet.lan,DNS:droplet-ai,DNS:droplet-ai.local,DNS:droplet-ai.lan,DNS:d-deadbeef.devices.warp-lab.ai"
  _make_ca_signed_leaf "$sandbox" "$crt" "$key" 90 "$full_dns_san"

  local before_crt_sha before_key_sha
  before_crt_sha="$(_sha "$crt")"; before_key_sha="$(_sha "$key")"

  if ! _run_generate_tls_cert "$sandbox" "192.168.77.5"; then
    printf "    _generate_tls_cert returned non-zero on an IP-stale public-CA leaf\n" >&2
    return 1
  fi

  if [ "$(_sha "$crt")" != "$before_crt_sha" ] || [ "$(_sha "$key")" != "$before_key_sha" ]; then
    printf "    public-CA leaf was reshaped by the IP-coverage trigger — ADR-023 forbids touching it\n" >&2
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

_run_test "corrupt/unreadable droplet.crt is regenerated, not preserved" \
  test_corrupt_cert_is_regenerated_not_preserved

_run_test "mismatched cert/key pair + valid .bootstrap is restored (WARP-595)" \
  test_mismatched_pair_restores_bootstrap

_run_test "mismatched cert/key pair without bootstrap is regenerated as a matching pair (WARP-595)" \
  test_mismatched_pair_regenerates_without_bootstrap

_run_test "public-CA leaf with a mismatched key is preserved but WARNED (WARP-595)" \
  test_public_ca_broken_pair_preserved_but_warned

_run_test "stale-IP self-signed cert re-issued with the SAME key + SAN superset, bootstrap refreshed (WARP-2132)" \
  test_stale_ip_sans_reissued_same_key_superset

_run_test "cert already covering every current IP still skips, byte-identical (WARP-2132)" \
  test_covered_ips_still_skip

_run_test "public-CA leaf with stale/absent IP SANs stays untouched (WARP-2132 / ADR-023)" \
  test_public_ca_leaf_ip_stale_untouched

printf "\n  ──────────────────────────────────\n"
printf "  Results: %d/%d passed" "$PASSED" "$TOTAL"
if [ "$FAILED" -gt 0 ]; then
  printf "  ${_RED}(%d failed)${_RESET}\n" "$FAILED"
  printf "  Failed: %s\n" "${FAILED_NAMES[*]}"
  exit 1
fi
printf "  ${_GREEN}(all passed)${_RESET}\n"
exit 0
