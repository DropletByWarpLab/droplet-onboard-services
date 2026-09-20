#!/usr/bin/env bash
# avahi-service.sh — render and install the box's Avahi (mDNS / DNS-SD)
# service advertisement (WARP-2941, ADR-008 §4, ADR-058 slice 4).
#
# The box advertises itself three ways to the LAN:
#
#   _http._tcp / _https._tcp   "Droplet (<host>)" — browsers and generic
#                              clients; what every Droplet advertised before
#                              this file existed.
#   _smb._tcp, _device-info    the network drive in Finder's sidebar.
#   _droplet._tcp              THE DISCOVERY TYPE the apps browse (droplet-
#                              windows lan_discovery.rs, then iOS/Android):
#                              a type, not a display string, with two TXT
#                              hints:
#                                fqdn=<DROPLET_PUBLIC_FQDN or empty>
#                                state=<bootstrap|issued>
#
# THE TXT RECORDS ARE UNAUTHENTICATED AND STAY HINTS. mDNS is whatever the
# LAN says it is; any host can answer. A client uses `fqdn=` only to skip the
# certificate peek and go straight to the fully verified probe pinned to the
# advertised address, and it never trusts `state=` for anything but wording
# ("still securing"). Identity comes from the handshake — a public chain for
# the FQDN, or the key the pairing pinned (WARP-2953) — never from here.
# Nothing non-public goes in TXT: no device id, no tokens. (Certificate
# Transparency already publishes the FQDN, so it is public by construction.)
#
# Two callers, one renderer:
#   1. scripts/lib/local-dns.sh (setup)   — first install of the file.
#   2. scripts/lib/tls-reload.sh          — every certificate swap, so
#      `state=issued` and `fqdn=` land in the same reload that starts
#      serving the new certificate.
#
# Sourceable standalone (the device-bridge host wrapper sources tls-reload.sh
# without setup's logging stack): no dependency on logging.sh or secrets.sh.
# `sudo` is only needed for the install step; rendering is pure.

if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { printf '%s\n' "$*"; }
  log_warn()    { printf 'WARN: %s\n' "$*" >&2; }
fi

# Where the file lives. Overridable so the test suite can write to a temp dir.
AVAHI_SERVICE_DIR="${AVAHI_SERVICE_DIR:-/etc/avahi/services}"
AVAHI_SERVICE_FILE="${AVAHI_SERVICE_FILE:-droplet.service}"

# avahi_xml_escape — the five XML predefined entities, `&` first so it is
# never double-escaped. TXT values are operator-influenced (.env), so they
# are escaped even though the validation below should never let a
# metacharacter through.
#
# sed, not `${s//x/&lt;}`: bash 5.2 turned on `patsub_replacement`, under
# which an unquoted `&` in the replacement means "the matched text" — the
# same expression that escapes correctly on bash 5.1 (WSL, older images)
# rendered `<` as `<lt;` on the 5.2 runner. sed's `\&` is portable.
avahi_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

# avahi_tls_state <cert_file> — `issued` when the served leaf was signed by a
# CA other than itself (issuer != subject, the same detector secrets.sh uses
# for "never clobber a public-CA leaf"), else `bootstrap`: self-signed,
# missing, or unreadable all mean "no public chain yet". Reads only the FIRST
# PEM block, so a fullchain is judged by its leaf.
avahi_tls_state() {
  local cert_file="${1:-}"
  if [ -z "$cert_file" ] || [ ! -f "$cert_file" ]; then
    printf 'bootstrap'
    return 0
  fi
  local issuer subject
  issuer="$(openssl x509 -in "$cert_file" -noout -issuer 2>/dev/null)"
  subject="$(openssl x509 -in "$cert_file" -noout -subject 2>/dev/null)"
  if [ -z "$issuer" ] || [ -z "$subject" ] \
     || [ "${issuer#issuer=}" = "${subject#subject=}" ]; then
    printf 'bootstrap'
  else
    printf 'issued'
  fi
}

# avahi_public_fqdn — DROPLET_PUBLIC_FQDN from the environment, else from
# $REPO_ROOT/.env (the tls-reload host wrapper has REPO_ROOT but not the
# sourced .env). Validated as a plain RFC-1123 name with [[ =~ ]] (whole-
# string, newline-safe — the same reasoning as local-dns.sh::_valid_hostname);
# anything else renders as empty rather than as a TXT record of junk.
avahi_public_fqdn() {
  local fqdn="${DROPLET_PUBLIC_FQDN:-}"
  if [ -z "$fqdn" ] && [ -n "${REPO_ROOT:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
    fqdn="$(grep -E '^DROPLET_PUBLIC_FQDN=' "$REPO_ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)"
    fqdn="${fqdn%\"}"; fqdn="${fqdn#\"}"
    fqdn="${fqdn%\'}"; fqdn="${fqdn#\'}"
  fi
  if [[ "$fqdn" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]; then
    printf '%s' "$fqdn"
  else
    printf ''
  fi
}

# avahi_service_xml <fqdn> <state> — the whole service file on stdout. Pure.
# The instance name keeps avahi's %h wildcard (the daemon's host-name, set by
# local-dns.sh), so the name stays "Droplet (droplet-ai)" on every type.
avahi_service_xml() {
  local fqdn state
  fqdn="$(avahi_xml_escape "${1:-}")"
  state="$(avahi_xml_escape "${2:-bootstrap}")"
  cat <<XML
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!--
  Droplet Edge Platform — Avahi service advertisement.
  Managed by scripts/lib/avahi-service.sh (setup: local-dns.sh; every
  certificate swap: tls-reload.sh). Hand edits are overwritten.

  The _droplet._tcp TXT records are UNAUTHENTICATED HINTS (WARP-2941):
  fqdn= lets a client skip the certificate peek; state= only words the
  connect screen. Neither is ever trusted for identity — the TLS handshake
  (public chain for the FQDN, or the key the pairing pinned) decides.
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
  <!-- ADR-008 §4: the discovery type the Droplet apps browse. -->
  <service>
    <type>_droplet._tcp</type>
    <port>443</port>
    <txt-record>fqdn=${fqdn}</txt-record>
    <txt-record>state=${state}</txt-record>
  </service>
  <!-- Network drive: puts the box in macOS Finder's Network browser/sidebar.
       smbd itself is the compose \`samba\` service (host network, :445, \`linux\`
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
}

# write_avahi_service_file [cert_file] — render for the current certificate
# and install it, only when the content changed. avahi-daemon watches the
# services directory (inotify) and re-reads a changed file on its own, so a
# rewrite is enough — no restart, and an unchanged file causes no churn.
# Returns 0 on success or when there is nothing to do; non-zero only when the
# install itself failed (the caller decides whether that is fatal — for
# tls-reload it never is: serving the new certificate matters more).
write_avahi_service_file() {
  local cert_file="${1:-${REPO_ROOT:-}/docker/certs/droplet.crt}"
  local target="${AVAHI_SERVICE_DIR}/${AVAHI_SERVICE_FILE}"
  local rendered
  rendered="$(avahi_service_xml "$(avahi_public_fqdn)" "$(avahi_tls_state "$cert_file")")"
  if [ -f "$target" ] && [ "$(cat "$target" 2>/dev/null)" = "$rendered" ]; then
    return 0
  fi
  # Minimal avahi installs (--no-install-recommends on a slim base) can ship
  # without the services/ dir. Create it so the tee below has a parent.
  sudo mkdir -p "$AVAHI_SERVICE_DIR" || return 1
  # tee-from-stdin: no temp file, and avahi sees one write.
  printf '%s\n' "$rendered" | sudo tee "$target" >/dev/null || return 1
  sudo chmod 644 "$target" || return 1
  log_info "avahi: advertisement refreshed ($target)"
  return 0
}
