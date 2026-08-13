#!/usr/bin/env bash
# =============================================================================
# WARP-1973 — docker/nextcloud-init.sh :: the two reconciles that keep in-browser
# Office editing working after the box's address, name or engine changes.
# =============================================================================
#
# WARP-1966 fixed the two defects that blocked the editor on the day. This file
# guards the three reasons it would come back:
#
#   1. `overwriteprotocol` is the SECOND key caught by the trap WARP-1688 fixed
#      for trusted_domains — compose sets OVERWRITEPROTOCOL=https but the stock
#      image consumes it only on the install boot, so an already-installed box
#      freezes with it EMPTY (measured on the live box). Nextcloud then builds
#      absolute redirects from the request and emits `Location: http://…` to a
#      browser sitting on https; that is blocked as mixed content inside the
#      editor iframe, and the user sees a spinner that never resolves.
#
#   2. `overwritehost` must NEVER be set by us. isTrustedDomain() returns TRUE
#      UNCONDITIONALLY while it is non-empty, so setting it silently turns the
#      trusted-domains allowlist into accept-anything. It is the neighbouring
#      knob to the one we DO set, which is exactly why it needs a guard and not
#      just a comment.
#
#   3. The DOCS_ENGINE choice must be EXCLUSIVE. The hook configured the
#      selected connector but never disabled the other, and the live box ran
#      richdocuments AND onlyoffice at once — both registering preview
#      providers for the same Office MIME types, the loser failing with
#      `cURL error 7: Failed to connect to docserver port 80`.
#
# Same approach as nextcloud-trusted-domains.test.sh: the reconciles are
# self-contained POSIX functions delimited by sentinel markers, so we extract
# them and run them against a scriptable stub `occ_www`. No Docker, no
# Nextcloud.
#
# Runtime: < 5 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$REPO_ROOT_REAL/docker/nextcloud-init.sh"
COMPOSE_FILE="$REPO_ROOT_REAL/docker/docker-compose.yml"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ======================================================="
echo "  WARP-1973 — docs config converges (protocol / host / engine)"
echo "  ======================================================="
echo ""

if [ -f "$HOOK" ]; then
  pass "docker/nextcloud-init.sh exists"
else
  fail "docker/nextcloud-init.sh missing at $HOOK"; echo "FAILURES=$FAILURES"; exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# extract_fn <start-mark> <end-mark> <outfile>
extract_fn() {
  local s e
  s=$(grep -nF "$1" "$HOOK" | head -1 | cut -d: -f1)
  e=$(grep -nF "$2" "$HOOK" | head -1 | cut -d: -f1)
  if [ -n "$s" ] && [ -n "$e" ]; then
    sed -n "${s},${e}p" "$HOOK" > "$3"
    return 0
  fi
  return 1
}

echo "--- Phase 1: wiring (sentinels + top-level invocation) ---"

if extract_fn "# >>> reconcile_overwrite_protocol (WARP-1973)" \
              "# <<< reconcile_overwrite_protocol (WARP-1973)" "$WORK/op.sh"; then
  pass "reconcile_overwrite_protocol is delimited by sentinel markers"
else
  fail "reconcile_overwrite_protocol sentinel markers missing"; echo "FAILURES=$FAILURES"; exit 1
fi

if extract_fn "# >>> disable_other_connector (WARP-1973)" \
              "# <<< disable_other_connector (WARP-1973)" "$WORK/doc.sh"; then
  pass "disable_other_connector is delimited by sentinel markers"
else
  fail "disable_other_connector sentinel markers missing"; echo "FAILURES=$FAILURES"; exit 1
fi

# A defined-but-never-called reconcile converges nothing — the same failure the
# trusted_domains guard pins.
if grep -qE '^reconcile_overwrite_protocol[[:space:]]*$' "$HOOK"; then
  pass "reconcile_overwrite_protocol is invoked at top level (runs every boot)"
else
  fail "reconcile_overwrite_protocol is never invoked — the hook would define it and move on"
fi

# Exclusivity must be applied for BOTH engines, not just the default one.
for pair in "richdocuments:onlyoffice-engine" "onlyoffice:collabora-engine"; do
  other="${pair%%:*}"
  if grep -qE "^[[:space:]]*disable_other_connector ${other}[[:space:]]*$" "$HOOK"; then
    pass "the ${pair#*:} branch disables '${other}'"
  else
    fail "the ${pair#*:} branch never calls 'disable_other_connector ${other}' — both connectors stay enabled"
  fi
done

echo "--- Phase 2: overwriteprotocol behaviour against a stub occ ---"

cat > "$WORK/op-harness.sh" <<'HARNESS'
set -euo pipefail
STATE="${STUB_STATE:?}"

occ_www() {
  sub="${1:-}"; key="${2:-}"
  if [ "$sub" = "config:system:get" ]; then
    f="$STATE/get_$key"
    if [ -s "$f" ]; then cat "$f"; return 0; fi
    return 1   # occ exits NON-ZERO for an unset key (the WARP-1694 trap)
  fi
  if [ "$sub" = "config:system:set" ]; then
    val="${3:-}"; val="${val#--value=}"
    printf '%s %s\n' "$key" "$val" >> "$STATE/writes"
    [ "${STUB_SET_FAILS:-0}" = "1" ] && return 1
    printf '%s' "$val" > "$STATE/get_$key"
    return 0
  fi
  printf '%s %s\n' "$sub" "$key" >> "$STATE/other"
  return 0
}

# shellcheck disable=SC1090
. "$FUNC_FILE"
reconcile_overwrite_protocol
echo "HOOK_REACHED_END"
HARNESS

run_op() {
  rm -rf "$WORK/state"; mkdir -p "$WORK/state"
  : > "$WORK/state/writes"; : > "$WORK/state/other"
  [ -n "${CASE_STORED_PROTO:-}" ] && printf '%s' "$CASE_STORED_PROTO" > "$WORK/state/get_overwriteprotocol"
  [ -n "${CASE_STORED_HOST:-}" ] && printf '%s' "$CASE_STORED_HOST" > "$WORK/state/get_overwritehost"
  set +e
  STUB_STATE="$WORK/state" FUNC_FILE="$WORK/op.sh" \
  OVERWRITEPROTOCOL="${CASE_ENV_PROTO-https}" \
  STUB_SET_FAILS="${CASE_SET_FAILS:-0}" \
    bash "$WORK/op-harness.sh" > "$WORK/out" 2> "$WORK/err"
  LAST_RC=$?
  set -e
}

# (a) THE MEASURED LIVE STATE: key unset. occ exits non-zero on the read, which
#     must not abort the hook, and the value must be written.
CASE_STORED_PROTO="" CASE_STORED_HOST="" run_op
if grep -q "^overwriteprotocol https$" "$WORK/state/writes" 2>/dev/null; then
  pass "unset key (the live box's state): writes overwriteprotocol=https"
else
  fail "unset key: no write issued — writes=[$(tr '\n' '|' < "$WORK/state/writes")]"
fi
if grep -q HOOK_REACHED_END "$WORK/out"; then
  pass "unset key: the non-zero occ read does NOT abort the hook (errexit-safe)"
else
  fail "unset key: hook aborted (rc=$LAST_RC) — the '|| true' must be INSIDE the substitution"
fi

# (b) Converged box writes NOTHING. A reconcile that rewrites every boot is
#     noise in the log and churn in config.php.
CASE_STORED_PROTO="https" CASE_STORED_HOST="" run_op
if [ ! -s "$WORK/state/writes" ]; then
  pass "already-converged box: zero writes (idempotent)"
else
  fail "already-converged box wrote anyway: [$(tr '\n' '|' < "$WORK/state/writes")]"
fi

# (c) A box stuck on http converges to https.
CASE_STORED_PROTO="http" CASE_STORED_HOST="" run_op
if grep -q "^overwriteprotocol https$" "$WORK/state/writes" 2>/dev/null; then
  pass "box stuck on http: converges to https"
else
  fail "box stuck on http: no correcting write"
fi

# (d) A failed write is reported and NON-FATAL — the rest of the boot must run.
CASE_STORED_PROTO="" CASE_STORED_HOST="" CASE_SET_FAILS=1 run_op
if grep -q HOOK_REACHED_END "$WORK/out" && grep -qi "could not set overwriteprotocol" "$WORK/err"; then
  pass "failed write: reported on stderr and non-fatal"
else
  fail "failed write: rc=$LAST_RC out=[$(tr '\n' '|' < "$WORK/out")] err=[$(head -c 160 "$WORK/err")]"
fi

# (e) THE SECURITY GUARD. overwritehost non-empty makes isTrustedDomain() return
#     true for ANY Host. We must warn, and must never write the key ourselves.
CASE_STORED_PROTO="https" CASE_STORED_HOST="droplet.example" run_op
if grep -qi "overwritehost is set" "$WORK/err"; then
  pass "a pre-existing overwritehost is reported LOUDLY (the allowlist is inert while it is set)"
else
  fail "a pre-existing overwritehost passed silently — the trusted-domains allowlist is inert and nobody is told"
fi
if ! grep -q "^overwritehost " "$WORK/state/writes" 2>/dev/null; then
  pass "the reconcile never WRITES overwritehost (setting it would disable the allowlist)"
else
  fail "the reconcile wrote overwritehost — that turns the Host allowlist into accept-anything"
fi

# (f) An EMPTY env still converges to https, and never writes an empty value.
#     This differs from the blank-DROPLET_PUBLIC_FQDN case in the trusted-domains
#     reconcile, and deliberately: a blank FQDN has no correct value to infer,
#     whereas this appliance always terminates TLS at the gateway, so https is
#     the only right answer and a box whose env lost the variable should still
#     end up correct rather than unmanaged.
CASE_STORED_PROTO="" CASE_STORED_HOST="" CASE_ENV_PROTO="" run_op
if grep -q "^overwriteprotocol https$" "$WORK/state/writes" 2>/dev/null; then
  pass "empty OVERWRITEPROTOCOL: still converges to https (no unmanaged state)"
else
  fail "empty OVERWRITEPROTOCOL did not converge: [$(tr '\n' '|' < "$WORK/state/writes")]"
fi
if ! grep -qE "^overwriteprotocol[[:space:]]*$" "$WORK/state/writes" 2>/dev/null; then
  pass "empty OVERWRITEPROTOCOL: never writes an EMPTY value"
else
  fail "wrote an empty overwriteprotocol — worse than leaving it unset"
fi

echo "--- Phase 3: connector exclusivity against a stub occ ---"

cat > "$WORK/doc-harness.sh" <<'HARNESS'
set -euo pipefail
STATE="${STUB_STATE:?}"

occ_www() {
  sub="${1:-}"
  if [ "$sub" = "app:list" ]; then cat "$STATE/applist"; return 0; fi
  if [ "$sub" = "app:disable" ]; then
    printf '%s\n' "${2:-}" >> "$STATE/disabled"
    [ "${STUB_DISABLE_FAILS:-0}" = "1" ] && return 1
    return 0
  fi
  printf '%s\n' "$sub" >> "$STATE/other"
  return 0
}

# shellcheck disable=SC1090
. "$FUNC_FILE"
disable_other_connector "${TARGET:?}"
echo "HOOK_REACHED_END"
HARNESS

run_doc() {
  rm -rf "$WORK/state"; mkdir -p "$WORK/state"
  : > "$WORK/state/disabled"; : > "$WORK/state/other"
  printf '%s\n' "${CASE_APPLIST:-}" > "$WORK/state/applist"
  set +e
  STUB_STATE="$WORK/state" FUNC_FILE="$WORK/doc.sh" \
  TARGET="${CASE_TARGET:?}" STUB_DISABLE_FAILS="${CASE_DISABLE_FAILS:-0}" \
    bash "$WORK/doc-harness.sh" > "$WORK/out" 2> "$WORK/err"
  LAST_RC=$?
  set -e
}

# THE MEASURED LIVE STATE: both connectors enabled.
BOTH="Enabled:
  - richdocuments: 8.4.16
  - onlyoffice: 9.8.0
  - groupfolders: 16.0.5"

CASE_APPLIST="$BOTH" CASE_TARGET="onlyoffice" run_doc
if grep -qx "onlyoffice" "$WORK/state/disabled"; then
  pass "both enabled (the live box): the non-selected connector is disabled"
else
  fail "both enabled: onlyoffice was NOT disabled — two connectors race for the same Office MIME types"
fi

# Absent app: nothing to do, and no spurious disable call.
ONLY_RD="Enabled:
  - richdocuments: 8.4.16"
CASE_APPLIST="$ONLY_RD" CASE_TARGET="onlyoffice" run_doc
if [ ! -s "$WORK/state/disabled" ]; then
  pass "connector absent: no disable attempted (idempotent, quiet)"
else
  fail "connector absent: disabled anyway [$(tr '\n' '|' < "$WORK/state/disabled")]"
fi

# It must key on the app NAME, not a substring. `onlyoffice_extra` is not
# `onlyoffice`, and a loose grep would disable a bystander.
NEAR="Enabled:
  - richdocuments: 8.4.16
  - onlyoffice_extra: 1.0.0"
CASE_APPLIST="$NEAR" CASE_TARGET="onlyoffice" run_doc
if [ ! -s "$WORK/state/disabled" ]; then
  pass "a similarly-named app is not mistaken for the connector"
else
  fail "matched 'onlyoffice_extra' as 'onlyoffice' — the app match is a substring, not a name"
fi

# A failed disable is reported and non-fatal.
CASE_APPLIST="$BOTH" CASE_TARGET="onlyoffice" CASE_DISABLE_FAILS=1 run_doc
if grep -q HOOK_REACHED_END "$WORK/out" && grep -qi "could not disable" "$WORK/err"; then
  pass "failed disable: reported on stderr and non-fatal"
else
  fail "failed disable: rc=$LAST_RC err=[$(head -c 160 "$WORK/err")]"
fi

# Never uninstall — a switch back must not need appstore egress.
if ! grep -qE 'app:remove|app:uninstall' "$WORK/doc.sh"; then
  pass "the connector is DISABLED, never uninstalled (an engine switch back needs no egress)"
else
  fail "the reconcile uninstalls the connector — switching engines back would need appstore access"
fi

echo "--- Phase 4: compose covers all of RFC1918, and stays an allowlist ---"

TD_LINE="$(grep -E '^[[:space:]]*-[[:space:]]*NEXTCLOUD_TRUSTED_DOMAINS=' "$COMPOSE_FILE" | head -1)"

# 192.168/16, 10/8, and every /16 of 172.16/12. A box gets its LAN address from
# whatever router it is plugged into; any of these is a legitimate lease.
missing=""
for r in '192\.168\.\*' '10\.\*'; do
  printf '%s' "$TD_LINE" | grep -qE "(^|[[:space:]])$r([[:space:]]|\$)" || missing="$missing ${r//\\/}"
done
for i in $(seq 16 31); do
  printf '%s' "$TD_LINE" | grep -qE "(^|[[:space:]])172\.$i\.\*([[:space:]]|\$)" || missing="$missing 172.$i.*"
done
if [ -z "$missing" ]; then
  pass "all of RFC1918 is trusted (192.168/16, 10/8, and each /16 of 172.16/12)"
else
  fail "private ranges missing from trusted domains:$missing — a box leased one of those answers 400 on every Nextcloud leg"
fi

# The allowlist must stay an allowlist. `172.*` is called out by name because it
# is the tempting short spelling for the sixteen entries above and it reaches
# into PUBLIC space (172.32+ is routable).
for forbidden in '\*' '172\.\*' '0\.0\.0\.0'; do
  literal="$(printf '%s' "$forbidden" | tr -d '\\')"
  if printf '%s' "$TD_LINE" | grep -qE "(^|[[:space:]])$forbidden([[:space:]]|\$)"; then
    fail "trusted domains contain '$literal' — that reaches public address space and stops this being an allowlist"
  else
    pass "trusted domains do not contain '$literal'"
  fi
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
