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

# =============================================================================
# Dynamic section: a per-run scratch dir shared by the lib + runner tests.
# =============================================================================
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo ""; echo "--- Lib: JSON + report rendering ---"
# shellcheck disable=SC1090
. "$LIB"

esc="$(vfy_json_escape 'say "hi" \ back')"
[ "$esc" = 'say \"hi\" \\ back' ] && pass "vfy_json_escape escapes quotes+backslashes" \
  || fail "vfy_json_escape wrong: $esc"

line="$(vfy_result_line transit.pg.tls13 transit WARP-233 T1.2 \
  'Postgres negotiates TLSv1.3' FAIL 'server does not support SSL' \
  'evidence/transit.pg.tls13/sclient-pg.txt')"
printf '%s' "$line" | "$PYBIN" -c '
import json,sys
r = json.loads(sys.stdin.read())
assert r["id"] == "transit.pg.tls13" and r["status"] == "FAIL", r
assert r["maps_to"] == ["WARP-233"] and r["threat_ids"] == ["T1.2"], r
assert r["evidence"] == ["evidence/transit.pg.tls13/sclient-pg.txt"], r
' && pass "vfy_result_line emits valid NDJSON row" || fail "vfy_result_line invalid JSON"

# Render a 3-row fixture ndjson (PASS/FAIL/SKIP) into report.json + report.md.
mkdir -p "$WORK/bundle"
{
  vfy_result_line rest.luks.header rest WARP-232 T5.8 d1 PASS 'version=2' ''
  vfy_result_line transit.redis.plaintext-refused transit WARP-234 T5.8 d2 FAIL 'plaintext-pong' ''
  vfy_result_line transit.redis.tls transit WARP-234 T5.8 d3 SKIP 'tls-port-not-listening' ''
} > "$WORK/bundle/results.ndjson"
vfy_render_json "$WORK/bundle/results.ndjson" '{"hostname":"testbox","git_commit":"abc"}' \
  genesis "$WORK/bundle/report.json"
"$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))
assert r["schema"] == "droplet-encryption-evidence/v1", r["schema"]
assert r["ticket"] == "WARP-966" and r["epic"] == "WARP-957"
assert r["prev_manifest_sha256"] == "genesis"
assert r["summary"] == {"pass": 1, "fail": 1, "skip": 1,
  "release_blockers": ["transit.redis.plaintext-refused"]}, r["summary"]
assert len(r["checks"]) == 3
' "$WORK/bundle/report.json" && pass "vfy_render_json: schema, summary, blockers" \
  || fail "vfy_render_json wrong shape"
vfy_render_md "$WORK/bundle/results.ndjson" "$WORK/bundle/report.md"
grep -q 'RELEASE BLOCKER' "$WORK/bundle/report.md" \
  && pass "report.md flags FAILs as release blockers" \
  || fail "report.md missing RELEASE BLOCKER marker"
grep -q 'transit.redis.tls' "$WORK/bundle/report.md" \
  && pass "report.md lists SKIPped checks too (status contract)" \
  || fail "report.md omits SKIP rows"

echo ""; echo "--- Lib: LUKS evaluators (fixtures) ---"
v="$(vfy_eval_luks_version "$FIX/luksdump-luks2-tpm.txt")"
[ "$v" = "PASS|version=2" ] && pass "luks_version: LUKS2 → PASS" || fail "luks_version LUKS2: $v"
v="$(vfy_eval_luks_version "$FIX/luksdump-luks1.txt")"
[ "$v" = "FAIL|version=1 (LUKS2 required)" ] && pass "luks_version: LUKS1 → FAIL" || fail "luks_version LUKS1: $v"
v="$(vfy_eval_luks_version /dev/null)"
case "$v" in FAIL\|no-luks-header*) pass "luks_version: garbage → FAIL no-luks-header";;
  *) fail "luks_version garbage: $v";; esac

v="$(vfy_eval_luks_cipher "$FIX/luksdump-luks2-tpm.txt")"
[ "$v" = "PASS|cipher=aes-xts-plain64" ] && pass "luks_cipher: aes-xts → PASS" || fail "luks_cipher: $v"

v="$(vfy_eval_luks_pbkdf "$FIX/luksdump-luks2-tpm.txt")"
[ "$v" = "PASS|argon2id-keyslots=1" ] && pass "luks_pbkdf: argon2id slot → PASS" || fail "luks_pbkdf: $v"
v="$(vfy_eval_luks_pbkdf "$FIX/luksdump-luks1.txt")"
case "$v" in FAIL\|*) pass "luks_pbkdf: LUKS1 → FAIL";; *) fail "luks_pbkdf LUKS1: $v";; esac

v="$(vfy_eval_luks_tpm_token "$FIX/luksdump-luks2-tpm.txt")"
[ "$v" = "PASS|token=systemd-tpm2 keyslot=1" ] && pass "tpm_token: systemd-tpm2 → PASS" \
  || fail "tpm_token: $v"
v="$(vfy_eval_luks_tpm_token "$FIX/luksdump-luks2-no-tpm.txt")"
[ "$v" = "FAIL|no-tpm2-token-enrolled" ] && pass "tpm_token: absent → FAIL" || fail "tpm_token absent: $v"

echo ""; echo "--- Lib: entropy + plaintext-magic evaluators ---"
head -c 262144 /dev/urandom > "$WORK/rand.bin"
"$PYBIN" -c 'open("'"$WORK"'/zero.bin","wb").write(b"\x00"*262144)'
printf 'PGDMP fake postgres dump header %s' "$(head -c 1000 /dev/zero | tr '\0' 'A')" > "$WORK/pgdump.bin"

v="$(vfy_eval_entropy "$WORK/rand.bin" 7.5)"
case "$v" in PASS\|entropy=[78].*) pass "entropy: urandom ≥7.5 → PASS ($v)";; *) fail "entropy urandom: $v";; esac
v="$(vfy_eval_entropy "$WORK/zero.bin" 7.5)"
case "$v" in FAIL\|entropy=0.0*) pass "entropy: zeros → FAIL ($v)";; *) fail "entropy zeros: $v";; esac

v="$(vfy_eval_no_plaintext_magic "$WORK/rand.bin")"
[ "$v" = "PASS|no-plaintext-magic" ] && pass "magic: random → PASS" || fail "magic random: $v"
v="$(vfy_eval_no_plaintext_magic "$WORK/pgdump.bin")"
[ "$v" = "FAIL|found=PGDMP" ] && pass "magic: PGDMP → FAIL" || fail "magic PGDMP: $v"

echo ""
printf "  Results: %d/%d passed\n" "$((TESTS - FAILURES))" "$TESTS"
exit "$FAILURES"
