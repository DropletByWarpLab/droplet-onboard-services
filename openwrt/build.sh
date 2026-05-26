#!/usr/bin/env bash
# =============================================================================
# Droplet OpenWrt Image Builder — Raspberry Pi 5 (bcm2712)
# Warp Lab Confidential
# =============================================================================
#
# Builds a custom OpenWrt SD-card image with:
#   - ETH0 (onboard) → WAN (DHCP client from upstream)
#   - ETH1 (TP-Link UE306 USB NIC, RTL8153B) → LAN bridge
#   - MediaTek MT7922 WiFi 6 (PCIe over FPC) → 5 GHz AP on LAN bridge
#   - LAN subnet: 192.168.50.1/24
#   - ubus JSON-RPC API preconfigured for Jetson AI control
#   - All drivers and firmware baked in
#
# WiFi note: this build was previously targeted at the Intel BE200 WiFi 7,
# but that card consistently failed AP-mode ACS on the Pi 5 brcm-pcie.
# Swapped to MT7922 (also PCIe FPC) which works reliably with the
# pcie-32bit-dma-pi5 device-tree overlay applied at first boot. See
# openwrt/files/etc/uci-defaults/99-droplet-setup for the dtoverlay
# install and openwrt/files/etc/modules.d/mt7921e for the disable_aspm=1
# module option that's also required.
#
# Usage:
#   chmod +x build.sh
#   ./build.sh
#
# Requirements:
#   - Linux x86_64 host (Ubuntu 22.04+ recommended)
#   - ~4 GB free disk space
#   - Internet connection (downloads ImageBuilder ~500 MB)
#
# Output:
#   ./output/  — contains the .img.gz file ready for flashing
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OWRT_VERSION="24.10.0"
OWRT_TARGET="bcm27xx"
OWRT_SUBTARGET="bcm2712"
IMAGEBUILDER_URL="https://downloads.openwrt.org/releases/${OWRT_VERSION}/targets/${OWRT_TARGET}/${OWRT_SUBTARGET}/openwrt-imagebuilder-${OWRT_VERSION}-${OWRT_TARGET}-${OWRT_SUBTARGET}.Linux-x86_64.tar.zst"
IMAGEBUILDER_DIR="openwrt-imagebuilder-${OWRT_VERSION}-${OWRT_TARGET}-${OWRT_SUBTARGET}.Linux-x86_64"

BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${BUILD_DIR}/output"
FILES_DIR="${BUILD_DIR}/files"

# Image profile for Raspberry Pi 5
PROFILE="rpi-5"

# ---------------------------------------------------------------------------
# Package list — everything baked into the image
# ---------------------------------------------------------------------------
PACKAGES=""

# --- Core networking ---
PACKAGES+=" ip-full iptables-nft kmod-nft-nat kmod-nft-offload"
PACKAGES+=" tc-full kmod-sched-core kmod-sched-cake"
PACKAGES+=" odhcpd-ipv6only dnsmasq-full -dnsmasq"

# --- USB NIC: TP-Link UE306 (RTL8153B chipset) ---
PACKAGES+=" kmod-usb-net kmod-usb-net-rtl8152"
PACKAGES+=" kmod-usb-core kmod-usb3 kmod-usb2 kmod-usb-dwc2"

# --- General USB & NIC drivers ---
PACKAGES+=" kmod-usb-net-cdc-ether kmod-usb-net-cdc-ncm kmod-usb-net-cdc-mbim"
PACKAGES+=" kmod-usb-net-asix kmod-usb-net-asix-ax88179"
PACKAGES+=" kmod-usb-net-aqc111"
PACKAGES+=" kmod-usb-storage kmod-usb-storage-uas"
PACKAGES+=" kmod-mii"

# --- MediaTek MT7922 (Wi-Fi 6, PCIe over FPC) ---
# kmod-mt7921e is the PCIe variant of the mt76 driver and handles BOTH
# MT7921 and MT7922 chips (same driver, different firmware blob).
# kmod-mt7922-firmware ships the MT7922-specific patch + RAM-code
# binaries the chip needs (WIFI_MT7922_patch_mcu_1_1_hdr.bin and
# WIFI_RAM_CODE_MT7922_1.bin under /lib/firmware/mediatek/).
#
# Without the dtoverlay=pcie-32bit-dma-pi5 from 99-droplet-setup, the
# probe will fail with -ENOMEM (error -12) on this Pi 5 build — see the
# wiki entry in openwrt/README.md for the diagnosis.
PACKAGES+=" kmod-mt7921e kmod-mt7922-firmware"
PACKAGES+=" kmod-mac80211 kmod-cfg80211"
PACKAGES+=" hostapd-openssl wpad-openssl -wpad-basic-mbedtls -wpad-basic-wolfssl"

# --- Wireless tools ---
PACKAGES+=" iw iwinfo wireless-regdb"

# --- VPN: WireGuard ---
PACKAGES+=" wireguard-tools kmod-wireguard luci-proto-wireguard"

# --- WARP-446: Band-steering daemon (per ADR-005) ---
# `dawn` is the OpenWrt-community choice for cross-AP 802.11k/v/r
# coordination. Chosen over `usteer` because dawn's defaults work
# with Apple's RSSI hysteresis; usteer's defaults deauth iPhones
# every ~30s under our hardware profile. See docs/ADR-005.
#
# Same package installs on both the main router and every extender
# AP — the daemon's UDP multicast (port 1025) does the cross-AP
# coordination at runtime; no per-AP role config.
PACKAGES+=" dawn"

# --- Dynamic DNS (DuckDNS for the WireGuard endpoint hostname) ---
# DuckDNS runs through the generic GET-URL path so no provider-specific
# extension is required. The routing service writes a `ddns` UCI section
# pointing at https://www.duckdns.org/update?domains=...&token=...&ip=.
PACKAGES+=" ddns-scripts luci-app-ddns"

# --- OpenWrt management ---
PACKAGES+=" opkg luci luci-ssl luci-app-firewall luci-app-opkg"
PACKAGES+=" luci-theme-openwrt-2020"

# --- ubus JSON-RPC API (Jetson ↔ OpenWrt control plane) ---
PACKAGES+=" uhttpd uhttpd-mod-ubus rpcd rpcd-mod-iwinfo"
PACKAGES+=" luci-mod-rpc"

# --- System utilities ---
PACKAGES+=" htop nano curl wget-ssl ca-bundle"
# openssh-sftp-server removed — unnecessary attack surface
PACKAGES+=" usbutils pciutils lsblk"
PACKAGES+=" diffutils coreutils-stat"
PACKAGES+=" bash"

# --- Diagnostics & monitoring ---
PACKAGES+=" tcpdump ethtool mtr-nojson"
PACKAGES+=" collectd collectd-mod-interface collectd-mod-load collectd-mod-memory"
PACKAGES+=" luci-app-statistics"

# --- VLAN support ---
PACKAGES+=" kmod-8021q"

# --- mDNS (so Jetson can discover router as droplet-router.local) ---
PACKAGES+=" umdns"

# ---------------------------------------------------------------------------
# Step 1: Download ImageBuilder
# ---------------------------------------------------------------------------
echo "============================================="
echo " Droplet OpenWrt Image Builder"
echo " Target: ${OWRT_TARGET}/${OWRT_SUBTARGET}"
echo " OpenWrt: ${OWRT_VERSION}"
echo "============================================="
echo ""

cd "${BUILD_DIR}"

if [ ! -d "${IMAGEBUILDER_DIR}" ]; then
    echo "[1/4] Downloading OpenWrt ImageBuilder..."
    if command -v wget &>/dev/null; then
        wget -q --show-progress "${IMAGEBUILDER_URL}" -O imagebuilder.tar.zst
    else
        curl -L --progress-bar "${IMAGEBUILDER_URL}" -o imagebuilder.tar.zst
    fi

    echo "[1/4] Extracting ImageBuilder..."
    if command -v zstd &>/dev/null; then
        tar --use-compress-program=unzstd -xf imagebuilder.tar.zst
    else
        # Fallback: try tar's built-in zstd support
        tar -xf imagebuilder.tar.zst
    fi
    rm -f imagebuilder.tar.zst
else
    echo "[1/4] ImageBuilder already present, skipping download."
fi

# ---------------------------------------------------------------------------
# Step 2: Validate our custom files overlay
# ---------------------------------------------------------------------------
echo "[2/4] Validating custom files overlay..."

REQUIRED_FILES=(
    "etc/config/network"
    "etc/config/wireless"
    "etc/config/firewall"
    "etc/config/dhcp"
    "etc/config/uhttpd"
    "etc/config/rpcd"
    "etc/config/system"
    "usr/share/rpcd/acl.d/droplet-ai.json"
    "etc/droplet/droplet-ai-password"
    "etc/uci-defaults/99-droplet-setup"
)

MISSING=0
for f in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "${FILES_DIR}/${f}" ]; then
        echo "  ✗ MISSING: files/${f}"
        MISSING=1
    else
        echo "  ✓ files/${f}"
    fi
done

if [ "${MISSING}" -eq 1 ]; then
    echo ""
    echo "ERROR: Missing required overlay files. Aborting."
    exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Step 3: Build the image
# ---------------------------------------------------------------------------
echo "[3/4] Building OpenWrt image with custom packages and config..."
echo "       This may take several minutes..."
echo ""

cd "${IMAGEBUILDER_DIR}"

make image \
    PROFILE="${PROFILE}" \
    PACKAGES="${PACKAGES}" \
    FILES="${FILES_DIR}" \
    EXTRA_IMAGE_NAME="droplet" \
    2>&1 | tee "${BUILD_DIR}/build.log"

# ---------------------------------------------------------------------------
# Step 4: Collect output
# ---------------------------------------------------------------------------
echo ""
echo "[4/4] Collecting output images..."

mkdir -p "${OUTPUT_DIR}"

# Collect SD card image (.img.gz)
cp -v bin/targets/${OWRT_TARGET}/${OWRT_SUBTARGET}/*-droplet-*.img.gz "${OUTPUT_DIR}/" 2>/dev/null || \
cp -v bin/targets/${OWRT_TARGET}/${OWRT_SUBTARGET}/*.img.gz "${OUTPUT_DIR}/" 2>/dev/null || true

# Collect sysupgrade image (.img.gz with "sysupgrade" in name) for in-place updates
cp -v bin/targets/${OWRT_TARGET}/${OWRT_SUBTARGET}/*sysupgrade*.img.gz "${OUTPUT_DIR}/" 2>/dev/null || true
# Also copy .itb format if produced (some targets use this)
cp -v bin/targets/${OWRT_TARGET}/${OWRT_SUBTARGET}/*sysupgrade*.itb "${OUTPUT_DIR}/" 2>/dev/null || true

cd "${BUILD_DIR}"

SYSUPGRADE_FILE=$(ls "${OUTPUT_DIR}"/*sysupgrade* 2>/dev/null | head -1 || true)

echo ""
echo "============================================="
echo " BUILD COMPLETE"
echo "============================================="
echo ""
echo " Output images:"
ls -lh "${OUTPUT_DIR}"/*.img.gz 2>/dev/null || echo "  (no .img.gz found — check build.log)"
ls -lh "${OUTPUT_DIR}"/*sysupgrade* 2>/dev/null || true
echo ""
echo " Fresh install (new SD card):"
echo "   1. Flash:  gunzip -k output/*.img.gz && sudo dd if=output/*.img of=/dev/sdX bs=4M status=progress"
echo "   2. Or use balenaEtcher / Raspberry Pi Imager (supports .img.gz directly)"
echo "   3. Insert SD card into Pi 5, boot, connect WAN to ETH0, LAN via USB NIC"
echo "   4. Pi will be reachable at 192.168.50.1 on the LAN"
echo ""
if [ -n "${SYSUPGRADE_FILE}" ]; then
echo " In-place upgrade (existing OpenWrt):"
echo "   1. From LAN:  ./scripts/upgrade-router.sh ${SYSUPGRADE_FILE}"
echo "   2. Or manual:  scp ${SYSUPGRADE_FILE} root@10.0.0.1:/tmp/"
echo "                  ssh root@10.0.0.1 'sysupgrade -v /tmp/$(basename "${SYSUPGRADE_FILE}")'"
echo "   3. UCI configs (/etc/config/*) are preserved across upgrades"
echo "   4. New defaults (camera VLAN, etc.) apply via /etc/uci-defaults/ on next boot"
echo ""
fi
echo ""
