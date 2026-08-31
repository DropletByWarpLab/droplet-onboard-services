#!/usr/bin/env bash
# =============================================================================
# WARP-2189 — unit tests for scripts/host/droplet-relay-dns.sh
#
# The helper that keeps the cloudflared relay's DNS origin answering: dnsmasq
# must LISTEN on the address it ANSWERS for (host-record). These tests drive
# the real script against stub ip/ss/systemctl/dnsmasq binaries and a fixture
# conf — no root, no dnsmasq, no systemd, no network.
#
# The systemctl stub models `bind-interfaces` faithfully: on restart it
# re-derives the bound set from the conf's listen-address lines, and REFUSES TO
# START (unit goes failed) if any of them is not an address the fake host
# holds. That is the real hazard this script guards against, so the rollback
# path is exercised against the true failure mode rather than a flag.
#
# Runtime: < 10 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY_DNS="$REPO_ROOT_REAL/scripts/host/droplet-relay-dns.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-2189 — droplet-relay-dns"
echo "  ================================================"
echo ""

if [ ! -f "$RELAY_DNS" ]; then
  fail "scripts/host/droplet-relay-dns.sh does not exist"
  echo ""
  echo "  1 of 1 tests FAILED"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CONF="$WORK/lan-dhcp.conf"
ADDRS="$WORK/addrs"        # "<ip> <iface>" per line — the fake host's addresses
BOUND="$WORK/bound"        # "<ip>:53" per line — what dnsmasq currently binds
UNIT="$WORK/unit_state"    # active | failed
SCLOG="$WORK/systemctl.log"

# --- stubs --------------------------------------------------------------------
mkdir -p "$WORK/bin"

cat > "$WORK/bin/ip" <<EOF
#!/bin/sh
# ip -o -4 addr show to <ip>  → one ip(8) -o line when the fake host holds it.
for last in "\$@"; do :; done
awk -v want="\$last" '\$1 == want {
  printf "2: %s    inet %s/24 brd 192.168.9.255 scope global %s\n", \$2, \$1, \$2
}' "$ADDRS" 2>/dev/null
exit 0
EOF

cat > "$WORK/bin/ss" <<EOF
#!/bin/sh
# ss -lun → UNCONN rows in the real column order (local address is field 4).
while read -r a; do
  [ -n "\$a" ] && printf 'UNCONN 0      0      %s      0.0.0.0:*\n' "\$a"
done < "$BOUND" 2>/dev/null
exit 0
EOF

cat > "$WORK/bin/dnsmasq" <<EOF
#!/bin/sh
# dnsmasq --test --conf-file=<f>
exit \$(cat "$WORK/dnsmasq_exit" 2>/dev/null || echo 0)
EOF

# systemctl stub: models bind-interfaces on restart.
cat > "$WORK/bin/systemctl" <<EOF
#!/bin/sh
printf 'systemctl %s\n' "\$*" >> "$SCLOG"
case "\$1" in
  is-active) cat "$UNIT" 2>/dev/null || echo active; exit 0 ;;
  restart)
    # One-shot failure injection: models "the unit did not come back" for a
    # reason unrelated to the conf, so the ROLLBACK restart still succeeds.
    if [ -f "$WORK/restart_fail" ]; then
      rm -f "$WORK/restart_fail"
      echo failed > "$UNIT"
      : > "$BOUND"
      exit 0
    fi
    : > "$BOUND"
    ok=1
    for a in \$(grep '^listen-address=' "$CONF" 2>/dev/null | sed 's/^listen-address=//'); do
      if awk -v w="\$a" '\$1 == w { f = 1 } END { exit f ? 0 : 1 }' "$ADDRS"; then
        printf '%s:53\n' "\$a" >> "$BOUND"
      else
        ok=0
      fi
    done
    if [ "\$ok" = 1 ]; then echo active > "$UNIT"; else echo failed > "$UNIT"; : > "$BOUND"; fi
    exit 0 ;;
esac
exit 0
EOF

chmod +x "$WORK/bin/ip" "$WORK/bin/ss" "$WORK/bin/dnsmasq" "$WORK/bin/systemctl"

# Run the helper against the fixture host with the subcommand in "$@".
run_rd() {
  env PATH="$WORK/bin:$PATH" \
      DROPLET_RELAY_DNS_CONF="$CONF" \
      DROPLET_RELAY_DNS_IP_BIN="$WORK/bin/ip" \
      DROPLET_RELAY_DNS_SS_BIN="$WORK/bin/ss" \
      DROPLET_RELAY_DNS_DNSMASQ="$WORK/bin/dnsmasq" \
      DROPLET_RELAY_DNS_SYSTEMCTL="$WORK/bin/systemctl" \
      DROPLET_RELAY_DNS_SETTLE_S=1 \
      DROPLET_PUBLIC_FQDN= \
      DROPLET_PUBLIC_FQDN_IP= \
      bash "$RELAY_DNS" "$@" 2>&1
}

rd_rc() { run_rd "$@" >/dev/null 2>&1; echo $?; }

# The shipped template's shape: one listen-address, bind-interfaces.
write_base_conf() {
  cat > "$CONF" <<'BASE'
bind-interfaces
interface=br-lan
listen-address=192.168.20.1
except-interface=lo
dhcp-range=192.168.20.100,192.168.20.200,12h
BASE
}

# Add the ADR-023 managed host-record local-dns.sh writes.
add_host_record() { # <fqdn> <ip>
  {
    printf '\n%s\n' '# ADR-023 managed host-record (split-horizon FQDN) — do not edit by hand'
    printf 'host-record=%s,%s\n' "$1" "$2"
  } >> "$CONF"
}

reset_fixture() {
  write_base_conf
  printf '192.168.20.1 br-lan\n192.168.9.250 enp11s0\n' > "$ADDRS"
  printf '192.168.20.1:53\n' > "$BOUND"
  echo active > "$UNIT"
  : > "$SCLOG"
  rm -f "$WORK/dnsmasq_exit" "$WORK/restart_fail"
  rm -f "$CONF".bak-relay-dns-* 2>/dev/null || true
}

# grep -c prints 0 AND exits 1 on no match — take the output, ignore the code.
managed_block_count() {
  local n
  n="$(grep -c 'droplet-relay-dns (WARP-2189)' "$CONF" 2>/dev/null)" || true
  printf '%s' "${n:-0}"
}

# =============================================================================
echo "--- Phase 0: static checks ---"
# =============================================================================
if bash -n "$RELAY_DNS" 2>/dev/null; then
  pass "droplet-relay-dns.sh passes bash -n"
else
  fail "droplet-relay-dns.sh fails bash -n"
  exit 1
fi

if grep -q 'droplet-relay-dns' "$REPO_ROOT_REAL/scripts/lib/single-box.sh"; then
  pass "single-box.sh installs droplet-relay-dns"
else
  fail "single-box.sh does not install droplet-relay-dns"
fi

# The whole point of the ticket: the listener must be re-applied by the same
# setup pass that overwrites the conf, not left as a hand edit.
if grep -q '_assert_relay_dns_listener' "$REPO_ROOT_REAL/scripts/lib/local-dns.sh"; then
  pass "local-dns.sh asserts the relay listener after writing the host-record"
else
  fail "local-dns.sh does not assert the relay listener"
fi

if grep -q 'relay_dns' "$REPO_ROOT_REAL/scripts/host/droplet-watchdog.sh"; then
  pass "droplet-watchdog.sh carries the relay_dns check"
else
  fail "droplet-watchdog.sh has no relay_dns check"
fi

# =============================================================================
echo ""
echo "--- Phase 1: check ---"
# =============================================================================
reset_fixture
rc="$(rd_rc check)"
[ "$rc" = 3 ] && pass "check: no host-record and no env → not applicable (exit 3)" \
              || fail "check: expected exit 3 with no host-record, got $rc"

reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
rc="$(rd_rc check)"
[ "$rc" = 1 ] && pass "check: record on an unbound leg → BROKEN (exit 1) — the WARP-2189 shape" \
              || fail "check: expected exit 1 for an unbound leg, got $rc"

out="$(run_rd check)"
case "$out" in
  *"nothing is bound to 192.168.9.250:53"*) pass "check: names the unbound address in its message" ;;
  *) fail "check: message did not name the unbound address: $out" ;;
esac

reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
printf '192.168.20.1:53\n192.168.9.250:53\n' > "$BOUND"
rc="$(rd_rc check)"
[ "$rc" = 0 ] && pass "check: record on a bound leg → healthy (exit 0)" \
              || fail "check: expected exit 0 when the leg is bound, got $rc"

# A box whose FQDN points at the leg the template already listens on — every
# non-relay shape. Must be a silent no-op, never a finding.
reset_fixture
add_host_record droplet.lan 192.168.20.1
rc="$(rd_rc check)"
[ "$rc" = 0 ] && pass "check: FQDN on the template's own leg → healthy (no-op on non-relay shapes)" \
              || fail "check: expected exit 0 for the default leg, got $rc"

reset_fixture
add_host_record spathdentistry.droplet-us.com 10.9.9.9
rc="$(rd_rc check)"
[ "$rc" = 3 ] && pass "check: address absent from the host → not applicable, not broken (exit 3)" \
              || fail "check: expected exit 3 for an absent address, got $rc"

reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
printf '0.0.0.0:53\n' > "$BOUND"
rc="$(rd_rc check)"
[ "$rc" = 0 ] && pass "check: a wildcard bind satisfies the invariant (exit 0)" \
              || fail "check: wildcard bind should be healthy, got $rc"

# check must never mutate anything.
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
before="$(cat "$CONF")"
run_rd check >/dev/null 2>&1
if [ "$before" = "$(cat "$CONF")" ] && [ ! -s "$SCLOG" ]; then
  pass "check: read-only — conf untouched and systemd never called"
else
  fail "check: mutated the conf or called systemctl"
fi

# =============================================================================
echo ""
echo "--- Phase 2: repair ---"
# =============================================================================
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
rc="$(rd_rc repair)"
if [ "$rc" = 0 ]; then pass "repair: exits 0 on the broken-leg case"; else fail "repair: expected exit 0, got $rc"; fi

if grep -qx 'listen-address=192.168.9.250' "$CONF"; then
  pass "repair: added listen-address for the FQDN's address"
else
  fail "repair: no listen-address=192.168.9.250 in the conf"
fi

# The interface must be DERIVED from the address, never assumed.
if grep -qx 'no-dhcp-interface=enp11s0' "$CONF"; then
  pass "repair: pinned no-dhcp-interface for the derived interface (never races upstream DHCP)"
else
  fail "repair: no no-dhcp-interface line for the derived interface"
fi

rc="$(rd_rc check)"
[ "$rc" = 0 ] && pass "repair: the origin is healthy afterwards" \
              || fail "repair: check still fails after repair (exit $rc)"

# Idempotence — the watchdog runs this every ~3 minutes forever.
run_rd repair >/dev/null 2>&1
run_rd repair >/dev/null 2>&1
n="$(managed_block_count)"
[ "$n" = 1 ] && pass "repair: idempotent — exactly one managed block after repeat runs" \
             || fail "repair: managed block appears $n times after repeat runs"

# A healthy box must not get its DNS plane restarted for nothing.
: > "$SCLOG"
run_rd repair >/dev/null 2>&1
if grep -q restart "$SCLOG"; then
  fail "repair: restarted droplet-host-net when the listener was already bound"
else
  pass "repair: no restart when the listener is already bound"
fi

# --- validation gate ---
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
echo 1 > "$WORK/dnsmasq_exit"
before="$(cat "$CONF")"
rc="$(rd_rc repair)"
if [ "$rc" = 1 ] && [ "$before" = "$(cat "$CONF")" ]; then
  pass "repair: a config dnsmasq --test rejects is never installed (exit 1, conf unchanged)"
else
  fail "repair: rejected config was installed or wrong exit (rc=$rc)"
fi

# --- rollback: the unit does not come back ---
# The conf itself is valid and dnsmasq accepts it; the restart fails for an
# unrelated reason. That is the case where rolling back must actually restore
# service, so the injection is one-shot and the rollback restart succeeds.
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
before="$(cat "$CONF")"
touch "$WORK/restart_fail"
rc="$(rd_rc repair)"
if [ "$rc" = 1 ]; then
  pass "repair: reports failure when droplet-host-net does not come back (exit 1)"
else
  fail "repair: expected exit 1 when the unit stays down, got $rc"
fi
if [ "$before" = "$(cat "$CONF")" ]; then
  pass "repair: rolled the conf back to its pre-repair contents"
else
  fail "repair: conf was left modified after a failed repair"
fi
if [ "$(cat "$UNIT")" = active ]; then
  pass "repair: rollback brought droplet-host-net back up"
else
  fail "repair: left droplet-host-net down after rollback"
fi

# --- reverse heal: managed block pins an address that has gone away ---
# Without this, a fabric NIC that disappears keeps the host DHCP/DNS plane dead
# for every LAN client — a far worse outage than losing relay DNS.
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
run_rd repair >/dev/null 2>&1
printf '192.168.20.1 br-lan\n' > "$ADDRS"   # the fabric leg is gone
echo failed > "$UNIT"
rc="$(rd_rc repair)"
if [ "$rc" = 0 ] && [ "$(cat "$UNIT")" = active ]; then
  pass "repair: strips a listener whose address vanished and brings the unit back"
else
  fail "repair: did not recover from a vanished listener address (rc=$rc, unit=$(cat "$UNIT"))"
fi
if [ "$(managed_block_count)" = 0 ]; then
  pass "repair: the stale managed block is gone after the reverse heal"
else
  fail "repair: stale managed block survived the reverse heal"
fi

# =============================================================================
echo ""
echo "--- Phase 3: the regression this ticket exists for ---"
# =============================================================================
# setup.sh re-installs the STATIC template unconditionally, wiping the
# listener. This is what happened on 2026-08-14 and again on 2026-08-26.
reset_fixture
add_host_record spathdentistry.droplet-us.com 192.168.9.250
run_rd repair >/dev/null 2>&1
[ "$(rd_rc check)" = 0 ] || fail "setup: origin was not healthy before the simulated setup run"

write_base_conf                                            # <- the overwrite
add_host_record spathdentistry.droplet-us.com 192.168.9.250  # <- local-dns.sh re-adds the record
printf '192.168.20.1:53\n' > "$BOUND"
echo active > "$UNIT"
rc="$(rd_rc check)"
[ "$rc" = 1 ] && pass "setup: overwriting the conf reproduces the outage (check → broken)" \
              || fail "setup: expected the overwrite to break the origin, got $rc"

rc="$(rd_rc repair)"
if [ "$rc" = 0 ] && [ "$(rd_rc check)" = 0 ]; then
  pass "setup: the listener is restored automatically after the overwrite"
else
  fail "setup: the origin was not restored after the overwrite (rc=$rc)"
fi

# =============================================================================
echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mall %d tests passed\033[0m\n\n" "$TESTS"
  exit 0
fi
printf "  \033[31m%d of %d tests FAILED\033[0m\n\n" "$FAILURES" "$TESTS"
exit 1
