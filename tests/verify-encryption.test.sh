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
          rest.mount-coverage rest.docker.store-root rest.usb-luks \
          transit.pg.plaintext-rejected transit.pg.tls13 transit.pg.scram \
          transit.redis.plaintext-refused transit.redis.tls \
          transit.mqtt.plaintext-closed transit.mqtt.mtls-required \
          transit.mesh.plain-http-refused transit.edge.tls-policy \
          transit.pcap.canary; do
  grep -q "$id" "$RUNNER" && pass "registry has $id" || fail "registry missing $id"
done
for t in WARP-232 WARP-233 WARP-234 WARP-235 WARP-236 WARP-2102; do
  grep -q "$t" "$RUNNER" && pass "registry maps to $t" || fail "no check maps to $t"
done

# WARP-2102: the store-root probe must resolve the RUNNING daemon's store via
# /proc/<pid>/fd (pidof + readlink) — never by rendering configuration, which
# says nothing about what the live daemon actually loaded.
grep -q 'VFY_PROC_ROOT' "$RUNNER" && grep -q 'pidof' "$RUNNER" \
  && pass "store-root probe resolves the RUNNING daemon via /proc/<pid>/fd" \
  || fail "store-root probe does not use the /proc fd mechanism (WARP-2102)"

# WARP-1062 (audit item A): the default mesh targets must be the hops WARP-236
# mTLS actually protects — never the by-design-plain mcp-server:9090 /
# web-dashboard:3001 (listing those made the check FAIL forever).
grep -q 'DROPLET_VFY_MESH_TARGETS:-orchestrator:3000 ai-gateway:8000' "$RUNNER" \
  && pass "mesh default targets orchestrator:3000 + ai-gateway:8000" \
  || fail "mesh default targets wrong hops"
grep -E 'DROPLET_VFY_MESH_TARGETS:-[^}]*(mcp-server|web-dashboard)' "$RUNNER" >/dev/null \
  && fail "mesh default still lists a by-design-plain target" \
  || pass "mesh default omits by-design-plain mcp-server/web-dashboard"
# WARP-1062 (audit item A): data-path defaults are the WARP-232 canonical
# surfaces (docs/security/at-rest-encryption.md), not the pre-232 layout.
grep -q 'DROPLET_VFY_DATA_PATHS:-/data/droplet/env/.env /data/droplet/secrets /data/docker' "$RUNNER" \
  && pass "data-path defaults are the WARP-232 surfaces" \
  || fail "data-path defaults are stale (want /data/droplet/env/.env /data/droplet/secrets /data/docker)"

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
# Newest bundle by basename (bundles are named by sortable UTC timestamp, with a
# -NN suffix on same-second collisions). Deterministic regardless of mtime — the
# same rule the runner's own prev-manifest walk uses.
newest_bundle() { for d in "$WORK/out"/*/; do printf '%s\n' "${d%/}"; done | LC_ALL=C sort | tail -1; }

rm -rf "$WORK/bin" "$WORK/out" "$WORK/repo"; mkdir -p "$WORK/bin" "$WORK/repo/data"
printf 'POSTGRES_PASSWORD=pgsecret\nREDIS_PASSWORD=redissecret\nMQTT_PASSWORD=mqttsecret\n' > "$WORK/repo/.env"
# Empty world: every binary "missing" (not on the stub PATH) except coreutils.
# docker + tcpdump are forced-absent via VFY_ASSUME_MISSING because CI runners
# ship them in /usr/bin, which the stub PATH cannot hide (the at-rest tools are
# left to natural availability so mount-coverage still records its posture FAIL).
set +e; run_vfy VFY_ASSUME_MISSING="docker tcpdump" > "$WORK/run1.log" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && pass "empty world exits 1 (posture FAILs present, no crash)" \
  || fail "empty world rc=$rc (want 1); log: $(tail -3 "$WORK/run1.log")"
bundle="$(newest_bundle)"
[ -f "$bundle/report.json" ] && pass "bundle produced even in empty world" || fail "no report.json"
"$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))
ids = {c["id"] for c in r["checks"]}
want = {"rest.luks.device","rest.luks.header","rest.luks.tpm-token","rest.entropy",
        "rest.mount-coverage","rest.docker.store-root","rest.usb-luks",
        "transit.pg.plaintext-rejected",
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
# docker missing → the WARP-2102 store-root probe is a reasoned SKIP too
assert by["rest.docker.store-root"]["status"] == "SKIP"
assert "docker" in by["rest.docker.store-root"]["detail"]
# no LUKS world → rest checks are posture FAILs (plaintext at rest is a finding)
assert by["rest.mount-coverage"]["status"] == "FAIL"
assert r["signing"]["status"] == "skipped"
' "$bundle/report.json" && pass "status contract: all 17 checks, enum-only, SKIP has reason" \
  || fail "status contract violated"
[ -f "$bundle/manifest.sha256" ] && pass "manifest written" || fail "manifest missing"
grep -q 'report.json' "$bundle/manifest.sha256" && pass "manifest covers report.json" \
  || fail "manifest misses report.json"

# --checks subset + --list
set +e; run_vfy DROPLET_VFY_CHECKS="transit.edge.tls-policy" > "$WORK/run2.log" 2>&1; rc=$?; set -e
b2="$(newest_bundle)"
n="$("$PYBIN" -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["checks"]))' "$b2/report.json")"
[ "$n" = "1" ] && pass "DROPLET_VFY_CHECKS subsets the registry" || fail "subset ran $n checks"
PATH="$WORK/bin:/usr/bin:/bin" bash "$RUNNER" --list | grep -q 'transit.pcap.canary|transit|WARP-966' \
  && pass "--list prints the registry" || fail "--list broken"

# chain: the next full run records the immediately-preceding bundle's manifest
# hash. Bundles are named by sortable UTC timestamp (with a -NN suffix when two
# land in the same second), so "newest" == last by basename sort — the same
# rule the runner uses, and deterministic regardless of same-second mtimes.
b_prev="$(newest_bundle)"
prev="$( { shasum -a 256 "$b_prev/manifest.sha256" 2>/dev/null || sha256sum "$b_prev/manifest.sha256"; } | awk '{print $1}')"
set +e; run_vfy > /dev/null 2>&1; set -e
b3="$(newest_bundle)"
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
# pidof: no dockerd "running" in this world — the WARP-2102 store-root probe
# must SKIP deterministically (a real dockerd on the CI host must not leak in).
mk_stub pidof 1 /dev/null
mkdir -p "$WORK/tpm"; printf 'FAKE-CERT\n' > "$WORK/tpm/device-id-cert.pem"

set +e
run_vfy DROPLET_VFY_TPM_DIR="$WORK/tpm" DROPLET_VFY_RAW_DEVICE=/dev/nvme0n1p3 \
  > "$WORK/run3.log" 2>&1
rc=$?
set -e
b="$(newest_bundle)"
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
# WARP-1062 (audit item A): the mesh probe must hit the mTLS-protected hops.
grep -q 'http://orchestrator:3000/' "$WORK/stub-calls.log" \
  && pass "mesh probe fetches orchestrator:3000" || fail "mesh probe never hit orchestrator:3000"
grep -qE 'mcp-server:9090|web-dashboard:3001' "$WORK/stub-calls.log" \
  && fail "mesh probe still hits a by-design-plain target" \
  || pass "mesh probe skips by-design-plain targets"
{ grep -q -- '-starttls postgres' "$WORK/stub-calls.log" || grep -q 's_client' "$WORK/stub-calls.log"; } \
  && pass "pg TLS probe uses openssl s_client" || fail "no s_client call recorded"
# Evidence files must exist and be hashed into the report
"$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))
c = [x for x in r["checks"] if x["id"]=="transit.pg.plaintext-rejected"][0]
assert c["evidence_sha256"], c
' "$b/report.json" && pass "evidence hashes embedded per check" || fail "evidence_sha256 missing"

echo ""; echo "--- Runner: stopped stack reads SKIP, never PASS (WARP-1062) ---"
# docker exists, but `compose ps --status running -q` returns nothing and every
# exec fails the way compose does against a stopped service. Before the
# running-container guards these probes read GREEN — exec rc!=0 looked exactly
# like "plaintext refused".
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
echo "docker \$*" >> "$WORK/stub-calls.log"
case "\$*" in
  *" ps --status running -q "*) exit 0;;   # no output = nothing running
  *"exec"*) echo "service is not running" >&2; exit 1;;
  *"network inspect"*) echo "cafe12345678"; exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$WORK/bin/docker"
STOPPED_CHECKS="transit.pg.plaintext-rejected,transit.pg.tls13,transit.pg.scram"
STOPPED_CHECKS="$STOPPED_CHECKS,transit.redis.plaintext-refused,transit.redis.tls"
STOPPED_CHECKS="$STOPPED_CHECKS,transit.mqtt.plaintext-closed,transit.mqtt.mtls-required"
STOPPED_CHECKS="$STOPPED_CHECKS,transit.mesh.plain-http-refused"
set +e; run_vfy DROPLET_VFY_CHECKS="$STOPPED_CHECKS" > "$WORK/run4.log" 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && pass "stopped stack exits 0 (SKIPs, no FAIL)" \
  || fail "stopped stack rc=$rc (want 0); log: $(tail -3 "$WORK/run4.log")"
b4="$(newest_bundle)"
"$PYBIN" - "$b4/report.json" <<'PYEOF'
import json, sys
r = json.load(open(sys.argv[1]))
bad = {c["id"]: (c["status"], c.get("detail", "")) for c in r["checks"]
       if not (c["status"] == "SKIP" and "container-not-running" in c.get("detail", ""))}
assert not bad, bad
assert len(r["checks"]) == 8, [c["id"] for c in r["checks"]]
PYEOF
[ $? -eq 0 ] && pass "all 8 exec probes SKIP with container-not-running reason" \
  || fail "stopped stack did not SKIP every exec probe (see $b4/report.json)"

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
b="$(newest_bundle)"
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

echo ""; echo "--- Runner: WARP-2102 docker image-store root (containerd store vs data-root) ---"
# Docker >= 28's containerd image store roots at /var/lib/containerd and
# IGNORES daemon.json data-root — the probe must read the RUNNING daemons'
# /proc/<pid>/fd bolt-db handles (never a config render) and FAIL when the
# active image store lives off the encrypted mount.
rm -rf "$WORK/bin" "$WORK/out"; mkdir -p "$WORK/bin"
# pidof stub: dockerd + containerd "running" with fixture pids.
cat > "$WORK/bin/pidof" <<'EOF'
#!/bin/sh
case "$1" in dockerd) echo 4242;; containerd) echo 4300;; *) exit 1;; esac
EOF
chmod +x "$WORK/bin/pidof"
# docker stub: `docker info` replays the running daemon's storage report.
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
case "\$*" in
  info*) cat "$WORK/docker-info.txt"; exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$WORK/bin/docker"
# /proc fixture: fd symlinks to the bolt DBs each daemon holds open. dockerd's
# data-root DBs sit on the (fixture) /data; containerd's meta.db sits on the
# (fixture) plain root LV — exactly the shipped-box layout.
mkdir -p "$WORK/proc/4242/fd" "$WORK/proc/4300/fd" \
         "$WORK/data/docker/buildkit" "$WORK/data/docker/volumes" \
         "$WORK/rootlv/var/lib/containerd/io.containerd.metadata.v1.bolt"
: > "$WORK/data/docker/buildkit/cache.db"
: > "$WORK/data/docker/volumes/metadata.db"
: > "$WORK/rootlv/var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db"
ln -s "$WORK/data/docker/buildkit/cache.db"   "$WORK/proc/4242/fd/7"
ln -s "$WORK/data/docker/volumes/metadata.db" "$WORK/proc/4242/fd/12"
ln -s "$WORK/rootlv/var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db" "$WORK/proc/4300/fd/9"

store_run() {  # docker-info fixture already staged; run just the store-root check
  run_vfy DROPLET_VFY_CHECKS=rest.docker.store-root \
    DROPLET_VFY_PROC_ROOT="$WORK/proc" DROPLET_VFY_DATA_MOUNT="$WORK/data" "$@"
}
store_status() {  # STATUS + DETAIL of the single check in the newest bundle
  # Prints NONE|check-never-ran when the registry has no such check (so a
  # pre-fix runner reads as a counted failure, not a suite crash).
  "$PYBIN" -c '
import json,sys
r = json.load(open(sys.argv[1]))["checks"]
print((r[0]["status"] + "|" + r[0].get("detail","")) if r else "NONE|check-never-ran")
' "$(newest_bundle)/report.json"
}

# World A — classic store (snapshotter off): data-root DBs on /data → PASS,
# and containerd's meta.db on the plain root must NOT false-positive (it holds
# runtime metadata only in this mode).
printf 'Storage Driver: overlay2\n Backing Filesystem: extfs\n' > "$WORK/docker-info.txt"
set +e; store_run > "$WORK/run-storeA.log" 2>&1; rc=$?; set -e
v="$(store_status)"
[ "$rc" -eq 0 ] && pass "classic store on /data exits 0" || fail "classic-store world rc=$rc (want 0)"
case "$v" in
  PASS\|classic-store-data-root-under-*) pass "classic store on /data → PASS (containerd meta.db off-/data tolerated)";;
  *) fail "classic-store world verdict wrong: $v";;
esac

# World B — the WARP-2102 defect: containerd store ACTIVE, meta.db on the
# plain root LV. daemon.json may swear data-root=/data/docker; the probe must
# FAIL from the live fd evidence.
printf 'Storage Driver: overlayfs\n driver-type: io.containerd.snapshotter.v1\n' > "$WORK/docker-info.txt"
set +e; store_run > "$WORK/run-storeB.log" 2>&1; rc=$?; set -e
v="$(store_status)"
[ "$rc" -eq 1 ] && pass "containerd store off /data exits 1 (release blocker)" \
  || fail "defect world rc=$rc (want 1)"
case "$v" in
  FAIL\|containerd-image-store-off-*WARP-2102*) pass "containerd store off /data → FAIL naming the store + ticket";;
  *) fail "defect world verdict wrong: $v";;
esac

# World B2 — containerd store active but rooted UNDER /data: the probe keys on
# the resolved location, not merely on the mode → PASS.
mkdir -p "$WORK/data/containerd/io.containerd.metadata.v1.bolt"
: > "$WORK/data/containerd/io.containerd.metadata.v1.bolt/meta.db"
rm -f "$WORK/proc/4300/fd/9"
ln -s "$WORK/data/containerd/io.containerd.metadata.v1.bolt/meta.db" "$WORK/proc/4300/fd/9"
set +e; store_run > "$WORK/run-storeB2.log" 2>&1; rc=$?; set -e
v="$(store_status)"
[ "$rc" -eq 0 ] && case "$v" in PASS\|containerd-image-store-under-*) true;; *) false;; esac \
  && pass "containerd store under /data → PASS (location-keyed, not mode-keyed)" \
  || fail "relocated-containerd world wrong: rc=$rc verdict=$v"

# World C — dockerd not running: reasoned SKIP, never a guess.
cat > "$WORK/bin/pidof" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$WORK/bin/pidof"
set +e; store_run > "$WORK/run-storeC.log" 2>&1; rc=$?; set -e
v="$(store_status)"
[ "$rc" -eq 0 ] && case "$v" in SKIP\|dockerd-not-running*) true;; *) false;; esac \
  && pass "dockerd down → SKIP dockerd-not-running (status contract)" \
  || fail "docker-down world wrong: rc=$rc verdict=$v"

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
