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

echo ""; echo "--- Lib: reject/accept + TLS-protocol + pcap evaluators ---"
v="$(vfy_eval_expect_reject 2 "$FIX/psql-ssl-reject.txt" 'no pg_hba.conf entry.*(SSL off|no encryption)|server does not support SSL')"
[ "$v" = "PASS|rejected-as-required" ] && pass "expect_reject: pg_hba reject → PASS" || fail "expect_reject: $v"
v="$(vfy_eval_expect_reject 0 "$FIX/psql-ssl-accept.txt" 'no pg_hba.conf entry')"
[ "$v" = "FAIL|plaintext-accepted (probe exited 0)" ] && pass "expect_reject: accepted → FAIL" \
  || fail "expect_reject accepted: $v"
v="$(vfy_eval_expect_reject 2 "$FIX/redis-conn-refused.txt" 'no pg_hba')"
case "$v" in PASS\|rejected\ *) pass "expect_reject: refused for another reason → PASS(qualified)";;
  *) fail "expect_reject other-reason: $v";; esac

v="$(vfy_eval_tls_protocol "$FIX/sclient-tls13.txt" 'TLSv1\.3')"
[ "$v" = "PASS|protocol=TLSv1.3" ] && pass "tls_protocol: 1.3 → PASS" || fail "tls_protocol: $v"
v="$(vfy_eval_tls_protocol "$FIX/sclient-no-tls.txt" 'TLSv1\.[23]')"
case "$v" in FAIL\|no-tls-negotiated*) pass "tls_protocol: no TLS → FAIL";; *) fail "tls_protocol no-tls: $v";; esac

# pcap scan: binary file with/without patterns; names (not values) in verdict.
printf 'noise %s DROPLET-CANARY-ab12cd34 noise' "$(head -c 64 /dev/urandom | base64)" > "$WORK/dirty.pcap"
head -c 4096 /dev/urandom > "$WORK/clean.pcap"
printf 'canary\tDROPLET-CANARY-ab12cd34\nPOSTGRES_PASSWORD\tsupersecretpg\n' > "$WORK/patterns.tsv"
v="$(vfy_eval_pcap_patterns "$WORK/dirty.pcap" "$WORK/patterns.tsv")"
[ "$v" = "FAIL|canary:1" ] && pass "pcap: canary found → FAIL names-only" || fail "pcap dirty: $v"
case "$v" in *supersecretpg*) fail "pcap verdict leaks the secret VALUE";; *) pass "pcap verdict never contains values";; esac
v="$(vfy_eval_pcap_patterns "$WORK/clean.pcap" "$WORK/patterns.tsv")"
[ "$v" = "PASS|patterns=2 matches=0" ] && pass "pcap: clean → PASS" || fail "pcap clean: $v"

echo ""; echo "--- Runner: status contract + graceful degradation ---"
mk_stub() {  # NAME EXITCODE OUTPUT_FILE
  cat > "$WORK/bin/$1" <<EOF
#!/bin/sh
printf '%s ' "\$0 \$*" >> "$WORK/stub-calls.log"; echo >> "$WORK/stub-calls.log"
cat "$3" 2>/dev/null
exit $2
EOF
  chmod +x "$WORK/bin/$1"
}
run_vfy() {  # extra env via leading VAR=val words
  env PATH="$WORK/bin:/usr/bin:/bin" \
    DROPLET_VFY_OUTPUT_ROOT="$WORK/out" \
    DROPLET_VFY_REPO_ROOT="$WORK/repo" \
    DROPLET_VFY_DATA_PATHS="$WORK/repo/data" \
    DROPLET_VFY_USB_GLOB="$WORK/usb/*" \
    DROPLET_VFY_PCAP_SECONDS=1 \
    "$@" bash "$RUNNER"
}

rm -rf "$WORK/bin" "$WORK/out" "$WORK/repo"; mkdir -p "$WORK/bin" "$WORK/repo/data"
printf 'POSTGRES_PASSWORD=pgsecret\nREDIS_PASSWORD=redissecret\nMQTT_PASSWORD=mqttsecret\n' > "$WORK/repo/.env"
# Empty world: every binary "missing" (not on the stub PATH) except coreutils.
set +e; run_vfy > "$WORK/run1.log" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && pass "empty world exits 1 (posture FAILs present, no crash)" \
  || fail "empty world rc=$rc (want 1); log: $(tail -3 "$WORK/run1.log")"
bundle="$(ls -d "$WORK/out"/*/ | head -1)"
[ -f "$bundle/report.json" ] && pass "bundle produced even in empty world" || fail "no report.json"
"$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))
ids = {c["id"] for c in r["checks"]}
want = {"rest.luks.device","rest.luks.header","rest.luks.tpm-token","rest.entropy",
        "rest.mount-coverage","rest.usb-luks","transit.pg.plaintext-rejected",
        "transit.pg.tls13","transit.pg.scram","transit.redis.plaintext-refused",
        "transit.redis.tls","transit.mqtt.plaintext-closed","transit.mqtt.mtls-required",
        "transit.mesh.plain-http-refused","transit.edge.tls-policy","transit.pcap.canary"}
assert ids == want, ids ^ want
for c in r["checks"]:
    assert c["status"] in ("PASS","FAIL","SKIP"), c
    if c["status"] == "SKIP": assert c["detail"], "SKIP without reason: " + c["id"]
# docker missing → transit probes must be SKIP with a reason, not FAIL/crash
by = {c["id"]: c for c in r["checks"]}
assert by["transit.pg.plaintext-rejected"]["status"] == "SKIP"
assert "docker" in by["transit.pg.plaintext-rejected"]["detail"]
assert by["transit.pcap.canary"]["status"] == "SKIP"          # tcpdump missing
# no LUKS world → rest checks are posture FAILs (plaintext at rest is a finding)
assert by["rest.mount-coverage"]["status"] == "FAIL"
assert r["signing"]["status"] == "skipped"
' "$bundle/report.json" && pass "status contract: all 16 checks, enum-only, SKIP has reason" \
  || fail "status contract violated"
[ -f "$bundle/manifest.sha256" ] && pass "manifest written" || fail "manifest missing"
grep -q 'report.json' "$bundle/manifest.sha256" && pass "manifest covers report.json" \
  || fail "manifest misses report.json"

# --checks subset + --list
set +e; run_vfy DROPLET_VFY_CHECKS="transit.edge.tls-policy" > "$WORK/run2.log" 2>&1; rc=$?; set -e
b2="$(ls -dt "$WORK/out"/*/ | head -1)"
n="$("$PYBIN" -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["checks"]))' "$b2/report.json")"
[ "$n" = "1" ] && pass "DROPLET_VFY_CHECKS subsets the registry" || fail "subset ran $n checks"
PATH="$WORK/bin:/usr/bin:/bin" bash "$RUNNER" --list | grep -q 'transit.pcap.canary|transit|WARP-966' \
  && pass "--list prints the registry" || fail "--list broken"

# chain: second full run records the first run's manifest hash
prev="$( { shasum -a 256 "$bundle/manifest.sha256" 2>/dev/null || sha256sum "$bundle/manifest.sha256"; } | awk '{print $1}')"
set +e; run_vfy > /dev/null 2>&1; set -e
b3="$(ls -dt "$WORK/out"/*/ | head -1)"
grep -q "\"prev_manifest_sha256\": \"$prev\"" "$b3/report.json" \
  && pass "runs hash-chain via prev_manifest_sha256" || fail "chain broken"

echo ""; echo "--- Runner: probes against a faked encrypted box ---"
rm -rf "$WORK/bin" "$WORK/out"; mkdir -p "$WORK/bin"
: > "$WORK/stub-calls.log"
# docker stub: routes on the exec target so each hop replays its fixture.
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
echo "docker \$*" >> "$WORK/stub-calls.log"
case "\$*" in
  *"exec -T db psql"*sslmode=disable*) cat "$FIX/psql-ssl-reject.txt" >&2; exit 2;;
  *"exec -T db psql"*password_encryption*) echo scram-sha-256; exit 0;;
  *"exec -T db sh -c"*s_client*) cat "$FIX/sclient-tls13.txt"; exit 0;;
  *"exec -T cache redis-cli"*--tls*) echo PONG; exit 0;;
  *"exec -T cache redis-cli"*) cat "$FIX/redis-conn-refused.txt" >&2; exit 1;;
  *"exec -T broker mosquitto_pub"*8883*) cat "$FIX/mosquitto-cert-required.txt" >&2; exit 1;;
  *"exec -T broker mosquitto_pub"*) echo "Error: Connection refused" >&2; exit 1;;
  *"exec -T orchestrator node"*) echo "TypeError: fetch failed" >&2; exit 1;;
  *"network inspect"*) echo "cafe12345678"; exit 0;;
  *"exec -i droplet-device-identity-svc python"*) echo "c2lnbmF0dXJlLWJ5dGVz"; exit 0;;
  *"compose"*"ps"*) echo "db running"; exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$WORK/bin/docker"
mk_stub cryptsetup 0 "$FIX/luksdump-luks2-tpm.txt"
printf '/dev/mapper/droplet-data\n' > "$WORK/findmnt.out"; mk_stub findmnt 0 "$WORK/findmnt.out"
cat > "$WORK/lsblk.json" <<'EOF'
{"blockdevices":[{"name":"droplet-data","type":"crypt","children":[{"name":"nvme0n1p3","type":"part"}]}]}
EOF
mk_stub lsblk 0 "$WORK/lsblk.json"
head -c 4194304 /dev/urandom > "$WORK/dd.out"; mk_stub dd 0 "$WORK/dd.out"
mk_stub tcpdump 0 /dev/null   # writes nothing; runner treats empty pcap as its own guard
mk_stub openssl 0 "$FIX/sclient-tls13.txt"
mkdir -p "$WORK/tpm"; printf 'FAKE-CERT\n' > "$WORK/tpm/device-id-cert.pem"

set +e
run_vfy DROPLET_VFY_TPM_DIR="$WORK/tpm" DROPLET_VFY_RAW_DEVICE=/dev/nvme0n1p3 \
  > "$WORK/run3.log" 2>&1
rc=$?
set -e
b="$(ls -dt "$WORK/out"/*/ | head -1)"
"$PYBIN" - "$b/report.json" <<'PYEOF'
import json, sys
by = {c["id"]: c for c in json.load(open(sys.argv[1]))["checks"]}
expect = {
  "rest.luks.header": "PASS", "rest.luks.tpm-token": "PASS", "rest.luks.device": "PASS",
  "rest.entropy": "PASS",
  "transit.pg.plaintext-rejected": "PASS", "transit.pg.tls13": "PASS",
  "transit.pg.scram": "PASS", "transit.redis.plaintext-refused": "PASS",
  "transit.redis.tls": "PASS", "transit.mqtt.plaintext-closed": "PASS",
  "transit.mqtt.mtls-required": "PASS", "transit.mesh.plain-http-refused": "PASS",
  "transit.edge.tls-policy": "PASS",
}
bad = {k: (by[k]["status"], by[k]["detail"]) for k, v in expect.items() if by[k]["status"] != v}
assert not bad, bad
assert by["transit.pg.plaintext-rejected"]["evidence"], "probe captured no evidence"
PYEOF
[ $? -eq 0 ] && pass "faked encrypted box → hop checks PASS with evidence" \
  || fail "posture world verdicts wrong (see $WORK/run3.log)"
grep -q 'sslmode=disable' "$WORK/stub-calls.log" && pass "pg probe really passes sslmode=disable" \
  || fail "pg probe never sent sslmode=disable"
{ grep -q -- '-starttls postgres' "$WORK/stub-calls.log" || grep -q 's_client' "$WORK/stub-calls.log"; } \
  && pass "pg TLS probe uses openssl s_client" || fail "no s_client call recorded"
# Evidence files must exist and be hashed into the report
"$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))
c = [x for x in r["checks"] if x["id"]=="transit.pg.plaintext-rejected"][0]
assert c["evidence_sha256"], c
' "$b/report.json" && pass "evidence hashes embedded per check" || fail "evidence_sha256 missing"

echo ""; echo "--- Signing + offline verification ---"
# Real-crypto round trip: generate a P-256 key, stub the signer container call
# to sign with it, then --verify-bundle must verify with the matching cert.
if ! command -v openssl >/dev/null 2>&1; then
  pass "openssl unavailable — signing round-trip skipped on this host"
else
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/id.key" 2>/dev/null
openssl req -new -x509 -key "$WORK/id.key" -subj "/CN=droplet-test" -days 1 \
  -out "$WORK/tpm/device-id-cert.pem" 2>/dev/null
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
case "\$*" in
  *"ps"*"--format"*) echo "droplet-device-identity-svc"; exit 0;;
  *"exec -i droplet-device-identity-svc python"*)
    # stdin = manifest bytes; sign exactly like the sidecar (ECDSA-SHA256, DER, b64)
    openssl dgst -sha256 -sign "$WORK/id.key" | base64 | tr -d '\n'; echo;;
  *"network inspect"*) echo "cafe12345678";;
  *) exit 1;;
esac
EOF
chmod +x "$WORK/bin/docker"
set +e; run_vfy DROPLET_VFY_TPM_DIR="$WORK/tpm" DROPLET_VFY_CHECKS="transit.edge.tls-policy" \
  > /dev/null 2>&1; set -e
b="$(ls -dt "$WORK/out"/*/ | head -1)"
[ -s "$b/manifest.sig" ] && pass "manifest.sig written" || fail "no signature"
grep -q '"status": "signed"' "$b/report.json" && pass "report records signing=signed" \
  || fail "signing status not recorded"
[ -f "$b/device-id-cert.pem" ] && pass "verifier cert copied into bundle" || fail "cert not bundled"
PATH="$WORK/bin:/usr/bin:/bin" bash "$RUNNER" --verify-bundle "$b" \
  && pass "--verify-bundle verifies an intact bundle" || fail "verify-bundle rejects intact bundle"
# Tamper → must fail
printf 'tampered' >> "$b/report.md"
PATH="$WORK/bin:/usr/bin:/bin" bash "$RUNNER" --verify-bundle "$b" > /dev/null 2>&1 \
  && fail "verify-bundle accepted a TAMPERED bundle" || pass "verify-bundle detects tampering"
fi

echo ""; echo "--- Docs + CI wiring ---"
RB="$REPO_ROOT/docs/security/encryption-verification.md"
[ -f "$RB" ] && pass "runbook exists" || fail "runbook missing"
for needle in 'droplet-verify-encryption.sh' 'WARP-957' 'release blocker' '--verify-bundle' 'tcpdump'; do
  grep -qi -e "$needle" "$RB" && pass "runbook covers: $needle" || fail "runbook misses: $needle"
done
[ -f "$REPO_ROOT/docs/security/evidence/README.md" ] && pass "evidence README exists" \
  || fail "evidence README missing"
grep -q 'test:verify-encryption' "$REPO_ROOT/package.json" \
  && pass "package.json test:verify-encryption wired" || fail "npm script missing"
WF="$REPO_ROOT/.github/workflows/verify-encryption-tests.yml"
[ -f "$WF" ] && pass "CI workflow exists" || fail "CI workflow missing"
grep -q 'tests/verify-encryption.test.sh' "$WF" && pass "CI runs this suite" || fail "CI wrong cmd"
grep -q 'scripts/host/droplet-verify-encryption' "$WF" && pass "CI path-filters on the harness" \
  || fail "CI paths wrong"
grep -q 'droplet-verify-encryption' "$REPO_ROOT/scripts/host/README.md" \
  && pass "scripts/host/README.md documents the harness" || fail "host README not updated"

echo ""
printf "  Results: %d/%d passed\n" "$((TESTS - FAILURES))" "$TESTS"
exit "$FAILURES"
