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
  # string, so a multi-line value is rejected. Mirrors the WARP-994 fix to
  # droplet-set-public-fqdn.sh and the WARP-988 fix to droplet-set-box-name.sh.
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
_discover_host_lan_ip() {
  local target_ip="${OPENWRT_HOST:-192.168.50.1}"
  local ip=""

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get "$target_ip" 2>/dev/null \
            | awk '/src/ {for (i=1; i<=NF; i++) if ($i == "src") { print $(i+1); exit }}')"
  fi

  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    # hostname -I prints a space-separated list; take the first non-loopback.
    ip="$(hostname -I 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i !~ /^127\./ && $i ~ /\./) { print $i; exit }}')"
  fi

  printf '%s' "$ip"
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
  local service_dir="/etc/avahi/services"
  local service_path="${service_dir}/droplet.service"
  # Minimal avahi installs (e.g. --no-install-recommends on a very slim base)
  # can ship without the services/ dir. Create it defensively so the tee
  # below doesn't fail on a missing parent.
  sudo mkdir -p "$service_dir"
  # Writing atomically via tee-from-stdin so we don't need a temp file and
  # partial writes are impossible.
  sudo tee "$service_path" >/dev/null <<'XML'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!--
  Droplet Edge Platform — Avahi service advertisement.
  Managed by scripts/lib/local-dns.sh; re-run ./scripts/setup.sh to refresh.
-->
<service-group>
  <name replace-wildcards="yes">Droplet (%h)</name>
  <service>
    <type>_http._tcp</type>
    <port>80</port>
  </service>
  <service>
    <type>_https._tcp</type>
    <port>443</port>
  </service>
  <!-- Network drive: puts the box in macOS Finder's Network browser/sidebar.
       smbd itself is the compose `samba` service (host network, :445, `linux`
       profile) — the host daemon only advertises; if the samba container is
       down, connecting fails but nothing else breaks. Windows discovery is
       wsdd2 inside that same container, not avahi. -->
  <service>
    <type>_smb._tcp</type>
    <port>445</port>
  </service>
  <!-- Finder device icon (cosmetic): _device-info is a TXT-only pseudo
       service; port 0 is the convention for it. -->
  <service>
    <type>_device-info._tcp</type>
    <port>0</port>
    <txt-record>model=Xserve</txt-record>
  </service>
</service-group>
XML
  sudo chmod 644 "$service_path"
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

# =============================================================================
# ADR-023 (C3): split-horizon DNS for the opaque per-device FQDN
# =============================================================================
# The publicly-trusted per-device FQDN `d-<hmac>.devices.warp-lab.ai` has NO
# public A/AAAA record (the box's home IP is never published). It resolves to
# the box via SPLIT HORIZON:
#   - LAN clients using the OpenWrt router's DNS  -> the box's LAN IP, via the
#     SAME routing-service POST /dhcp/hostnames mechanism setup_router_dns uses.
#   - WireGuard tunnel clients -> 192.168.20.1 (the WG gateway), because the
#     rendered peer .conf's DNS= already points at 192.168.20.1.
# So the one FQDN works at home AND over the tunnel, with a green padlock.
#
# Registers the FQDN against 192.168.20.1 (the gateway address that is reachable
# both on the single-box LAN and over the tunnel). On a multi-box LAN the
# operator can override DROPLET_PUBLIC_FQDN_IP if the box's LAN IP differs.
DROPLET_PUBLIC_FQDN="${DROPLET_PUBLIC_FQDN:-}"
DROPLET_PUBLIC_FQDN_IP="${DROPLET_PUBLIC_FQDN_IP:-192.168.20.1}"

# Host dnsmasq config for the at-home single-box LAN plane (ADR-018-transitional).
# Today's single-box LAN clients lease DNS from the host dnsmasq instance
# (scripts/host/etc-droplet-host-net/lan-dhcp.conf), NOT the OpenWrt
# container's. So the routing-service host-record above does not reach them; we
# ALSO write a MANAGED host-record line into the host dnsmasq config. This whole
# leg is retired when ADR-018 unifies the network onto the OpenWrt plane.
_HOST_DNSMASQ_CONF="/etc/droplet-host-net/lan-dhcp.conf"
_HOST_RECORD_MARKER="# ADR-023 managed host-record (split-horizon FQDN) — do not edit by hand"

setup_public_fqdn_dns() {
  if [ -z "$DROPLET_PUBLIC_FQDN" ]; then
    # The box hasn't learned its FQDN from HQ yet — nothing to register. The
    # bootstrap self-signed cert + .lan/.local names keep the box reachable.
    log_info "Skipping public-FQDN DNS (DROPLET_PUBLIC_FQDN not set yet)"
    return 0
  fi

  if ! _valid_hostname "$DROPLET_PUBLIC_FQDN"; then
    log_error "DROPLET_PUBLIC_FQDN='${DROPLET_PUBLIC_FQDN}' is not a valid hostname — refusing to register split-horizon DNS"
    return 0
  fi

  # --- Leg 1: OpenWrt dnsmasq via the routing service (LAN + tunnel) ---
  local routing_mode="${ROUTING_MODE:-real}"
  if [ "$routing_mode" = "disabled" ]; then
    log_info "Skipping public-FQDN router-DNS registration (ROUTING_MODE=disabled)"
  else
    local routing_url="${ROUTING_SERVICE_URL:-http://localhost:8080}"
    local token="${ROUTING_SERVICE_TOKEN:-}"
    if ! curl -sf --max-time 5 "${routing_url}/health" >/dev/null 2>&1; then
      log_warn "Routing service not responding at ${routing_url} — ${DROPLET_PUBLIC_FQDN} will resolve once routing is back"
    else
      local auth_header=()
      [ -n "$token" ] && auth_header=(-H "Authorization: Bearer ${token}")
      local payload
      payload=$(printf '{"hostname":"%s","ip":"%s"}' "$DROPLET_PUBLIC_FQDN" "$DROPLET_PUBLIC_FQDN_IP")
      local resp_file=""
      resp_file="$(mktemp -t droplet-fqdn-resp.XXXXXX 2>/dev/null || mktemp)"
      trap 'rm -f "${resp_file:-}"' RETURN
      local http_code
      http_code="$(curl -sS --max-time 10 -o "$resp_file" -w "%{http_code}" \
                     -X POST "${routing_url}/dhcp/hostnames" \
                     -H "Content-Type: application/json" \
                     "${auth_header[@]}" \
                     --data "$payload" 2>>"$LOG_FILE" || echo "000")"
      case "$http_code" in
        200) log_success "Split-horizon DNS: ${_CYAN}${DROPLET_PUBLIC_FQDN}${_RESET} → ${DROPLET_PUBLIC_FQDN_IP} (OpenWrt dnsmasq)" ;;
        *)   log_warn "Public-FQDN router-DNS registration returned HTTP ${http_code}: $(cat "$resp_file" 2>/dev/null || true)" ;;
      esac
    fi
  fi

  # --- Leg 2: host dnsmasq host-record (ADR-018-transitional) ---
  _write_host_dnsmasq_record
}

# Add (idempotently) a MANAGED host-record line to the host dnsmasq config so
# at-home single-box LAN clients (which lease DNS from the host dnsmasq, not the
# OpenWrt container) resolve the FQDN until ADR-018 retires the host plane.
# ADR-018-TRANSITIONAL — delete this leg when the host network plane is gone.
_write_host_dnsmasq_record() {
  if [ ! -f "$_HOST_DNSMASQ_CONF" ]; then
    # No host dnsmasq plane on this box (multi-box / dev) — the routing-service
    # leg above covers it.
    return 0
  fi

  local desired="host-record=${DROPLET_PUBLIC_FQDN},${DROPLET_PUBLIC_FQDN_IP}"

  # Already present + current? No-op (keeps re-runs clean — no dnsmasq restart).
  if grep -qxF "$desired" "$_HOST_DNSMASQ_CONF" 2>/dev/null; then
    log_info "Host dnsmasq host-record already current for ${DROPLET_PUBLIC_FQDN}"
    return 0
  fi

  # WARP-985: under the device-bridge's sandbox (User=droplet +
  # NoNewPrivileges=true) sudo can never elevate, so every sudo below would
  # fail — previously silently, because the caller treats DNS registration as
  # best-effort. Detect the no-non-interactive-sudo environment up front and
  # defer honestly: the .env upsert already persisted the FQDN, so the next
  # root-context boot/setup run rewrites this record, and the routing-service
  # leg above still covers clients on the OpenWrt DNS plane.
  if ! sudo -n true 2>/dev/null; then
    log_warn "No non-interactive sudo here (sandboxed bridge?) — host dnsmasq host-record for ${DROPLET_PUBLIC_FQDN} deferred to the next boot/setup run"
    return 0
  fi

  # Strip any prior managed line(s) + their marker, then append the fresh pair.
  # sudo because the file is root-owned (installed by single-box.sh).
  local tmp
  tmp="$(mktemp -t droplet-hostdns.XXXXXX 2>/dev/null || mktemp)"
  sudo grep -vF "$_HOST_RECORD_MARKER" "$_HOST_DNSMASQ_CONF" 2>/dev/null \
    | grep -vE '^host-record=.*\.devices\.warp-lab\.ai,' > "$tmp" || true
  {
    printf '\n%s\n' "$_HOST_RECORD_MARKER"
    printf '%s\n' "$desired"
  } >> "$tmp"
  sudo cp "$tmp" "$_HOST_DNSMASQ_CONF"
  sudo chmod 644 "$_HOST_DNSMASQ_CONF"
  rm -f "$tmp"
  log_success "Host dnsmasq host-record: ${DROPLET_PUBLIC_FQDN} → ${DROPLET_PUBLIC_FQDN_IP} (ADR-018-transitional)"

  # Best-effort reload of the dedicated host dnsmasq so the record goes live now.
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl reload droplet-host-net.service 2>/dev/null \
      || sudo systemctl restart droplet-host-net.service 2>/dev/null || true
  fi
}

# =============================================================================
# Public entry point
# =============================================================================
setup_local_dns() {
  log_info "Configuring local DNS (mDNS + OpenWrt dnsmasq)..."
  setup_mdns
  setup_router_dns
  # ADR-023 (C3): register the split-horizon FQDN when the box knows its name.
  setup_public_fqdn_dns
}
