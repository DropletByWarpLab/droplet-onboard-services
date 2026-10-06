#!/usr/bin/env bash
# =============================================================================
# Internal DNS on the AP/WireGuard resolver. Extracted setup blocks run against
# a fake .env and a temporary dnsmasq config; no live network is touched.
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
echo "  WARP-986 — droplet-openwrt-attach internal-DNS leg"
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
  "# >>> resolve_internal_hostname (WARP-986)" "# <<< resolve_internal_hostname (WARP-986)" \
  "# >>> dnsmasq_ap_internal_hostname (WARP-986)" "# <<< dnsmasq_ap_internal_hostname (WARP-986)"; do
  if grep -qF "$m" "$ATTACH"; then pass "sentinel present: $m"; else fail "sentinel missing: $m"; fi
done

if grep -qE "^resolve_internal_hostname\b" "$ATTACH"; then pass "resolve_internal_hostname is invoked"; else fail "resolve_internal_hostname not invoked"; fi

# The resolved name must cross into the container body via docker exec -e —
# the single-quoted exec body cannot see outer-script variables otherwise.
if grep -qE -- '-e INTERNAL_HOSTNAME="\$INTERNAL_HOSTNAME"' "$ATTACH"; then
  pass "docker exec passes INTERNAL_HOSTNAME into the container body"
else
  fail "docker exec does not pass -e INTERNAL_HOSTNAME (container heredoc would expand empty)"
fi

# The container block must emit the address=/ mapping to the AP gateway.
if grep -qF 'address=/$INTERNAL_HOSTNAME/192.168.20.1' "$ATTACH"; then
  pass "container block emits address=/\$INTERNAL_HOSTNAME/192.168.20.1"
else
  fail "container block missing the address=/\$INTERNAL_HOSTNAME/192.168.20.1 mapping"
fi

# Apostrophes inside the container-side block would close the outer
# single-quoted docker-exec body early. Assert the extracted block is clean.
extract "# >>> dnsmasq_ap_internal_hostname (WARP-986)" "# <<< dnsmasq_ap_internal_hostname (WARP-986)" "$WORK/append.sh"
extract "# >>> resolve_internal_hostname (WARP-986)" "# <<< resolve_internal_hostname (WARP-986)" "$WORK/resolve.sh"
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
APPEND_LINE=$(grep -n "# >>> dnsmasq_ap_internal_hostname (WARP-986)" "$ATTACH" | head -1 | cut -d: -f1)
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

# --- Phase 2: resolve_internal_hostname behavior -----------------------------------
echo "--- Phase 2: resolve_internal_hostname (env/.env resolution + validation) ---"

run_resolve() { # <env-fqdn> <env-file-path>
  DROPLET_LAN_HOSTNAME="$1" DROPLET_ENV_FILE="$2" \
  bash -c "set -u; . '$WORK/resolve.sh' >/dev/null; printf '%s' \"\$INTERNAL_HOSTNAME\""
}

VALID_FQDN="office.lan"

# Case A: explicit valid env value -> kept verbatim.
OUT="$(run_resolve "$VALID_FQDN" "$WORK/no-such-env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass "valid DROPLET_LAN_HOSTNAME env kept"; else fail "expected '$VALID_FQDN', got '$OUT'"; fi

# Case B: env unset -> read the internal name from the repo .env.
printf 'OTHER=1\nDROPLET_LAN_HOSTNAME=%s\n' "$VALID_FQDN" > "$WORK/env"
OUT="$(run_resolve "" "$WORK/env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass ".env fallback read (DROPLET_LAN_HOSTNAME line)"; else fail ".env fallback expected '$VALID_FQDN', got '$OUT'"; fi

# Case C: explicit env WINS over the .env record (operator override stays
# authoritative — same posture as DROPLET_AP_PHY/DROPLET_AP_IFACE).
printf 'DROPLET_LAN_HOSTNAME=%s\n' "other.example.lan" > "$WORK/env"
OUT="$(run_resolve "$VALID_FQDN" "$WORK/env")"
if [ "$OUT" = "$VALID_FQDN" ]; then pass "explicit env wins over the .env record"; else fail "env override lost to .env: got '$OUT'"; fi

# Case D: missing .env + no env -> empty (name simply not served).
OUT="$(run_resolve "" "$WORK/no-such-env")"
if [ "$OUT" = droplet-ai.lan ]; then pass "no env + no .env uses internal DNS default"; else fail "expected internal default, got '$OUT'"; fi

# Case E: invalid shapes are DROPPED (validation mirrors droplet-set-public-
# fqdn.sh: lowercase [a-z0-9.-], dotted, no lead/trail dot or hyphen, <=253).
LONG_FQDN="$(printf 'a%.0s' $(seq 1 250)).example.lan"   # 254+ chars
for bad in \
  "UPPER.example.lan" \
  "nodots" \
  "-lead.example.lan" \
  "trail.example.lan-" \
  ".lead.example.lan" \
  "trail.example.lan." \
  'evil;rm.example.lan' \
  'inj$(x).example.lan' \
  "has space.example.lan" \
  "$LONG_FQDN"; do
  OUT="$(run_resolve "$bad" "$WORK/no-such-env")"
  if [ -z "$OUT" ]; then pass "invalid FQDN dropped: ${bad:0:40}"; else fail "invalid FQDN NOT dropped: '$bad' -> '$OUT'"; fi
done

# Case F: an invalid .env record is dropped too (root must not trust the file).
printf 'DROPLET_LAN_HOSTNAME=BAD;Name\n' > "$WORK/env"
OUT="$(run_resolve "" "$WORK/env")"
if [ -z "$OUT" ]; then pass "invalid .env record dropped"; else fail "invalid .env record NOT dropped: '$OUT'"; fi

# --- Phase 3: container-side append behavior ---------------------------------
echo "--- Phase 3: dnsmasq_ap_internal_hostname (conditional address=/ append) ---"

# The block writes to the absolute /etc/dnsmasq-ap.conf.new; redirect that path
# into the sandbox so the heredoc expansion can run unprivileged.
sed "s|/etc/dnsmasq-ap.conf.new|$WORK/dnsmasq-ap.conf.new|g" "$WORK/append.sh" > "$WORK/append-sandbox.sh"

# FQDN set -> the address line lands (exactly once) with the AP gateway IP.
: > "$WORK/dnsmasq-ap.conf.new"
INTERNAL_HOSTNAME="$VALID_FQDN" bash -c "set -u; . '$WORK/append-sandbox.sh'"
COUNT=$(grep -cF "address=/$VALID_FQDN/192.168.20.1" "$WORK/dnsmasq-ap.conf.new" || true)
if [ "$COUNT" = "1" ]; then
  pass "FQDN set -> exactly one address=/$VALID_FQDN/192.168.20.1 line"
else
  fail "expected exactly one address line, found $COUNT"
fi

# FQDN empty -> nothing appended (config byte-identical, no restart churn).
: > "$WORK/dnsmasq-ap.conf.new"
INTERNAL_HOSTNAME="" bash -c "set -u; . '$WORK/append-sandbox.sh'"
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
