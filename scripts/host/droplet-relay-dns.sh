#!/usr/bin/env bash
# =============================================================================
# WARP-2189 — droplet-relay-dns: keep the tunnel's DNS origin answering
# =============================================================================
#
# Off-site access to a Droplet goes through the ADR-025 cloudflared relay. The
# Cloudflare side carries a private-network route for the box's fabric leg and
# a Local Domain Fallback that points the box's own domain at
# <DROPLET_PUBLIC_FQDN_IP>:53 — i.e. at the box's dnsmasq. So every off-site
# name lookup is a DNS query the connector dials AT THE BOX.
#
# The host dnsmasq (droplet-host-net.service, conf below) runs with
# `bind-interfaces`, which binds ONLY the addresses named by an explicit
# `listen-address=` line. The shipped template
# (scripts/host/etc-droplet-host-net/lan-dhcp.conf) names exactly one:
# 192.168.20.1, the LAN gateway leg. On a box whose FQDN resolves to a
# DIFFERENT leg — any box reached over the relay — nothing listens on the
# address the tunnel dials, and cloudflared loops
#
#     unable to dial tcp to origin <ip>:53: connection refused
#
# The failure is invisible in the worst way. The connector stays healthy and
# TCP to the box still answers, but the FQDN goes NXDOMAIN/SERVFAIL, and
# because the box's certificate is NAME-ONLY (one DNS SAN, zero IP SANs)
# connecting by IP cannot validate either. Off-site support goes blind, and it
# reads exactly like "the box is down". Measured twice on the same box
# (2026-08-14, 2026-08-26); both times the box was fine.
#
# It kept coming back because the listener was only ever a hand edit, and
# scripts/lib/single-box.sh re-installs the STATIC template on every
# ./scripts/setup.sh run, wiping it.
#
# -- THE INVARIANT THIS SCRIPT OWNS -------------------------------------------
#   If dnsmasq is configured to ANSWER for a name at an address
#   (`host-record=<fqdn>,<ip>`), it must also LISTEN on that address
#   (`listen-address=<ip>`).
#
# Both halves are generated from the same DROPLET_PUBLIC_FQDN_IP by
# scripts/lib/local-dns.sh. Writing the record without the listener is the
# bug; this script is the single owner of the pairing, at setup time and at
# runtime. It is a no-op on a box whose FQDN already resolves to the address
# the template listens on, so it costs nothing on shapes that never relay.
#
# -- SUBCOMMANDS --------------------------------------------------------------
#   check    Read-only. Never touches the conf or systemd.
#            Exit 0 = the invariant holds (dnsmasq is listening, and answering
#                     if a query tool is available).
#            Exit 1 = broken and repairable.
#            Exit 3 = not applicable (no managed FQDN, or the address is not
#                     on this host — see the boot-order note below).
#
#   repair   Assert the managed listener block, validate with `dnsmasq --test`,
#            restart droplet-host-net, and verify the listener came up.
#            ROLLS BACK to the pre-repair conf if the unit does not come back.
#            Exit 0 = repaired and verified, or nothing to do.
#            Exit 1 = repair attempted and failed (conf restored).
#            Exit 3 = not applicable.
#
# -- WHY THE "ADDRESS NOT ON THIS HOST" GUARD IS LOAD-BEARING -----------------
# Under `bind-interfaces` dnsmasq REFUSES TO START if a listen-address is not
# assigned to a live interface. Adding the line while the fabric NIC is down
# would take the whole host DHCP/DNS plane with it — a far worse outage than
# the one being fixed. So `repair` only ever adds a listener for an address
# that is present RIGHT NOW, and it heals the reverse case too: if the managed
# block names an address that has since gone away and the unit is failed, it
# strips the block and brings the unit back.
#
# DHCP is deliberately NOT extended onto the new leg. The fabric leg's DHCP
# belongs to the upstream router; a second server there would race it. The
# managed block pins `no-dhcp-interface=` for the interface it adds, and the
# interface is DERIVED from the address, never hardcoded.
# =============================================================================
set -u

RD_CONF="${DROPLET_RELAY_DNS_CONF:-/etc/droplet-host-net/lan-dhcp.conf}"
RD_UNIT="${DROPLET_RELAY_DNS_UNIT:-droplet-host-net.service}"
RD_DNSMASQ="${DROPLET_RELAY_DNS_DNSMASQ:-dnsmasq}"
RD_SYSTEMCTL="${DROPLET_RELAY_DNS_SYSTEMCTL:-systemctl}"
RD_IP_BIN="${DROPLET_RELAY_DNS_IP_BIN:-ip}"
RD_SS_BIN="${DROPLET_RELAY_DNS_SS_BIN:-ss}"
# Seconds to wait for the unit to come back after a restart.
RD_SETTLE_S="${DROPLET_RELAY_DNS_SETTLE_S:-5}"

RD_BEGIN='# >>> droplet-relay-dns (WARP-2189) — generated, do not edit by hand'
RD_END='# <<< droplet-relay-dns'

rd_log() { printf 'droplet-relay-dns: %s\n' "$*"; }
rd_err() { printf 'droplet-relay-dns: %s\n' "$*" >&2; }

rd_usage() {
  printf '%s\n' \
    'Usage: droplet-relay-dns <check|repair>' \
    '' \
    '  check    Verify dnsmasq listens on (and answers at) the address its' \
    '           managed host-record hands out for the box FQDN. Read-only.' \
    '           Exit 0 healthy | 1 broken | 2 usage | 3 not applicable.' \
    '' \
    '  repair   Assert the managed listen-address block, validate, restart' \
    '           droplet-host-net, verify, and roll back on failure.' \
    '           Exit 0 repaired/no-op | 1 failed | 2 usage | 3 not applicable.'
}

# --- the (fqdn, ip) pair this box must answer for -----------------------------
# Precedence: explicit environment (tests, deliberate ops) -> the MANAGED
# host-record already in the conf. There is no host-specific default path and
# no .env lookup: the conf is the artifact both halves of the invariant live
# in, so it is also the honest source of truth for what was promised.
rd_desired_fqdn=""
rd_desired_ip=""
rd_resolve_desired() {
  rd_desired_fqdn="${DROPLET_PUBLIC_FQDN:-}"
  rd_desired_ip="${DROPLET_PUBLIC_FQDN_IP:-}"
  if [ -n "$rd_desired_fqdn" ] && [ -n "$rd_desired_ip" ]; then
    return 0
  fi
  [ -r "$RD_CONF" ] || return 1
  # local-dns.sh appends the managed record last, so the LAST host-record line
  # is the current one. Anything older is stale by construction.
  local line
  line="$(grep -E '^host-record=[^,]+,[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]*$' "$RD_CONF" 2>/dev/null | tail -n 1)"
  [ -n "$line" ] || return 1
  line="${line#host-record=}"
  [ -n "$rd_desired_fqdn" ] || rd_desired_fqdn="${line%%,*}"
  if [ -z "$rd_desired_ip" ]; then
    rd_desired_ip="${line##*,}"
    rd_desired_ip="${rd_desired_ip%%[[:space:]]*}"
  fi
  [ -n "$rd_desired_fqdn" ] && [ -n "$rd_desired_ip" ]
}

# --- host facts ---------------------------------------------------------------
# Interface currently holding <ip>; empty when the address is not on this host.
rd_iface_for_ip() { # <ip>
  "$RD_IP_BIN" -o -4 addr show to "$1" 2>/dev/null | awk 'NR==1 { print $2 }'
}

rd_ip_present() { # <ip>
  [ -n "$(rd_iface_for_ip "$1")" ]
}

# Is something bound to <ip>:53? This is the exact shape of the failure --
# `bind-interfaces` means an unlisted address is simply never bound, and the
# connector's dial gets ECONNREFUSED.
#
# Scans every field rather than pinning a column: `ss` shifts the local-address
# column between versions and flag combinations (-p appends a process column,
# the header row splits "Local Address:Port" across fields), and the peer
# column is only ever "0.0.0.0:*"/"[::]:*", so it can never collide with the
# address being matched. A WILDCARD bind serves the address too — that is not
# what bind-interfaces produces, but a box switched to bind-dynamic is still
# correctly listening and must not be reported broken.
rd_listener_bound() { # <ip>
  "$RD_SS_BIN" -lun 2>/dev/null | awk -v a="$1:53" '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == a || $i == "0.0.0.0:53" || $i == "*:53") { found = 1; exit }
      }
    }
    END { exit found ? 0 : 1 }
  '
}

# Does dnsmasq actually ANSWER for the name at that address? A bound socket
# that SERVFAILs is still a broken origin. Best-effort: a box without dig or
# nslookup falls back to the bind check alone rather than inventing a verdict.
#   0 answered | 1 did not answer | 2 no query tool available
rd_answers() { # <fqdn> <ip>
  local out
  if command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=2 +tries=1 "@$2" "$1" A 2>/dev/null)"
    [ -n "$out" ] && return 0
    return 1
  fi
  if command -v nslookup >/dev/null 2>&1; then
    nslookup -timeout=2 "$1" "$2" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 2
}

# The listen-address the managed block currently pins (empty if none).
rd_managed_listen_ip() {
  [ -r "$RD_CONF" ] || return 0
  awk -v b="$RD_BEGIN" -v e="$RD_END" '
    $0 == b { inb = 1; next }
    $0 == e { inb = 0; next }
    inb && /^listen-address=/ { sub(/^listen-address=/, ""); print; exit }
  ' "$RD_CONF" 2>/dev/null
}

# =============================================================================
# check
# =============================================================================
rd_check() {
  if ! rd_resolve_desired; then
    rd_log "NOT_APPLICABLE: no managed host-record in $RD_CONF and no DROPLET_PUBLIC_FQDN/_IP in env — this box has no split-horizon FQDN to serve"
    return 3
  fi
  if ! rd_ip_present "$rd_desired_ip"; then
    # Not repairable, and not a lie: dnsmasq cannot bind an address the host
    # does not hold. Naming it beats reporting broken forever.
    rd_log "NOT_APPLICABLE: $rd_desired_ip (the address $rd_desired_fqdn resolves to) is not assigned to any interface on this host — nothing can listen on it"
    return 3
  fi
  if ! rd_listener_bound "$rd_desired_ip"; then
    rd_log "BROKEN: nothing is bound to $rd_desired_ip:53, but dnsmasq hands out $rd_desired_fqdn -> $rd_desired_ip. The relay dials this address for every off-site lookup and gets connection refused."
    return 1
  fi
  rd_answers "$rd_desired_fqdn" "$rd_desired_ip"
  case $? in
    0) rd_log "OK: $rd_desired_ip:53 is bound and answers for $rd_desired_fqdn"; return 0 ;;
    1) rd_log "BROKEN: $rd_desired_ip:53 is bound but returned no answer for $rd_desired_fqdn"; return 1 ;;
    *) rd_log "OK: $rd_desired_ip:53 is bound for $rd_desired_fqdn (no dig/nslookup on this host — bind check only)"; return 0 ;;
  esac
}

# =============================================================================
# repair
# =============================================================================
# Rewrite the conf with the managed block set to <ip>/<iface>, or removed when
# <ip> is empty. Emits the new file on stdout; never writes in place.
rd_render_conf() { # <ip> <iface>
  awk -v b="$RD_BEGIN" -v e="$RD_END" -v ip="$1" -v ifn="$2" '
    $0 == b { inb = 1; next }
    $0 == e { inb = 0; next }
    !inb { print }
    END {
      if (ip != "") {
        print ""
        print b
        print "listen-address=" ip
        if (ifn != "") print "no-dhcp-interface=" ifn
        print e
      }
    }
  ' "$RD_CONF"
}

# Render the managed block for <ip>/<iface>, validate it, back the live conf up
# and install it. Nothing is written until dnsmasq itself accepts the result.
#
# Deliberately NOT a `rd_render_conf | rd_install_conf` pipeline: every element
# of a bash pipeline runs in a subshell, so $rd_backup set in there would be
# lost to the caller and rollback would silently have nothing to restore --
# exactly when it is needed most.
rd_backup=""
rd_apply_conf() { # <ip> <iface>
  local tmp
  tmp="$(mktemp -t droplet-relay-dns.XXXXXX 2>/dev/null || mktemp)" || return 1
  if ! rd_render_conf "$1" "$2" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! "$RD_DNSMASQ" --test --conf-file="$tmp" >/dev/null 2>&1; then
    rd_err "refusing to install: dnsmasq --test rejected the rendered config"
    rm -f "$tmp"
    return 1
  fi
  rd_backup="${RD_CONF}.bak-relay-dns-$(date -u +%Y%m%d%H%M%S)"
  cp -p "$RD_CONF" "$rd_backup" 2>/dev/null || rd_backup=""
  if ! cat "$tmp" > "$RD_CONF"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 644 "$RD_CONF" 2>/dev/null || true
  rm -f "$tmp"
  return 0
}

rd_restart_unit() {
  "$RD_SYSTEMCTL" restart "$RD_UNIT" >/dev/null 2>&1
}

rd_unit_active() {
  [ "$("$RD_SYSTEMCTL" is-active "$RD_UNIT" 2>/dev/null)" = "active" ]
}

rd_rollback() {
  [ -n "$rd_backup" ] && [ -f "$rd_backup" ] || return 1
  cat "$rd_backup" > "$RD_CONF" 2>/dev/null || return 1
  rd_restart_unit
  rd_log "rolled back $RD_CONF from $rd_backup"
  return 0
}

rd_settle() {
  local i=0
  while [ "$i" -lt "$RD_SETTLE_S" ]; do
    rd_unit_active && return 0
    i=$((i + 1))
    sleep 1
  done
  rd_unit_active
}

rd_repair() {
  if ! rd_resolve_desired; then
    rd_log "NOT_APPLICABLE: nothing to repair — no managed host-record and no DROPLET_PUBLIC_FQDN/_IP"
    return 3
  fi
  if [ ! -w "$RD_CONF" ]; then
    rd_err "cannot write $RD_CONF (run as root)"
    return 1
  fi

  # --- reverse heal: the managed block names an address that is gone --------
  # Under bind-interfaces that combination keeps the unit dead. Strip it and
  # bring the host DNS/DHCP plane back, even though it costs relay DNS.
  local pinned
  pinned="$(rd_managed_listen_ip)"
  if [ -n "$pinned" ] && ! rd_ip_present "$pinned"; then
    rd_log "managed listener pins $pinned, which is no longer on this host — stripping it so $RD_UNIT can start"
    if rd_apply_conf "" "" && rd_restart_unit && rd_settle; then
      rd_log "REPAIRED: removed the stale listener; $RD_UNIT is active again"
      return 0
    fi
    rd_err "FAILED: could not bring $RD_UNIT back after stripping the stale listener"
    rd_rollback >/dev/null 2>&1
    return 1
  fi

  if ! rd_ip_present "$rd_desired_ip"; then
    rd_log "NOT_APPLICABLE: $rd_desired_ip is not on this host — refusing to add a listen-address dnsmasq cannot bind"
    return 3
  fi

  # Already correct? Then the fault is not the conf — say so instead of
  # restarting the DNS plane for nothing.
  if rd_listener_bound "$rd_desired_ip"; then
    rd_log "no conf change needed: $rd_desired_ip:53 is already bound"
    return 0
  fi

  local iface
  iface="$(rd_iface_for_ip "$rd_desired_ip")"
  rd_log "asserting listen-address=$rd_desired_ip (interface ${iface:-unknown}) for $rd_desired_fqdn"
  if ! rd_apply_conf "$rd_desired_ip" "$iface"; then
    rd_err "FAILED: could not install the repaired config"
    return 1
  fi
  if ! rd_restart_unit || ! rd_settle; then
    rd_err "FAILED: $RD_UNIT did not come back after the change — rolling back"
    rd_rollback >/dev/null 2>&1
    return 1
  fi
  if ! rd_listener_bound "$rd_desired_ip"; then
    rd_err "FAILED: $RD_UNIT is active but $rd_desired_ip:53 is still not bound — rolling back"
    rd_rollback >/dev/null 2>&1
    return 1
  fi
  rd_log "REPAIRED: $rd_desired_ip:53 is bound; the relay's DNS origin answers again (backup: ${rd_backup:-none})"
  return 0
}

rd_main() {
  case "${1:-}" in
    check)  rd_check ;;
    repair) rd_repair ;;
    -h | --help) rd_usage; return 0 ;;
    "") rd_usage >&2; return 2 ;;
    *) rd_err "unknown subcommand: $1"; rd_usage >&2; return 2 ;;
  esac
}

# Source-able for tests (helpers unit-testable in isolation).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rd_main "$@"
  exit $?
fi
