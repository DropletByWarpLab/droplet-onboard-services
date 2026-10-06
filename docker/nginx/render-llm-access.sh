#!/bin/sh
# =============================================================================
# WARP-3452 — 04-llm-access.sh: the peers `location /llm/` refuses
# =============================================================================
# /llm/ (nginx.conf) hands employees' coding tools the box's model runtime. It
# is for the office LAN and the WireGuard VPN. Guest and host-originated
# traffic is restricted using the TCP peer
# address — into the `geo $llm_refused_source` map nginx.conf includes.
#
# * Guest Wi-Fi. droplet-openwrt-attach (guest_firewall_zone, plus the
#   192.168.30.0/24 nft masquerade out eth0) forwards guests to OpenWrt's
#   uplink, which on the single box is its docker veth on THIS compose
#   network. A guest who opens droplet.local, the FQDN or the box IP comes back
#   into the host from that bridge, and docker-proxy hands it to nginx from
#   this network's gateway: refused.
#
# An employee's device is none of these: LAN clients keep their own address
# through the published-port DNAT, and WireGuard clients come through OpenWrt.
# NOT closed here: a guest that targets a container address directly arrives
# as OpenWrt's own address, which nginx cannot tell from a WireGuard client —
# and could reach ai-gateway:8000 without nginx anyway. That isolation belongs
# in the OpenWrt guest zone. Also refused: a LAN client reaching :443 over
# IPv6, which docker-proxy relays from the gateway address too (the shipped
# names resolve to IPv4).
#
# Fails CLOSED — every /llm/ request answers 403 — when this network's gateway
# cannot be read. The image bakes that closed form (Dockerfile) until
# this runs. Runs at every container start; local-dns.sh re-runs it in a
# running gateway when it rewrites the host-record (a gateway restart does too).
# =============================================================================
set -u

OUT="${DROPLET_LLM_ACCESS_OUT:-/etc/nginx/llm-access.active.conf}"
ROUTES="${DROPLET_LLM_ACCESS_ROUTES:-/proc/net/route}"
HOST_DNS_CONF="${DROPLET_LLM_ACCESS_HOST_DNS_CONF:-/etc/droplet-host-net/lan-dhcp.conf}"
IPV4='[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'

BOX_IP="${DROPLET_LLM_BOX_IP:-}"
if [ -z "$BOX_IP" ]; then
  BOX_IP="$(grep -E "^host-record=[^,]+,${IPV4}[[:space:]]*\$" "$HOST_DNS_CONF" 2>/dev/null | tail -n 1 \
    | sed 's/^.*,//; s/[[:space:]]*$//')"
fi
printf '%s' "$BOX_IP" | grep -Eq "^${IPV4}\$" || BOX_IP=""

# /proc/net/route keeps addresses as little-endian hex: 010012AC = 172.18.0.1.
gw=""
gw_hex="$(awk 'NR > 1 && $2 == "00000000" { print $3; exit }' "$ROUTES" 2>/dev/null)"
case "$gw_hex" in
  [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f])
    # shellcheck disable=SC2046  # the four octets are meant to split
    set -- $(echo "$gw_hex" | sed 's/\(..\)\(..\)\(..\)\(..\)/\4 \3 \2 \1/')
    gw="$((0x$1)).$((0x$2)).$((0x$3)).$((0x$4))"
    ;;
esac

reason=""
[ -n "$gw" ] || reason="no default route in $ROUTES"

{
  echo "# RENDERED by /docker-entrypoint.d/04-llm-access.sh — DO NOT EDIT (WARP-3452)."
  echo 'geo $llm_refused_source {'
  if [ -z "$reason" ]; then
    echo '    default        0;'
    echo '    127.0.0.0/8    1;'
    echo '    192.168.20.1   1;'
    echo "    $gw   1;"
    if [ -n "$BOX_IP" ] && [ "$BOX_IP" != 192.168.20.1 ]; then
      echo "    $BOX_IP   1;"
    fi
  else
    echo '    default        1;'
  fi
  echo '}'
} > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"

if [ -z "$reason" ]; then
  echo "{\"event\":\"llm_access_render\",\"gateway\":\"nginx\",\"refused\":\"127.0.0.0/8 192.168.20.1 $gw${BOX_IP:+ $BOX_IP}\"}"
else
  echo "{\"event\":\"llm_access_render\",\"gateway\":\"nginx\",\"refused\":\"all\",\"reason\":\"$reason\"}"
fi
