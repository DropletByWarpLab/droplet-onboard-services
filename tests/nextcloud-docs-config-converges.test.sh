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
mkdir -p "$WORK/ip-stub" "$WORK/ip-stub-junk"
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

echo "--- Phase 1b: every top-level call is DEFINED before it is made (WARP-1982) ---"

# A shell function must be defined before it is called. WARP-1979 invoked
# disable_hub_apps at line 452 and defined it at line 515: on every boot the
# hook hit `disable_hub_apps: command not found`, exited 127, and under
# `set -euo pipefail` took the whole before-starting hook down with it —
# connector wiring and shared-folder provisioning included.
#
# Nothing caught it. `bash -n` parses the file and is BLIND to call order.
# Every behavioural test here extracts one function and calls it directly, so
# the hook is never executed top-to-bottom. shellcheck does not flag it either.
# This is the guard for the class, not just the instance.
hook_body_no_comments="$(sed 's/#.*$//' "$HOOK")"
call_order_bad=""
while IFS= read -r fname; do
  [ -n "$fname" ] || continue
  def_line=$(printf '%s
' "$hook_body_no_comments" | grep -nE "^[[:space:]]*${fname}\(\)" | head -1 | cut -d: -f1)
  call_line=$(printf '%s
' "$hook_body_no_comments" | grep -nE "^${fname}[[:space:]]*$" | head -1 | cut -d: -f1)
  if [ -n "$def_line" ] && [ -n "$call_line" ] && [ "$call_line" -lt "$def_line" ]; then
    call_order_bad="$call_order_bad ${fname}(called@${call_line},defined@${def_line})"
  fi
done <<EOF
$(printf '%s
' "$hook_body_no_comments" | grep -oE '^[a-z_][a-z0-9_]*\(\)' | tr -d '()' | sort -u)
EOF

if [ -z "$call_order_bad" ]; then
  pass "no top-level invocation precedes its function definition"
else
  fail "function(s) CALLED BEFORE DEFINED:$call_order_bad — the hook exits 127 there and \`set -e\` aborts the whole boot hook. bash -n cannot see this."
fi

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
# WARP-1989: every fixture carries a Disabled: block, because a box that has
# run this hook even once has one — and `occ app:list` prints the SAME app
# names in both sections. A fixture without it cannot distinguish "matched in
# Enabled" from "matched anywhere", which is exactly the bug that shipped.
BOTH="Enabled:
  - richdocuments: 8.4.16
  - onlyoffice: 9.8.0
  - groupfolders: 16.0.5
Disabled:
  - encryption
  - user_ldap"

CASE_APPLIST="$BOTH" CASE_TARGET="onlyoffice" run_doc
if grep -qx "onlyoffice" "$WORK/state/disabled"; then
  pass "both enabled (the live box): the non-selected connector is disabled"
else
  fail "both enabled: onlyoffice was NOT disabled — two connectors race for the same Office MIME types"
fi

# Absent app: nothing to do, and no spurious disable call.
ONLY_RD="Enabled:
  - richdocuments: 8.4.16
Disabled:
  - onlyoffice: 9.8.0"
CASE_APPLIST="$ONLY_RD" CASE_TARGET="onlyoffice" run_doc
if [ ! -s "$WORK/state/disabled" ]; then
  pass "connector ALREADY DISABLED: no disable re-issued (idempotent, quiet)"
else
  fail "re-disabled a connector already in the Disabled block — the match is not scoped to Enabled:, so every boot re-issues app:disable and logs a state change that did not happen"
fi

# It must key on the app NAME, not a substring. `onlyoffice_extra` is not
# `onlyoffice`, and a loose grep would disable a bystander.
NEAR="Enabled:
  - richdocuments: 8.4.16
  - onlyoffice_extra: 1.0.0
Disabled:
  - encryption"
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

echo "--- Phase 3b: the Hub apps that inject into the editor iframe (WARP-1979) ---"

if extract_fn "# >>> disable_hub_apps (WARP-1979)"               "# <<< disable_hub_apps (WARP-1979)" "$WORK/hub.sh"; then
  pass "disable_hub_apps is delimited by sentinel markers"
else
  fail "disable_hub_apps sentinel markers missing"
fi

if grep -qE '^disable_hub_apps[[:space:]]*$' "$HOOK"; then
  pass "disable_hub_apps is invoked at top level (runs every boot)"
else
  fail "disable_hub_apps is never invoked — the Hub splash comes back on the next new user"
fi

cat > "$WORK/hub-harness.sh" <<'HARNESS'
set -euo pipefail
STATE="${STUB_STATE:?}"
occ_www() {
  sub="${1:-}"
  if [ "$sub" = "app:list" ]; then cat "$STATE/applist"; return 0; fi
  if [ "$sub" = "app:disable" ]; then
    printf '%s
' "${2:-}" >> "$STATE/disabled"
    [ "${STUB_DISABLE_FAILS:-0}" = "1" ] && return 1
    return 0
  fi
  printf '%s
' "$sub" >> "$STATE/other"
  return 0
}
# shellcheck disable=SC1090
. "$FUNC_FILE"
disable_hub_apps
echo "HOOK_REACHED_END"
HARNESS

run_hub() {
  rm -rf "$WORK/state"; mkdir -p "$WORK/state"
  : > "$WORK/state/disabled"; : > "$WORK/state/other"
  printf '%s
' "${CASE_APPLIST:-}" > "$WORK/state/applist"
  set +e
  STUB_STATE="$WORK/state" FUNC_FILE="$WORK/hub.sh"   STUB_DISABLE_FAILS="${CASE_DISABLE_FAILS:-0}"     bash "$WORK/hub-harness.sh" > "$WORK/out" 2> "$WORK/err"
  LAST_RC=$?
  set -e
}

# The live box's state before this landed.
STOCK="Enabled:
  - activity: 2.21.1
  - dashboard: 7.9.0
  - files: 2.1.1
  - firstrunwizard: 2.18.0
  - nextcloud_announcements: 1.18.0
  - recommendations: 2.1.0
  - richdocuments: 8.4.16
  - support: 1.12.0
  - survey_client: 1.17.0
  - updatenotification: 1.19.1
  - weather_status: 1.9.0
Disabled:
  - encryption"

CASE_APPLIST="$STOCK" run_hub

# firstrunwizard IS the reported bug: its whole job is the "Welcome to
# Nextcloud Hub" splash, and it loads inside the embedded editor page.
if grep -qx "firstrunwizard" "$WORK/state/disabled"; then
  pass "firstrunwizard is disabled (the 'Welcome to Nextcloud Hub' splash in the editor iframe)"
else
  fail "firstrunwizard NOT disabled — clicking Edit still shows the Hub splash to every new user"
fi

# These two phone home from an appliance whose whole thesis is that it does not.
for app in survey_client nextcloud_announcements; do
  if grep -qx "$app" "$WORK/state/disabled"; then
    pass "$app is disabled (it phones home to Nextcloud)"
  else
    fail "$app NOT disabled — it reports to Nextcloud's servers from an air-gapped-mentality appliance"
  fi
done

for app in updatenotification support weather_status recommendations; do
  if grep -qx "$app" "$WORK/state/disabled"; then
    pass "$app is disabled"
  else
    fail "$app NOT disabled — it injects into every Nextcloud-rendered page, editor included"
  fi
done

# Structural apps must survive. Disabling the default landing app or the
# activity backend is a different decision from cleaning up the editor iframe.
for keep in dashboard activity files richdocuments; do
  if grep -qx "$keep" "$WORK/state/disabled" 2>/dev/null; then
    fail "$keep was disabled — that is out of scope and breaks a surface nothing in the editor flow needed changed"
  else
    pass "$keep left enabled"
  fi
done

# Idempotence. occ prints these under "Disabled:" once they are off, so a match
# that is not scoped to the Enabled block retries the disable every boot.
ALREADY="Enabled:
  - files: 2.1.1
  - richdocuments: 8.4.16
Disabled:
  - firstrunwizard: 2.18.0
  - survey_client: 1.17.0
  - weather_status: 1.9.0"
CASE_APPLIST="$ALREADY" run_hub
if [ ! -s "$WORK/state/disabled" ]; then
  pass "already-disabled box: zero disable calls (scoped to the Enabled block)"
else
  fail "re-disabled apps already off: [$(tr '
' '|' < "$WORK/state/disabled")] — the match is not scoped to Enabled:"
fi

# Non-fatal: the boot hook must survive a failing disable.
CASE_APPLIST="$STOCK" CASE_DISABLE_FAILS=1 run_hub
if grep -q HOOK_REACHED_END "$WORK/out" && grep -qi "could not disable" "$WORK/err"; then
  pass "failed disable: reported on stderr and non-fatal"
else
  fail "failed disable aborted the hook (rc=$LAST_RC)"
fi

# Never remove — re-enabling must not need appstore egress.
if ! grep -qE 'app:remove|app:uninstall' "$WORK/hub.sh"; then
  pass "Hub apps are DISABLED, never uninstalled"
else
  fail "the hook uninstalls Hub apps — re-enabling one would need appstore access"
fi

echo "--- Phase 4: the trust list carries NO wildcard, and covers IPs exactly (WARP-1982) ---"

TD_LINE="$(grep -E '^[[:space:]]*-[[:space:]]*NEXTCLOUD_TRUSTED_DOMAINS=' "$COMPOSE_FILE" | head -1)"

# THE SECURITY INVARIANT. Nextcloud expands a `*` in a trusted-domain entry to
# [-\.a-zA-Z0-9]* — letters and dots included — so ANY wildcard admits
# attacker-controlled hostnames. Measured on a real box with the WARP-1973
# entries applied: `192.168.evil.com` and `10.evil.com` were both ACCEPTED.
# It is structural: no wildcard can express "IPv4 in this range only", and
# narrowing the prefix does not help (`192.168.5.*` matches `192.168.5.evil`).
#
# The predecessor of this check asserted the literal TOKENS (require 192.168.*,
# forbid 172.*) and so was satisfied by the very entries that opened the hole.
# It tested spelling, not matching semantics. This asserts the property.
if printf '%s' "$TD_LINE" | grep -q '\*'; then
  offenders="$(printf '%s' "$TD_LINE" | tr ' ' '
' | grep '\*' | grep -v '^\${' | tr '
' ' ')"
  fail "NEXTCLOUD_TRUSTED_DOMAINS contains wildcard entr(ies): ${offenders}— Nextcloud expands \`*\` to [-.a-zA-Z0-9]*, so '192.168.*' matches '192.168.evil.com' and the allowlist stops being one. Cover IPs with \$DROPLET_TRUSTED_LAN_IPS (exact tokens) instead."
else
  pass "no wildcard in NEXTCLOUD_TRUSTED_DOMAINS (a wildcard admits attacker hostnames)"
fi

# The replacement mechanism must actually be wired, or removing the wildcards
# silently drops IP coverage instead of fixing it.
if printf '%s' "$TD_LINE" | grep -q 'DROPLET_TRUSTED_LAN_IPS'; then
  pass "the trust list interpolates \$DROPLET_TRUSTED_LAN_IPS (exact box addresses)"
else
  fail "\$DROPLET_TRUSTED_LAN_IPS is not in the trust list — browsing the box BY IP answers 400 on every Nextcloud leg, editor included"
fi

# …and the deriver must exist and be invoked, or the variable is always empty.
SB="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
if grep -qE '^derive_single_box_lan_ips\(\)' "$SB"; then
  pass "derive_single_box_lan_ips() is defined"
else
  fail "derive_single_box_lan_ips() is missing — DROPLET_TRUSTED_LAN_IPS would interpolate to empty forever"
fi
if grep -qE 'upsert_env DROPLET_TRUSTED_LAN_IPS' "$SB"; then
  pass "DROPLET_TRUSTED_LAN_IPS is written to .env on every provision (survives a DHCP change)"
else
  fail "nothing ever writes DROPLET_TRUSTED_LAN_IPS — the deriver is dead code"
fi

# WARP-1989 — PRECONDITION, because everything below eval-extracts the deriver
# and asserts on its output. If the extraction comes back empty (function
# renamed, sentinel moved), `bash -c` runs nothing, the captured output is the
# empty string, and every "deriver excludes X" assertion passes — the empty
# string contains no X. The suite would report green against a function that no
# longer exists. Assert the extraction is non-empty FIRST.
_deriver_src="$(sed -n '/^derive_single_box_lan_ips()/,/^}/p' "$SB")"
if [ "$(printf '%s' "$_deriver_src" | grep -c .)" -ge 5 ]; then
  pass "extracted derive_single_box_lan_ips() ($(printf '%s' "$_deriver_src" | grep -c .) lines) — the asserts below are not vacuous"
else
  fail "could not extract derive_single_box_lan_ips() from $SB — every deriver assertion below would pass vacuously against empty output"
fi

# Behavioural: run the real deriver against a stubbed `ip` and check what it emits.
cat > "$WORK/ip-stub/ip" <<'STUB'
#!/usr/bin/env bash
cat <<'OUT'
1: lo    inet 127.0.0.1/8 scope host lo
2: eth0    inet 192.168.9.250/24 scope global eth0
3: eth0    inet 192.168.9.195/24 scope global secondary eth0
4: wlan0    inet 192.168.1.221/24 scope global wlan0
5: br0    inet 172.18.0.1/16 scope global br0
6: veth1    inet 169.254.5.5/16 scope global veth1
OUT
STUB
chmod +x "$WORK/ip-stub/ip"
got="$(PATH="$WORK/ip-stub:$PATH" bash -c "
  $(sed -n '/^derive_single_box_lan_ips()/,/^}/p' "$SB")
  derive_single_box_lan_ips
" 2>/dev/null)"
case " $got " in
  *" 192.168.9.250 "*) pass "deriver emits the box's real LAN address" ;;
  *) fail "deriver dropped the real LAN address — got '[$got]'" ;;
esac
# Shape guard, tested by BEHAVIOUR rather than by grepping for the regex text:
# feed the deriver output that is not a dotted quad and require it to drop it.
# Anything it emits lands verbatim in a security list.
cat > "$WORK/ip-stub-junk/ip" <<'STUB'
#!/usr/bin/env bash
cat <<'OUT'
1: eth0    inet 192.168.9.250/24 scope global eth0
2: eth0    inet not-an-ip/24 scope global eth0
3: eth0    inet 999.999.999.999abc/24 scope global eth0
4: eth0    inet ; rm -rf //24 scope global eth0
OUT
STUB
chmod +x "$WORK/ip-stub-junk/ip"
junk="$(PATH="$WORK/ip-stub-junk:$PATH" bash -c "
  $(sed -n '/^derive_single_box_lan_ips()/,/^}/p' "$SB")
  derive_single_box_lan_ips
" 2>/dev/null)"
bad_tokens=""
for tok in $junk; do
  case "$tok" in
    *[!0-9.]*) bad_tokens="$bad_tokens $tok" ;;
  esac
done
if [ -z "$bad_tokens" ]; then
  pass "deriver emits dotted-quad only, dropping junk interface output"
else
  fail "deriver emitted non-address token(s):$bad_tokens — that lands verbatim in trusted_domains"
fi

for bad in 127.0.0.1 169.254.5.5 172.18.0.1; do
  case " $got " in
    *" $bad "*) fail "deriver emitted $bad — loopback/link-local/docker-bridge must never enter the trust list" ;;
    *) pass "deriver excludes $bad" ;;
  esac
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
