#!/usr/bin/env bash
# local-dns.sh — Make the Droplet reachable by name on the LAN.
#
# Two complementary mechanisms; failures in one don't block the other:
#
#   1. mDNS via Avahi (host-level): advertises `droplet.local` so Apple/Linux
#      clients and modern Windows (10+) resolve it with zero config. We install
#      and enable avahi-daemon on Linux hosts and drop a /etc/avahi/services
#      file describing the Droplet's HTTP/HTTPS endpoints. macOS hosts already
#      run mDNSResponder — we log a skip.
#
#   2. OpenWrt dnsmasq: posts a `droplet-ai.lan` → Droplet-IP entry to the routing
#      service so any device using the router's DNS (phones, IoT, TVs that
#      don't speak mDNS) resolves the Droplet too. We use `.lan` (not `.local`)
#      to avoid the unicast-vs-mDNS collision that breaks some resolvers when
#      both publish the same name.
#
# Idempotent. Re-run after IP changes to refresh the UCI entry.

# --- Config ---
# DROPLET_MDNS_HOSTNAME drives Avahi's host-name *and* the service file.
# DROPLET_LAN_HOSTNAME is the router-DNS entry (unicast DNS).
#
# Both default to `droplet-ai*` to avoid collisions with the OpenWrt router:
#   - mDNS: OpenWrt's umdns publishes `droplet.local` for the router itself,
#     so an Avahi claim of `droplet.local` on the appliance loses the tiebreak
#     and falls back to `droplet-2.local` — defeating the whole point.
#   - Router DNS: dnsmasq's `expand_hosts=1` makes the router's own hostname
#     (`Droplet`) resolve as `droplet.lan`, so a static hostrecord on
#     `droplet.lan` competes with it (round-robin) — clients land on the
#     router's web UI half the time instead of the dashboard.
# `droplet-ai*` matches the appliance's system hostname (`droplet-AI`) and has
# no such collision from anything else on the LAN.
DROPLET_MDNS_HOSTNAME="${DROPLET_MDNS_HOSTNAME:-droplet-ai}"
DROPLET_LAN_HOSTNAME="${DROPLET_LAN_HOSTNAME:-droplet-ai.lan}"

# Reject anything that isn't a plain RFC-1123 hostname before we pass the
# value to sed / printf / curl. This closes the door on metacharacters that
# could break /etc/avahi/avahi-daemon.conf or inject into the JSON payload,
# even though the env var is operator-controlled.
_valid_hostname() {
  local name="$1"
  # Single label (mDNS host-name) or dotted FQDN, 1-253 chars, no leading/
  # trailing hyphen per label, lowercase ASCII only.
  #
  # Matched with bash's [[ =~ ]] (whole-string, newline-safe) rather than a
  # `printf | grep -Eq` pipe — grep is LINE-based, so a newline-bearing value
  # like 'droplet-ai<LF>HostName=evil' would pass on its first line and the
  # injected second line would ride into /etc/avahi/avahi-daemon.conf (via the
  # sed in _set_avahi_host_name) or the dnsmasq host-record. In [[ =~ ]] the
  # char classes cannot match a newline and `$` anchors the end of the whole
  # string, so a multi-line value is rejected before writing DNS or mDNS config.
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]
}

if ! _valid_hostname "$DROPLET_MDNS_HOSTNAME"; then
  log_error "DROPLET_MDNS_HOSTNAME='${DROPLET_MDNS_HOSTNAME}' is not a valid hostname — refusing to configure mDNS"
  DROPLET_MDNS_HOSTNAME=""
fi
if ! _valid_hostname "$DROPLET_LAN_HOSTNAME"; then
  log_error "DROPLET_LAN_HOSTNAME='${DROPLET_LAN_HOSTNAME}' is not a valid hostname — refusing to register with dnsmasq"
  DROPLET_LAN_HOSTNAME=""
fi

# =============================================================================
# Helpers
# =============================================================================

# Discover the host's primary LAN IP. Prefers the route toward the OpenWrt
# router (OPENWRT_HOST) when set, falling back to the first non-loopback v4
# address returned by `hostname -I`. Stdout: the IP, or empty on failure.
_usable_lan_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local octet
  for octet in ${1//./ }; do
    [ "$((10#$octet))" -le 255 ] || return 1
  done
  local first="${1%%.*}"
  [ "$((10#$first))" -lt 224 ] || return 1
  case "$1" in 0.*|127.*|169.254.*) return 1 ;; esac
}

_discover_host_lan_ip() {
  local target_ip="${OPENWRT_HOST:-192.168.50.1}" ip=""
  case "$target_ip" in
    127.0.0.1|localhost|::1)
      # The bundled router proxies the dashboard on the shared LAN gateway.
      # route get 127.0.0.1 yields loopback, which clients cannot use.
      if command -v ip >/dev/null 2>&1; then
        ip="$(ip -4 -o addr show dev br-lan scope global 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1)"
      fi
      _usable_lan_ipv4 "$ip" || ip="192.168.20.1"
      printf '%s' "$ip"
      return 0 ;;
  esac
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get "$target_ip" 2>/dev/null \
      | awk '/src/ {for (i=1; i<=NF; i++) if ($i == "src") { print $(i+1); exit }}')"
    if _usable_lan_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
  fi
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null); do
      if _usable_lan_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
    done
  fi
  return 0
}

# =============================================================================
# mDNS (Avahi on the host)
# =============================================================================
_install_avahi_linux() {
  # Already installed and runnable? Nothing to do.
  if command -v avahi-daemon >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    log_warn "Non-apt Linux detected — install avahi-daemon and libnss-mdns manually to enable ${DROPLET_MDNS_HOSTNAME}.local"
    return 1
  fi

  log_info "Installing avahi-daemon + libnss-mdns..."
  # libnss-mdns lets local lookups (getent hosts droplet.local) succeed too,
  # not just tools that speak mDNS directly.
  # shellcheck disable=SC2024  # $LOG_FILE is operator-owned (writable by the calling user); the redirect runs as caller by design — chowning the log to root just to silence shellcheck would defeat the point.
  if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       avahi-daemon libnss-mdns >>"$LOG_FILE" 2>&1; then
    return 0
  fi

  log_warn "Could not install avahi-daemon via apt — skipping mDNS bootstrap"
  return 1
}

_write_avahi_service_file() {
  # WARP-2941: one renderer for setup and for every certificate swap
  # (scripts/lib/avahi-service.sh) — the `_droplet._tcp` entry carries
  # `fqdn=` / `state=` TXT hints that must follow the served certificate, so
  # the file is no longer a static heredoc here. Idempotent: an unchanged
  # rendering is not rewritten, and avahi re-reads a changed file itself.
  if ! declare -F write_avahi_service_file >/dev/null 2>&1; then
    # shellcheck source=avahi-service.sh
    source "$(dirname "${BASH_SOURCE[0]}")/avahi-service.sh"
  fi
  write_avahi_service_file "${REPO_ROOT:-}/docker/certs/droplet.crt" \
    || log_warn "mDNS: could not write the Avahi service file — the box will not advertise _droplet._tcp until the next setup run"
}

_set_avahi_host_name() {
  local conf="/etc/avahi/avahi-daemon.conf"
  [ -f "$conf" ] || return 0

  # Only rewrite when the value differs — keeps the diff empty on re-runs,
  # which in turn avoids a needless avahi restart.
  local current
  current="$(sudo awk -F'=' '/^[[:space:]]*host-name[[:space:]]*=/ {gsub(/[[:space:]]/,"",$2); print $2; exit}' "$conf")"
  if [ "$current" = "$DROPLET_MDNS_HOSTNAME" ]; then
    return 0
  fi

  log_info "Setting Avahi host-name to '${DROPLET_MDNS_HOSTNAME}'"
  if sudo grep -qE '^[[:space:]]*#?[[:space:]]*host-name[[:space:]]*=' "$conf"; then
    sudo sed -i -E "s|^[[:space:]]*#?[[:space:]]*host-name[[:space:]]*=.*|host-name=${DROPLET_MDNS_HOSTNAME}|" "$conf"
  else
    # Fresh conf with no host-name directive — append under [server].
    sudo sed -i "/^\[server\]/a host-name=${DROPLET_MDNS_HOSTNAME}" "$conf"
  fi
}

_restart_avahi() {
  if command -v systemctl >/dev/null 2>&1; then
    # shellcheck disable=SC2024  # $LOG_FILE is operator-owned (writable by the calling user); redirect-as-caller is the intended behaviour, same rationale as _install_avahi_packages above.
    sudo systemctl enable avahi-daemon >>"$LOG_FILE" 2>&1 || true
    # shellcheck disable=SC2024  # Same rationale: operator-owned log, caller-side redirect.
    if sudo systemctl restart avahi-daemon >>"$LOG_FILE" 2>&1; then
      return 0
    fi
    log_warn "systemctl restart avahi-daemon failed — check: systemctl status avahi-daemon"
    return 1
  fi

  if command -v service >/dev/null 2>&1; then
    # shellcheck disable=SC2024  # Same rationale: operator-owned log, caller-side redirect.
    sudo service avahi-daemon restart >>"$LOG_FILE" 2>&1 || true
    return 0
  fi

  log_warn "No systemctl or service command found — could not restart avahi-daemon"
  return 1
}

setup_mdns() {
  if [ -z "$DROPLET_MDNS_HOSTNAME" ]; then
    log_warn "Skipping mDNS bootstrap (hostname validation failed above)"
    return 0
  fi

  local os
  os="$(uname)"
  if [ "$os" != "Linux" ]; then
    log_info "Skipping mDNS bootstrap (non-Linux host — macOS already runs mDNSResponder)"
    return 0
  fi

  if ! _install_avahi_linux; then
    return 0  # already logged — don't fail setup just because mDNS is optional
  fi

  _set_avahi_host_name
  _write_avahi_service_file
  _restart_avahi || return 0

  log_success "mDNS: Droplet is reachable at ${_CYAN}${DROPLET_MDNS_HOSTNAME}.local${_RESET}"
}

# =============================================================================
# Router DNS (OpenWrt dnsmasq via routing service)
# =============================================================================
setup_router_dns() {
  if [ -z "$DROPLET_LAN_HOSTNAME" ]; then
    log_warn "Skipping router-DNS registration (hostname validation failed above)"
    return 0
  fi

  local ip
  ip="$(_discover_host_lan_ip)"
  if [ -z "$ip" ]; then
    log_warn "Could not determine host LAN IP — skipping ${DROPLET_LAN_HOSTNAME} registration"
    return 0
  fi

  # ROUTING_MODE=disabled is an explicit "skip router calls" flag from the
  # orchestrator side. Honour it here so dev machines without an OpenWrt don't
  # spam the log with 503s.
  local routing_mode="${ROUTING_MODE:-real}"
  if [ "$routing_mode" = "disabled" ]; then
    log_info "Skipping router-DNS registration (ROUTING_MODE=disabled)"
    return 0
  fi

  local routing_url="${ROUTING_SERVICE_URL:-http://localhost:8080}"
  local token="${ROUTING_SERVICE_TOKEN:-}"

  # Precheck: routing must be reachable before we attempt the write. A failed
  # health call is far less noisy than a failed POST with a truncated body.
  if ! curl -sf --max-time 5 "${routing_url}/health" >/dev/null 2>&1; then
    log_warn "Routing service not responding at ${routing_url} — skipping ${DROPLET_LAN_HOSTNAME} registration"
    log_warn "  (Try: docker compose -f docker/docker-compose.yml logs routing)"
    return 0
  fi

  local auth_header=()
  if [ -n "$token" ]; then
    auth_header=(-H "Authorization: Bearer ${token}")
  fi

  local payload
  payload=$(printf '{"hostname":"%s","ip":"%s"}' "$DROPLET_LAN_HOSTNAME" "$ip")

  # mktemp (not /tmp/$$.xxx) so the response file can't be a dangling symlink
  # pre-planted by another user on the host. `trap` guarantees cleanup even if
  # the script is interrupted mid-curl.
  #
  # RETURN-trap quirk: bash evaluates the trap body when the function
  # returns; under `set -u` accessing `$resp_file` errors with "unbound
  # variable" if the function returned before the mktemp assignment OR
  # if the trap fires in the caller's scope (older bash versions). Use
  # the `${var:-}` default-empty form so `rm -f ""` is a benign no-op
  # in either case. Surfaced by setup.sh failing at phase 7/7 on
  # droplet-sys after a factory-reset.
  local resp_file=""
  resp_file="$(mktemp -t droplet-dns-resp.XXXXXX 2>/dev/null || mktemp)"
  trap 'rm -f "${resp_file:-}"' RETURN

  local http_code
  http_code="$(curl -sS --max-time 10 -o "$resp_file" -w "%{http_code}" \
                 -X POST "${routing_url}/dhcp/hostnames" \
                 -H "Content-Type: application/json" \
                 "${auth_header[@]}" \
                 --data "$payload" 2>>"$LOG_FILE" || echo "000")"
  local body
  body="$(cat "$resp_file" 2>/dev/null || true)"

  case "$http_code" in
    200)
      log_success "Router DNS: ${_CYAN}${DROPLET_LAN_HOSTNAME}${_RESET} → ${ip} (via OpenWrt dnsmasq)"
      ;;
    503)
      log_warn "Router unreachable from routing service — ${DROPLET_LAN_HOSTNAME} will resolve once the router is back online"
      log_warn "  (Re-run: ./scripts/setup.sh to retry)"
      ;;
    401|403)
      log_warn "Routing service rejected auth (HTTP ${http_code}) — ROUTING_SERVICE_TOKEN may be stale"
      ;;
    500)
      # The routing service surfaces the underlying ubus error in `detail`.
      # 'Access denied' almost always means the droplet-ai rpcd ACL on the
      # running router is older than openwrt/files/usr/share/rpcd/acl.d/
      # droplet-ai.json — push that file to /usr/share/rpcd/acl.d/ on the
      # router (as root) and run `/etc/init.d/rpcd restart`.
      if printf '%s' "$body" | grep -qi 'Access denied'; then
        log_warn "Router DNS registration failed: rpcd ACL on the router is out of date"
        log_warn "  Fix (as router root): scp openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json \\"
        log_warn "         root@${OPENWRT_HOST:-192.168.50.1}:/usr/share/rpcd/acl.d/ && \\"
        log_warn "       ssh root@${OPENWRT_HOST:-192.168.50.1} /etc/init.d/rpcd restart"
      else
        log_warn "Router DNS registration returned HTTP 500: ${body}"
      fi
      ;;
    000)
      log_warn "Could not reach routing service — skipping router DNS registration"
      ;;
    *)
      log_warn "Router DNS registration returned HTTP ${http_code}: ${body}"
      ;;
  esac
}

# Add (idempotently) a MANAGED host-record line to the host dnsmasq config so
# at-home single-box LAN clients (which lease DNS from the host dnsmasq, not the
# OpenWrt container) resolve the internal name until ADR-018 retires the host plane.
# ADR-018-TRANSITIONAL — delete this leg when the host network plane is gone.
setup_host_dns() {
  [ -n "$DROPLET_LAN_HOSTNAME" ] || return 0
  local ip
  ip="$(_discover_host_lan_ip)"
  [ -n "$ip" ] || return 0
  _write_host_dnsmasq_record "$DROPLET_LAN_HOSTNAME" "$ip"
}

_HOST_DNSMASQ_CONF="${DROPLET_HOST_DNSMASQ_CONF:-/etc/droplet-host-net/lan-dhcp.conf}"
_HOST_RECORD_MARKER="# Droplet managed host-record (internal DNS) — do not edit by hand"

_write_host_dnsmasq_record() {
  local hostname="$1" ip="$2"
  if [ ! -f "$_HOST_DNSMASQ_CONF" ]; then
    # No host dnsmasq plane on this box (multi-box / dev) — the routing-service
    # leg above covers it.
    return 0
  fi

  local desired="host-record=${hostname},${ip}"

  # Already present + current? No-op (keeps re-runs clean — no dnsmasq restart).
  if grep -qxF "$desired" "$_HOST_DNSMASQ_CONF" 2>/dev/null; then
    log_info "Host dnsmasq host-record already current for ${hostname}"
    return 0
  fi

  # WARP-985: under the device-bridge's sandbox (User=droplet +
  # NoNewPrivileges=true) sudo can never elevate, so every sudo below would
  # fail — previously silently, because the caller treats DNS registration as
  # best-effort. Detect the no-non-interactive-sudo environment up front and
  # defer honestly: the configured internal hostname persists, so the next
  # root-context boot/setup run rewrites this record, and the routing-service
  # leg above still covers clients on the OpenWrt DNS plane.
  if ! sudo -n true 2>/dev/null; then
    log_warn "No non-interactive sudo here (sandboxed bridge?) — host dnsmasq host-record for ${hostname} deferred to the next boot/setup run"
    return 0
  fi

  # Strip any prior managed line(s) + their marker, then append the fresh pair.
  # sudo because the file is root-owned (installed by single-box.sh).
  local tmp
  tmp="$(mktemp -t droplet-hostdns.XXXXXX 2>/dev/null || mktemp)"
  # shellcheck disable=SC2024  # sudo reads the root-owned config; $tmp is caller-owned and intentionally written as caller.
  sudo awk -v marker="$_HOST_RECORD_MARKER" '
    $0 == marker || $0 == "# ADR-023 managed host-record (split-horizon FQDN) — do not edit by hand" { skip = 1; next }
    skip && /^host-record=/ { skip = 0; next }
    { skip = 0; print }
  ' "$_HOST_DNSMASQ_CONF" > "$tmp" || { rm -f "$tmp"; return 1; }
  {
    printf '\n%s\n' "$_HOST_RECORD_MARKER"
    printf '%s\n' "$desired"
  } >> "$tmp"
  sudo cp "$tmp" "$_HOST_DNSMASQ_CONF"
  sudo chmod 644 "$_HOST_DNSMASQ_CONF"
  rm -f "$tmp"
  log_success "Host dnsmasq host-record: ${hostname} → ${ip} (ADR-018-transitional)"

  # Best-effort reload of the dedicated host dnsmasq so the record goes live now.
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl reload droplet-host-net.service 2>/dev/null \
      || sudo systemctl restart droplet-host-net.service 2>/dev/null || true
  fi

  _rerender_gateway_llm_access "$ip"
}

# WARP-3452 — the gateway refuses /llm/ to host-originated traffic by the address
# in the record just written (docker/nginx/render-llm-access.sh reads it at
# container start). setup.sh starts the stack BEFORE this runs, so re-render a
# running gateway now. Best-effort, like reload_gateway_nginx (tls-reload.sh):
# a failure leaves the previous map, and a gateway restart re-renders it.
_rerender_gateway_llm_access() {
  local ip="$1"
  local compose_file="${REPO_ROOT:-}/docker/docker-compose.yml"
  if [ ! -f "$compose_file" ] || ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  docker compose -f "$compose_file" ps --services --filter status=running 2>/dev/null \
    | grep -qx gateway || return 0
  if docker compose -f "$compose_file" exec -T gateway \
       sh -c '/docker-entrypoint.d/04-llm-access.sh && nginx -s reload' >/dev/null 2>&1; then
    log_info "Gateway /llm/ source restriction re-rendered for ${ip}"
  else
    log_warn "Gateway /llm/ map not re-rendered — restart the gateway to pick up ${ip}"
  fi
  return 0
}

# =============================================================================
# Public entry point
# =============================================================================
setup_local_dns() {
  log_info "Configuring local DNS (mDNS + OpenWrt dnsmasq)..."
  setup_mdns
  setup_router_dns
  setup_host_dns
}
