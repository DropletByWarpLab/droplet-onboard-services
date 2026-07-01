#!/usr/bin/env bash
# =============================================================================
# WARP-986 — unit tests for the public per-device FQDN leg in
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Live root cause on the .87 single-box (2026-07-01): AP (Wi-Fi) clients could
# never resolve the box's ADR-023 public FQDN (d-<hmac>.droplet-us.com) — the
# ONLY resolver they use is the dnsmasq-ap instance the attach script
# regenerates, and its config carried only AP_HOSTNAME/AP_DOMAIN. The uci
# hostrecord leg the routing service writes lands in a dnsmasq that is NOT
# running in single-box AP mode, and the host-net dnsmasq has DNS disabled
# (port=0). Appending address=/<fqdn>/192.168.20.1 to dnsmasq-ap.conf and
# restarting dnsmasq fixed it live (nslookup -> 192.168.20.1, ZeroSSL chain
# validated). Two pieces now ship that fix:
#   * resolve_public_fqdn      — outer-script env/.env resolution + the SAME
#                                conservative validation droplet-set-public-
#                                fqdn.sh enforces (invalid -> dropped, never
#                                emitted into the dnsmasq config)
#   * dnsmasq_ap_public_fqdn   — conditional address=/ append in the container
#                                body, ahead of the DNSMASQ_CHANGED gate so a
#                                newly-learned name bounces dnsmasq
#
# Both are sentinel-delimited; we extract each and run it against a fake .env /
# a redirected conf path — no Docker, OpenWrt container, or Wi-Fi card needed.
# Mirrors tests/openwrt-attach-ap-bringup.test.sh.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-openwrt-attach"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-986 — droplet-openwrt-attach public-FQDN leg"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

extract() { # <start-mark> <end-mark> <outfile>
  sed -n "/$(printf '%s' "$1" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$2" | sed 's/[][\\.*^$/]/\\&/g')/p" \
    "$ATTACH" > "$3"
}

# --- Phase 1: structure ------------------------------------------------------
echo "--- Phase 1: FQDN leg present + wired ---"
if [ -f "$ATTACH" ]; then pass "attach script exists"; else fail "attach script missing"; echo "FAILURES=$FAILURES"; exit 1; fi

for m in \
  "# >>> resolve_public_fqdn (WARP-986)" "# <<< resolve_public_fqdn (WARP-986)" \
  "# >>> dnsmasq_ap_public_fqdn (WARP-986)" "# <<< dnsmasq_ap_public_fqdn (WARP-986)"; do
  if grep -qF "$m" "$ATTACH"; then pass "sentinel present: $m"; else fail "sentinel missing: $m"; fi
done

if grep -qE "^resolve_public_fqdn\b" "$ATTACH"; then pass "resolve_public_fqdn is invoked"; else fail "resolve_public_fqdn not invoked"; fi

# The resolved name must cross into the container body via docker exec -e —
# the single-quoted exec body cannot see outer-script variables otherwise.
if grep -qE -- '-e PUBLIC_FQDN="\$PUBLIC_FQDN"' "$ATTACH"; then
  pass "docker exec passes PUBLIC_FQDN into the container body"
else
  fail "docker exec does not pass -e PUBLIC_FQDN (container heredoc would expand empty)"
fi

# The container block must emit the address=/ mapping to the AP gateway.
if grep -qF 'address=/$PUBLIC_FQDN/192.168.20.1' "$ATTACH"; then
  pass "container block emits address=/\$PUBLIC_FQDN/192.168.20.1"
else
  fail "container block missing the address=/\$PUBLIC_FQDN/192.168.20.1 mapping"
fi

# Apostrophes inside the container-side block would close the outer
# single-quoted docker-exec body early. Assert the extracted block is clean.
extract "# >>> dnsmasq_ap_public_fqdn (WARP-986)" "# <<< dnsmasq_ap_public_fqdn (WARP-986)" "$WORK/append.sh"
extract "# >>> resolve_public_fqdn (WARP-986)" "# <<< resolve_public_fqdn (WARP-986)" "$WORK/resolve.sh"
if [ -s "$WORK/append.sh" ] && [ -s "$WORK/resolve.sh" ]; then
  pass "extracted both sentinel blocks"
else
  fail "could not extract a sentinel block"; echo "FAILURES=$FAILURES"; exit 1
fi
if grep -q "'" "$WORK/append.sh"; then
  fail "apostrophe found in the container-side FQDN block (would break the single-quoted docker-exec body)"
else
  pass "container-side FQDN block is apostrophe-free (safe inside the single-quoted exec body)"
fi

# The append must land BEFORE the DNSMASQ_CHANGED cmp gate, so a newly-learned
# name flips the gate and the restart below picks the new conf up.
APPEND_LINE=$(grep -n "# >>> dnsmasq_ap_public_fqdn (WARP-986)" "$ATTACH" | head -1 | cut -d: -f1)
GATE_LINE=$(grep -n "DNSMASQ_CHANGED=0" "$ATTACH" | head -1 | cut -d: -f1)
if [ -n "$APPEND_LINE" ] && [ -n "$GATE_LINE" ] && [ "$APPEND_LINE" -lt "$GATE_LINE" ]; then
  pass "FQDN append precedes the DNSMASQ_CHANGED gate (new name triggers a restart)"
else
  fail "FQDN append must come before DNSMASQ_CHANGED=0 (append=$APPEND_LINE gate=$GATE_LINE)"
fi

# Restart-on-change: the CHANGED branch must KILL the running dnsmasq-ap before
# the pgrep-guarded start, or a changed conf while dnsmasq is running would be
# a silent no-op (start-only-when-dead). WARP-986 depends on this bounce.
KILL_LINE=$(grep -n 'pgrep -f "dnsmasq -C /etc/dnsmasq-ap.conf" | xargs -r kill' "$ATTACH" | head -1 | cut -d: -f1)
START_LINE=$(grep -n 'pgrep -f "dnsmasq -C /etc/dnsmasq-ap.conf" >/dev/null || dnsmasq -C /etc/dnsmasq-ap.conf' "$ATTACH" | head -1 | cut -d: -f1)
if [ -n "$KILL_LINE" ] && [ -n "$START_LINE" ] && [ "$KILL_LINE" -lt "$START_LINE" ]; then
  pass "DNSMASQ_CHANGED path kills the running dnsmasq-ap before the guarded start (restart, not start-when-dead)"
else
  fail "changed dnsmasq-ap.conf would not bounce a RUNNING dnsmasq (kill=$KILL_LINE start=$START_LINE)"
fi

# --- Phase 2: resolve_public_fqdn behavior -----------------------------------
echo "--- Phase 2: resolve_public_fqdn (env/.env resolution + validation) ---"

run_resolve() { # <env-fqdn> <env-file-path>
  DROPLET_PUBLIC_FQDN="$1" DROPLET_PUBLIC_FQDN_ENV_FILE="$2" \
  bash -c "set -u; . '$WORK/resolve.sh' >/dev/null; printf '%s' \"\$PUBLIC_FQDN\""
}

VALID_FQDN="d-b5839920cb1b0d09.droplet-us.com"

# Case A: explicit valid env value -> kept verbatim.
OUT="$(run_resolve "$VALID_FQDN" "$WORK/no-such-env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass "valid DROPLET_PUBLIC_FQDN env kept"; else fail "expected '$VALID_FQDN', got '$OUT'"; fi

# Case B: env unset -> read from the repo .env (the droplet-set-public-fqdn.sh
# persisted record).
printf 'OTHER=1\nDROPLET_PUBLIC_FQDN=%s\n' "$VALID_FQDN" > "$WORK/env"
OUT="$(run_resolve "" "$WORK/env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass ".env fallback read (DROPLET_PUBLIC_FQDN line)"; else fail ".env fallback expected '$VALID_FQDN', got '$OUT'"; fi

# Case C: explicit env WINS over the .env record (operator override stays
# authoritative — same posture as DROPLET_AP_PHY/DROPLET_AP_IFACE).
printf 'DROPLET_PUBLIC_FQDN=%s\n' "other.droplet-us.com" > "$WORK/env"
OUT="$(run_resolve "$VALID_FQDN" "$WORK/env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass "explicit env wins over the .env record"; else fail "env override lost to .env: got '$OUT'"; fi

# Case D: missing .env + no env -> empty (name simply not served).
OUT="$(run_resolve "" "$WORK/no-such-env")"
if [ -z "$OUT" ]; then pass "no env + no .env -> empty (no FQDN served)"; else fail "expected empty, got '$OUT'"; fi

# Case E: invalid shapes are DROPPED (validation mirrors droplet-set-public-
# fqdn.sh: lowercase [a-z0-9.-], dotted, no lead/trail dot or hyphen, <=253).
LONG_FQDN="$(printf 'a%.0s' $(seq 1 250)).droplet-us.com"   # 254+ chars
for bad in \
  "UPPER.droplet-us.com" \
  "nodots" \
  "-lead.droplet-us.com" \
  "trail.droplet-us.com-" \
  ".lead.droplet-us.com" \
  "trail.droplet-us.com." \
  'evil;rm.droplet-us.com' \
  'inj$(x).droplet-us.com' \
  "has space.droplet-us.com" \
  "$LONG_FQDN"; do
  OUT="$(run_resolve "$bad" "$WORK/no-such-env")"
  if [ -z "$OUT" ]; then pass "invalid FQDN dropped: ${bad:0:40}"; else fail "invalid FQDN NOT dropped: '$bad' -> '$OUT'"; fi
done

# Case F: an invalid .env record is dropped too (root must not trust the file).
printf 'DROPLET_PUBLIC_FQDN=BAD;Name\n' > "$WORK/env"
OUT="$(run_resolve "" "$WORK/env")"
if [ -z "$OUT" ]; then pass "invalid .env record dropped"; else fail "invalid .env record NOT dropped: '$OUT'"; fi

# --- Phase 3: container-side append behavior ---------------------------------
echo "--- Phase 3: dnsmasq_ap_public_fqdn (conditional address=/ append) ---"

# The block writes to the absolute /etc/dnsmasq-ap.conf.new; redirect that path
# into the sandbox so the heredoc expansion can run unprivileged.
sed "s|/etc/dnsmasq-ap.conf.new|$WORK/dnsmasq-ap.conf.new|g" "$WORK/append.sh" > "$WORK/append-sandbox.sh"

# FQDN set -> the address line lands (exactly once) with the AP gateway IP.
: > "$WORK/dnsmasq-ap.conf.new"
PUBLIC_FQDN="$VALID_FQDN" bash -c "set -u; . '$WORK/append-sandbox.sh'"
COUNT=$(grep -cF "address=/$VALID_FQDN/192.168.20.1" "$WORK/dnsmasq-ap.conf.new" || true)
if [ "$COUNT" = "1" ]; then
  pass "FQDN set -> exactly one address=/$VALID_FQDN/192.168.20.1 line"
else
  fail "expected exactly one address line, found $COUNT"
fi

# FQDN empty -> nothing appended (config byte-identical, no restart churn).
: > "$WORK/dnsmasq-ap.conf.new"
PUBLIC_FQDN="" bash -c "set -u; . '$WORK/append-sandbox.sh'"
if [ ! -s "$WORK/dnsmasq-ap.conf.new" ]; then
  pass "FQDN empty -> nothing appended (no config churn on FQDN-less boxes)"
else
  fail "empty FQDN still appended: $(cat "$WORK/dnsmasq-ap.conf.new")"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
