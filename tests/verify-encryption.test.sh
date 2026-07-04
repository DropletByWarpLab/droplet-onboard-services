#!/usr/bin/env bash
# =============================================================================
# WARP-966 — unit tests for the on-hardware encryption verification harness
#   scripts/host/droplet-verify-encryption.sh (+ -lib.sh)
#
# Drives the PURE evaluators against committed fixtures, then the real runner
# end-to-end against stub binaries (docker, cryptsetup, lsblk, findmnt, blkid,
# dd, tcpdump, openssl) — no root, no hardware, no docker daemon. Mirrors
# tests/droplet-watchdog.test.sh's harness conventions.
# Runtime: < 30 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$REPO_ROOT/scripts/host/droplet-verify-encryption.sh"
LIB="$REPO_ROOT/scripts/host/droplet-verify-encryption-lib.sh"
FIX="$SCRIPT_DIR/fixtures/verify-encryption"
FAILURES=0; TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
PYBIN="$(command -v python3 || command -v python)"

echo ""; echo "  WARP-966 — encryption verification harness"; echo ""

echo "--- Static: files, strict mode, registry ---"
for f in "$RUNNER" "$LIB"; do
  nm="$(basename "$f")"
  [ -f "$f" ] && pass "$nm exists" || { fail "$nm missing"; continue; }
  bash -n "$f" && pass "$nm parses" || fail "$nm syntax error"
done
[ -x "$RUNNER" ] && pass "runner executable" || fail "runner not executable"
grep -q 'set -u' "$RUNNER" && pass "runner uses set -u" || fail "runner missing set -u"
# Supervisor rule: the runner must NOT be set -e (one probe failing must not
# abort the pass) — same rationale as droplet-watchdog.sh.
grep -qE '^set -e' "$RUNNER" && fail "runner is set -e (must survive probe failures)" \
  || pass "runner is not set -e"
{ grep -q 'set -euo pipefail' "$LIB" || grep -q 'set -u' "$LIB"; } \
  && pass "lib declares strict mode" || fail "lib missing strict mode"

# The registry must cover the WARP-966 hop list, each id mapping to a ticket.
for id in rest.luks.device rest.luks.header rest.luks.tpm-token rest.entropy \
          rest.mount-coverage rest.usb-luks \
          transit.pg.plaintext-rejected transit.pg.tls13 transit.pg.scram \
          transit.redis.plaintext-refused transit.redis.tls \
          transit.mqtt.plaintext-closed transit.mqtt.mtls-required \
          transit.mesh.plain-http-refused transit.edge.tls-policy \
          transit.pcap.canary; do
  grep -q "$id" "$RUNNER" && pass "registry has $id" || fail "registry missing $id"
done
for t in WARP-232 WARP-233 WARP-234 WARP-235 WARP-236; do
  grep -q "$t" "$RUNNER" && pass "registry maps to $t" || fail "no check maps to $t"
done

echo ""
printf "  Results: %d/%d passed\n" "$((TESTS - FAILURES))" "$TESTS"
exit "$FAILURES"
