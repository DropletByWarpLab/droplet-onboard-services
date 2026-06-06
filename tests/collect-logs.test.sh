#!/usr/bin/env bash
# =============================================================================
# WARP-823 — unit tests for scripts/host/droplet-collect-logs.sh.
#
# The collector is the host executor behind the device-bridge's auth-gated
# GET /logs/bundle. It captures a BOUNDED, secret-REDACTED slice of each
# Droplet service's logs (journald units + container logs) and prints a single
# JSON bundle on stdout. Redaction on the host is defense-in-depth; the
# orchestrator redacts again before zipping.
#
# These tests do NOT require Docker or journald. The script reads each service's
# raw log text from an injectable source: when DROPLET_LOGS_FIXTURE_DIR is set,
# it reads <dir>/<service>.log instead of shelling docker/journalctl. That lets
# us assert JSON validity, the redaction guarantee, window bounding, and the
# service filter — all hermetically.
#
# Runtime: < 5 seconds. Requires: bash, python3 (JSON validation only).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
COLLECT="$REPO_ROOT_REAL/scripts/host/droplet-collect-logs.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-823 — droplet-collect-logs.sh"
echo "  ================================================"
echo ""

if [ -f "$COLLECT" ]; then
  pass "collector script exists"
else
  fail "collector script missing at $COLLECT"
  echo "FAILURES=$FAILURES"; exit 1
fi

if [ -x "$COLLECT" ] || head -1 "$COLLECT" | grep -q '^#!'; then
  pass "collector has a shebang / is runnable"
else
  fail "collector is not runnable"
fi

# --- Fixture set-up ----------------------------------------------------------
FIXDIR="$(mktemp -d)"
OUTDIR="$(mktemp -d)"
trap 'rm -rf "$FIXDIR" "$OUTDIR"' EXIT

# Plant secrets across two services. Every one of these MUST be gone from the
# emitted bundle.
cat > "$FIXDIR/orchestrator.log" <<'EOF'
2026-06-06T10:00:00Z orchestrator listening on :3000
GET /api/llm/models 200 4ms
Authorization: Bearer eyJplantedjwt.aaaa.bbbb
boot env JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef
DATABASE_URL=postgresql://droplet:pgpass-supersecret@db:5432/droplet
EOF

cat > "$FIXDIR/ai-gateway.log" <<'EOF'
ai-gateway up
connecting with password=Sup3rSecretValue!
-----BEGIN PRIVATE KEY-----
MIIEPLANTEDprivatekeymaterialmustnotleak0000000000
-----END PRIVATE KEY-----
EOF

run_collect() {
  DROPLET_LOGS_FIXTURE_DIR="$FIXDIR" \
  DROPLET_LOGS_SERVICES="orchestrator ai-gateway" \
    bash "$COLLECT" "$@"
}

# --- Phase 1: emits valid JSON ----------------------------------------------
echo ""
echo "--- Phase 1: valid JSON bundle ---"
if OUT="$(run_collect 24 "" 2>/dev/null)" && echo "$OUT" | python3 -c 'import sys,json; json.load(sys.stdin)'; then
  pass "emits parseable JSON"
else
  fail "output was not valid JSON"
fi

# Capture once for the content assertions.
OUT="$(run_collect 24 "" 2>/dev/null || true)"

if echo "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert isinstance(d.get("services"),list) and len(d["services"])==2' 2>/dev/null; then
  pass "bundle has both services"
else
  fail "bundle missing services array / wrong count"
fi

# --- Phase 2: redaction (the security AC at the host boundary) ---------------
echo ""
echo "--- Phase 2: secret redaction ---"
assert_absent() {
  if echo "$OUT" | grep -qF "$1"; then
    fail "LEAKED secret: $2"
  else
    pass "redacted: $2"
  fi
}
assert_absent "eyJplantedjwt.aaaa.bbbb"                              "Bearer token"
assert_absent "0123456789abcdef0123456789abcdef0123456789abcdef"    "JWT_SECRET value"
assert_absent "pgpass-supersecret"                                  "DB URL password"
assert_absent "Sup3rSecretValue!"                                   "password= value"
assert_absent "MIIEPLANTEDprivatekeymaterialmustnotleak0000000000"  "PEM key body"

if echo "$OUT" | grep -qF "[REDACTED]"; then
  pass "redaction placeholder present"
else
  fail "no [REDACTED] placeholder in output"
fi

# Non-secret context survives so the bundle is still useful.
if echo "$OUT" | grep -qF "orchestrator listening on"; then
  pass "non-secret log context preserved"
else
  fail "non-secret context was lost"
fi

# --- Phase 3: service filter -------------------------------------------------
echo ""
echo "--- Phase 3: single-service filter ---"
OUT_ONE="$(run_collect 24 "orchestrator" 2>/dev/null || true)"
if echo "$OUT_ONE" | python3 -c 'import sys,json; d=json.load(sys.stdin); names=[s["name"] for s in d["services"]]; assert names==["orchestrator"], names' 2>/dev/null; then
  pass "service filter restricts to one service"
else
  fail "service filter did not restrict the bundle"
fi

# --- Phase 4: window bounding ------------------------------------------------
echo ""
echo "--- Phase 4: window is bounded ---"
# An absurd window must be clamped (<= 168h) — the JSON window_hours reflects
# the clamp, never the raw input.
OUT_BIG="$(run_collect 100000 "" 2>/dev/null || true)"
if echo "$OUT_BIG" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert int(d["window_hours"])<=168, d["window_hours"]' 2>/dev/null; then
  pass "oversized window clamped to <= 168h"
else
  fail "window was not clamped"
fi

# A non-numeric window falls back to the default rather than crashing.
if run_collect "abc" "" >/dev/null 2>&1; then
  pass "non-numeric window handled without error"
else
  fail "non-numeric window crashed the collector"
fi

echo ""
echo "  ------------------------------------------------"
printf "  %d test(s), %d failure(s)\n" "$TESTS" "$FAILURES"
echo "  ------------------------------------------------"
echo ""
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ]
