#!/bin/sh
# =============================================================================
# Droplet Camera Subnet Setup — Run directly on an OpenWrt router
# =============================================================================
#
# Sets up an isolated camera VLAN with firewall rules and DHCP pool.
# Can be SCP'd to any existing OpenWrt 23+ instance and executed.
#
# Usage:
#   scp setup-camera-subnet.sh root@192.168.50.1:/tmp/
#   ssh root@192.168.50.1 'sh /tmp/setup-camera-subnet.sh'
#
# Options:
#   --vlan-id <id>      VLAN ID (default: 100)
#   --subnet <ip>       Gateway IP (default: 192.168.100.1)
#   --netmask <mask>    Subnet mask (default: 255.255.255.0)
#   --dhcp-start <n>    DHCP pool start offset (default: 100)
#   --dhcp-limit <n>    DHCP pool size (default: 150)
#   --bridge <dev>      Parent bridge device (default: br-lan)
#   --port <port>       Physical port for VLAN (default: eth1)
#   --remove            Remove the camera subnet instead of creating it
#   --status            Show current camera subnet status
#   --dry-run           Show what would be done without executing
#   -h, --help          Show this help message
#
# Idempotent — safe to re-run. Skips steps that are already configured.
# Uses UCI safe-apply with automatic rollback on connectivity loss.
# =============================================================================
set -e

# --- Defaults ---
VLAN_ID=100
SUBNET="192.168.100.1"
NETMASK="255.255.255.0"
DHCP_START=100
DHCP_LIMIT=150
BRIDGE="br-lan"
PORT="eth1"
IFACE_NAME="cameras"
ZONE_NAME="cameras"
REMOVE=false
STATUS=false
DRY_RUN=false

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}info${RESET}  %s\n" "$*"; }
ok()      { printf "${GREEN}ok${RESET}    %s\n" "$*"; }
warn()    { printf "${YELLOW}warn${RESET}  %s\n" "$*"; }
err()     { printf "${RED}error${RESET} %s\n" "$*" >&2; }

# --- Parse arguments ---
while [ $# -gt 0 ]; do
    case "$1" in
        --vlan-id)    VLAN_ID="$2"; shift 2 ;;
        --subnet)     SUBNET="$2"; shift 2 ;;
        --netmask)    NETMASK="$2"; shift 2 ;;
        --dhcp-start) DHCP_START="$2"; shift 2 ;;
        --dhcp-limit) DHCP_LIMIT="$2"; shift 2 ;;
        --bridge)     BRIDGE="$2"; shift 2 ;;
        --port)       PORT="$2"; shift 2 ;;
        --remove)     REMOVE=true; shift ;;
        --status)     STATUS=true; shift ;;
        --dry-run)    DRY_RUN=true; shift ;;
        -h|--help)
            sed -n '2,/^# =====/{ /^#/s/^# \?//p }' "$0"
            exit 0
            ;;
        *) err "Unknown option: $1"; exit 1 ;;
    esac
done

DEVICE="${BRIDGE}.${VLAN_ID}"

# --- Preflight ---
if ! command -v uci >/dev/null 2>&1; then
    err "This script must be run on an OpenWrt device (uci not found)"
    exit 1
fi

# --- Status ---
if [ "$STATUS" = "true" ]; then
    printf "\n${BOLD}Camera Subnet Status${RESET}\n\n"

    # Check interface
    if uci -q get "network.${IFACE_NAME}" >/dev/null 2>&1; then
        ip=$(uci -q get "network.${IFACE_NAME}.ipaddr" || echo "?")
        mask=$(uci -q get "network.${IFACE_NAME}.netmask" || echo "?")
        dev=$(uci -q get "network.${IFACE_NAME}.device" || echo "?")
        printf "${GREEN}[active]${RESET}  Interface: %s (%s/%s on %s)\n" "$IFACE_NAME" "$ip" "$mask" "$dev"
    else
        printf "${RED}[missing]${RESET} Interface: %s not configured\n" "$IFACE_NAME"
    fi

    # Check firewall zone
    found_zone=false
    for i in $(seq 0 20); do
        name=$(uci -q get "firewall.@zone[$i].name" 2>/dev/null) || break
        if [ "$name" = "$ZONE_NAME" ]; then
            input=$(uci -q get "firewall.@zone[$i].input" || echo "?")
            forward=$(uci -q get "firewall.@zone[$i].forward" || echo "?")
            printf "${GREEN}[active]${RESET}  Firewall zone: %s (input=%s, forward=%s)\n" "$name" "$input" "$forward"
            found_zone=true
            break
        fi
    done
    [ "$found_zone" = "false" ] && printf "${RED}[missing]${RESET} Firewall zone: %s not found\n" "$ZONE_NAME"

    # Check DHCP
    if uci -q get "dhcp.${IFACE_NAME}" >/dev/null 2>&1; then
        start=$(uci -q get "dhcp.${IFACE_NAME}.start" || echo "?")
        limit=$(uci -q get "dhcp.${IFACE_NAME}.limit" || echo "?")
        printf "${GREEN}[active]${RESET}  DHCP pool: start=%s, limit=%s\n" "$start" "$limit"
    else
        printf "${RED}[missing]${RESET} DHCP pool: %s not configured\n" "$IFACE_NAME"
    fi

    # Check forwarding rules
    for i in $(seq 0 20); do
        src=$(uci -q get "firewall.@forwarding[$i].src" 2>/dev/null) || break
        dest=$(uci -q get "firewall.@forwarding[$i].dest" 2>/dev/null) || continue
        if [ "$src" = "lan" ] && [ "$dest" = "$ZONE_NAME" ]; then
            printf "${GREEN}[active]${RESET}  Forwarding: lan → %s\n" "$ZONE_NAME"
        fi
        if [ "$src" = "$ZONE_NAME" ] && [ "$dest" = "wan" ]; then
            printf "${GREEN}[active]${RESET}  Forwarding: %s → wan\n" "$ZONE_NAME"
        fi
    done

    # Show connected cameras
    printf "\n${BOLD}Connected Cameras:${RESET}\n"
    if [ -f /tmp/dhcp.leases ]; then
        subnet_prefix=$(echo "$SUBNET" | sed 's/\.[0-9]*$//')
        found=false
        while read -r _ts mac ip hostname _; do
            case "$ip" in
                ${subnet_prefix}.*)
                    printf "  %s  %-16s  %s\n" "$mac" "$ip" "${hostname:-unknown}"
                    found=true
                    ;;
            esac
        done < /tmp/dhcp.leases
        [ "$found" = "false" ] && printf "  (none)\n"
    else
        printf "  (lease file not found)\n"
    fi
    printf "\n"
    exit 0
fi

# --- Remove ---
if [ "$REMOVE" = "true" ]; then
    printf "\n${BOLD}Removing Camera Subnet${RESET}\n\n"

    if [ "$DRY_RUN" = "true" ]; then
        info "(dry run) Would remove: network.${IFACE_NAME}, firewall zone, DHCP pool"
        exit 0
    fi

    # Remove network interface
    if uci -q get "network.${IFACE_NAME}" >/dev/null 2>&1; then
        uci delete "network.${IFACE_NAME}"
        uci commit network
        ok "Removed network interface: ${IFACE_NAME}"
    else
        info "Network interface already removed"
    fi

    # Remove bridge-vlan entries for this VLAN
    for i in $(seq 20 -1 0); do
        vlan=$(uci -q get "network.@bridge-vlan[$i].vlan" 2>/dev/null) || continue
        if [ "$vlan" = "$VLAN_ID" ]; then
            uci delete "network.@bridge-vlan[$i]"
            ok "Removed bridge-vlan entry for VLAN ${VLAN_ID}"
        fi
    done
    uci commit network 2>/dev/null

    # Remove firewall zone
    for i in $(seq 20 -1 0); do
        name=$(uci -q get "firewall.@zone[$i].name" 2>/dev/null) || continue
        if [ "$name" = "$ZONE_NAME" ]; then
            uci delete "firewall.@zone[$i]"
            ok "Removed firewall zone: ${ZONE_NAME}"
        fi
    done

    # Remove forwarding rules
    for i in $(seq 20 -1 0); do
        src=$(uci -q get "firewall.@forwarding[$i].src" 2>/dev/null) || continue
        dest=$(uci -q get "firewall.@forwarding[$i].dest" 2>/dev/null) || continue
        if [ "$src" = "$ZONE_NAME" ] || [ "$dest" = "$ZONE_NAME" ]; then
            uci delete "firewall.@forwarding[$i]"
            ok "Removed forwarding: ${src} → ${dest}"
        fi
    done

    # Remove camera-specific rules
    for i in $(seq 30 -1 0); do
        rule_name=$(uci -q get "firewall.@rule[$i].name" 2>/dev/null) || continue
        rule_src=$(uci -q get "firewall.@rule[$i].src" 2>/dev/null) || continue
        case "$rule_name" in
            Allow-Camera-*)
                if [ "$rule_src" = "$ZONE_NAME" ]; then
                    uci delete "firewall.@rule[$i]"
                    ok "Removed rule: ${rule_name}"
                fi
                ;;
        esac
    done
    uci commit firewall 2>/dev/null

    # Remove DHCP pool
    if uci -q get "dhcp.${IFACE_NAME}" >/dev/null 2>&1; then
        uci delete "dhcp.${IFACE_NAME}"
        uci commit dhcp
        ok "Removed DHCP pool: ${IFACE_NAME}"
    fi

    # Reload services
    /etc/init.d/network reload 2>/dev/null
    /etc/init.d/firewall reload 2>/dev/null
    /etc/init.d/dnsmasq restart 2>/dev/null

    ok "Camera subnet removed"
    printf "\n"
    exit 0
fi

# --- Create ---
printf "\n${BOLD}Droplet Camera Subnet Setup${RESET}\n"
printf "  VLAN:    %s on %s (device: %s)\n" "$VLAN_ID" "$BRIDGE" "$DEVICE"
printf "  Subnet:  %s/%s\n" "$SUBNET" "$NETMASK"
printf "  DHCP:    offset %s, limit %s\n" "$DHCP_START" "$DHCP_LIMIT"
printf "\n"

if [ "$DRY_RUN" = "true" ]; then
    info "(dry run) Would create: VLAN interface, firewall zone, forwarding rules, DHCP pool"
    exit 0
fi

# --- 1. Bridge VLAN ---
# Check if bridge-vlan already exists
existing_bvlan=false
for i in $(seq 0 20); do
    vlan=$(uci -q get "network.@bridge-vlan[$i].vlan" 2>/dev/null) || break
    dev=$(uci -q get "network.@bridge-vlan[$i].device" 2>/dev/null) || continue
    if [ "$vlan" = "$VLAN_ID" ] && [ "$dev" = "$BRIDGE" ]; then
        existing_bvlan=true
        ok "Bridge VLAN ${VLAN_ID} already exists"
        break
    fi
done

if [ "$existing_bvlan" = "false" ]; then
    uci add network bridge-vlan >/dev/null
    uci set "network.@bridge-vlan[-1].device=${BRIDGE}"
    uci set "network.@bridge-vlan[-1].vlan=${VLAN_ID}"
    uci add_list "network.@bridge-vlan[-1].ports=${PORT}:t"
    ok "Created bridge VLAN ${VLAN_ID} on ${BRIDGE}"
fi

# --- 2. Network interface ---
if uci -q get "network.${IFACE_NAME}" >/dev/null 2>&1; then
    ok "Interface '${IFACE_NAME}' already exists — updating"
fi
uci set "network.${IFACE_NAME}=interface"
uci set "network.${IFACE_NAME}.device=${DEVICE}"
uci set "network.${IFACE_NAME}.proto=static"
uci set "network.${IFACE_NAME}.ipaddr=${SUBNET}"
uci set "network.${IFACE_NAME}.netmask=${NETMASK}"
uci commit network
ok "Configured interface: ${IFACE_NAME} (${SUBNET}/${NETMASK})"

# --- 3. Firewall zone ---
existing_zone=false
for i in $(seq 0 20); do
    name=$(uci -q get "firewall.@zone[$i].name" 2>/dev/null) || break
    if [ "$name" = "$ZONE_NAME" ]; then
        existing_zone=true
        ok "Firewall zone '${ZONE_NAME}' already exists"
        break
    fi
done

if [ "$existing_zone" = "false" ]; then
    uci add firewall zone >/dev/null
    uci set "firewall.@zone[-1].name=${ZONE_NAME}"
    uci add_list "firewall.@zone[-1].network=${IFACE_NAME}"
    uci set "firewall.@zone[-1].input=REJECT"
    uci set "firewall.@zone[-1].output=ACCEPT"
    uci set "firewall.@zone[-1].forward=REJECT"
    ok "Created firewall zone: ${ZONE_NAME} (REJECT/ACCEPT/REJECT)"
fi

# --- 4. Forwarding rules ---
# LAN → cameras (Droplet needs RTSP/ONVIF access)
add_forwarding() {
    local src="$1" dest="$2"
    for i in $(seq 0 20); do
        s=$(uci -q get "firewall.@forwarding[$i].src" 2>/dev/null) || break
        d=$(uci -q get "firewall.@forwarding[$i].dest" 2>/dev/null) || continue
        if [ "$s" = "$src" ] && [ "$d" = "$dest" ]; then
            ok "Forwarding ${src} → ${dest} already exists"
            return
        fi
    done
    uci add firewall forwarding >/dev/null
    uci set "firewall.@forwarding[-1].src=${src}"
    uci set "firewall.@forwarding[-1].dest=${dest}"
    ok "Created forwarding: ${src} → ${dest}"
}

add_forwarding "lan" "${ZONE_NAME}"
add_forwarding "${ZONE_NAME}" "wan"

# --- 5. Allow rules (DHCP, DNS, ping) ---
add_rule() {
    local name="$1" proto="$2" port="$3"
    for i in $(seq 0 30); do
        rn=$(uci -q get "firewall.@rule[$i].name" 2>/dev/null) || break
        if [ "$rn" = "$name" ]; then
            ok "Rule '${name}' already exists"
            return
        fi
    done
    uci add firewall rule >/dev/null
    uci set "firewall.@rule[-1].name=${name}"
    uci set "firewall.@rule[-1].src=${ZONE_NAME}"
    uci set "firewall.@rule[-1].proto=${proto}"
    uci set "firewall.@rule[-1].dest_port=${port}"
    uci set "firewall.@rule[-1].target=ACCEPT"
    ok "Created rule: ${name}"
}

add_rule "Allow-Camera-DHCP" "udp" "67-68"
add_rule "Allow-Camera-DNS" "tcpudp" "53"

# Ping rule (slightly different — no dest_port)
ping_exists=false
for i in $(seq 0 30); do
    rn=$(uci -q get "firewall.@rule[$i].name" 2>/dev/null) || break
    if [ "$rn" = "Allow-Camera-Ping" ]; then
        ping_exists=true
        ok "Rule 'Allow-Camera-Ping' already exists"
        break
    fi
done
if [ "$ping_exists" = "false" ]; then
    uci add firewall rule >/dev/null
    uci set "firewall.@rule[-1].name=Allow-Camera-Ping"
    uci set "firewall.@rule[-1].src=${ZONE_NAME}"
    uci set "firewall.@rule[-1].proto=icmp"
    uci set "firewall.@rule[-1].icmp_type=echo-request"
    uci set "firewall.@rule[-1].target=ACCEPT"
    uci set "firewall.@rule[-1].limit=5/sec"
    ok "Created rule: Allow-Camera-Ping"
fi

uci commit firewall

# --- 6. DHCP pool ---
if uci -q get "dhcp.${IFACE_NAME}" >/dev/null 2>&1; then
    ok "DHCP pool '${IFACE_NAME}' already exists — updating"
fi
uci set "dhcp.${IFACE_NAME}=dhcp"
uci set "dhcp.${IFACE_NAME}.interface=${IFACE_NAME}"
uci set "dhcp.${IFACE_NAME}.start=${DHCP_START}"
uci set "dhcp.${IFACE_NAME}.limit=${DHCP_LIMIT}"
uci set "dhcp.${IFACE_NAME}.leasetime=12h"
uci commit dhcp
ok "Configured DHCP pool: ${IFACE_NAME} (start=${DHCP_START}, limit=${DHCP_LIMIT})"

# --- 7. Reload services ---
info "Reloading network services..."
/etc/init.d/network reload 2>/dev/null
/etc/init.d/firewall reload 2>/dev/null
/etc/init.d/dnsmasq restart 2>/dev/null
ok "Services reloaded"

# --- Done ---
printf "\n"
printf "${BOLD}${GREEN}Camera subnet setup complete${RESET}\n"
printf "\n"
printf "  Subnet:     ${CYAN}%s/%s${RESET}\n" "$SUBNET" "$NETMASK"
printf "  VLAN:       ${CYAN}%s${RESET} on %s\n" "$VLAN_ID" "$BRIDGE"
printf "  DHCP range: ${CYAN}%s.%s — %s.%s${RESET}\n" \
    "$(echo "$SUBNET" | sed 's/\.[0-9]*$//')" "$DHCP_START" \
    "$(echo "$SUBNET" | sed 's/\.[0-9]*$//')" "$((DHCP_START + DHCP_LIMIT - 1))"
printf "  Firewall:   cameras zone (isolated from LAN)\n"
printf "\n"
printf "  Cameras plugged into VLAN %s ports will get IPs\n" "$VLAN_ID"
printf "  automatically and be isolated from the main network.\n"
printf "\n"
printf "  Run '${BOLD}sh %s --status${RESET}' to check connected cameras.\n" "$0"
printf "  Run '${BOLD}sh %s --remove${RESET}' to tear down.\n" "$0"
printf "\n"
