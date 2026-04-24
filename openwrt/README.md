# Droplet OpenWrt Build System

Custom OpenWrt image for the Droplet router — Raspberry Pi 5 (bcm2712) with **MediaTek MT7922 WiFi 6** (PCIe over FPC) and TP-Link UE306 USB NIC.

> **WiFi card history:** This build was originally targeted at the Intel BE200 WiFi 7. The BE200 was a client-mode-only card on the Pi 5 — `iwlwifi` AP mode failed ACS ("Unable to collect survey data"). Swapped to the MT7922 in PR `feat/openwrt-mt7922-support`, validated live on hardware.

## Network Topology

```
ISP / Upstream         Pi 5 (OpenWrt)                  Jetson (AI)
     |                 |-- ETH0 (onboard) = WAN         |
     +--- cable -------+                                |
                       |-- ETH1 (USB RTL8153B) --+      |
                       |                         |-- br-lan -- 192.168.50.0/24
                       +-- WiFi MT7922 ----------+      |
                            5 GHz Wi-Fi 6 (HE80)        +--- 192.168.50.x
                                                         ubus JSON-RPC -> 192.168.50.1/ubus
```

- **WAN**: ETH0 (onboard BCM54213PE) — DHCP client from upstream
- **LAN**: ETH1 (TP-Link UE306 USB) + WiFi radios bridged as `br-lan` at `192.168.50.1/24`
- **WiFi**: MediaTek MT7922 on the FPC PCIe lane (`pcie@110000`), 5 GHz channel 149, HE80, WPA2 (`psk2` for Apple-device compatibility)
- **DHCP range**: `192.168.50.100` - `192.168.50.249`
- **API endpoint**: `http://192.168.50.1/ubus` (ubus JSON-RPC)

## Integration with the Platform

This build produces the router firmware that the platform's **routing service** (`services/routing/`) communicates with. The connection flow:

```
Jetson (services/routing/)                  Pi 5 (OpenWrt)
    |                                           |
    |  DropletRouter SDK (droplet_openwrt_sdk)  |
    |  -> HTTP POST /ubus                      |
    +----------------------------------------->|
    |                                           |
    |  FastAPI routing service (main.py)        |
    |  -> Orchestrator calls via REST           |
    |                                           |
    |  Orchestrator (openwrt.client.ts)         |
    |  -> Dashboard & AI gateway               |
```

The `droplet-ai` user created by this build matches the credentials expected by:
- `services/routing/main.py` — via `OPENWRT_USERNAME` / `OPENWRT_PASSWORD` env vars
- `services/routing/droplet_openwrt_sdk.py` — the Python SDK
- `apps/orchestrator/src/services/openwrt.client.ts` — the orchestrator HTTP client

## Quick Start

### 1. Build the Image (on Linux x86_64)

```bash
cd openwrt
chmod +x build.sh
./build.sh
```

### 2. Flash to SD Card

Use balenaEtcher, Raspberry Pi Imager, or `dd`:
```bash
gunzip -k output/openwrt-*.img.gz
sudo dd if=output/openwrt-*.img of=/dev/sdX bs=4M status=progress
```

### 3. First Boot

1. Insert SD card into Pi 5
2. Connect ETH0 (onboard) to upstream/ISP
3. Plug in TP-Link UE306 USB NIC
4. Power on — first boot takes ~60-90s

### 4. Verify from Jetson

```bash
# Set env vars (same ones used by the routing service)
export OPENWRT_HOST=192.168.50.1
export OPENWRT_USERNAME=droplet-ai
export OPENWRT_PASSWORD=DropletAI2024!

# Run connectivity test
python3 openwrt/scripts/jetson-router-connect.py

# Or install as persistent monitor
sudo cp openwrt/scripts/droplet-router-monitor.service /etc/systemd/system/
sudo systemctl enable --now droplet-router-monitor
```

## Default Credentials

| Account | Username | Password | Purpose |
|---------|----------|----------|---------|
| Root (SSH/LuCI) | `root` | *Generated at first boot* | Full system access |
| AI Agent (ubus) | `droplet-ai` | *Generated at first boot* | Jetson -> OpenWrt control |

Credentials are **unique per device** — generated randomly during first boot and stored in `/etc/droplet/`. Retrieve the AI agent password during Jetson provisioning:
```bash
ssh root@192.168.50.1 cat /etc/droplet/droplet-ai-password
```

## Camera Subnet (VLAN 100)

The image ships with a pre-configured isolated subnet for IP cameras:

| Setting | Value |
|---------|-------|
| VLAN | 100 on br-lan |
| Interface | `cameras` (192.168.100.1/24) |
| DHCP pool | 192.168.100.100 — 192.168.100.249 |
| Firewall zone | `cameras` (REJECT input, REJECT forward) |
| LAN → cameras | ACCEPT (Droplet RTSP/ONVIF access) |
| cameras → LAN | REJECT (users can't browse camera feeds) |
| cameras → WAN | ACCEPT (NTP, DNS, firmware updates) |

Cameras plugged into VLAN 100 ports are automatically isolated from the main network. Only the Droplet appliance can access them.

## Upgrading an Existing Router

### In-Place Sysupgrade (Preserves Config)

```bash
# Build the image (produces both SD card + sysupgrade images)
cd openwrt && ./build.sh

# Push firmware to the running router from any LAN device
./scripts/upgrade-router.sh output/openwrt-*-sysupgrade.img.gz
```

UCI configs (`/etc/config/*`) are preserved across sysupgrade — WiFi, firewall, DHCP, camera VLAN all stay intact.

Options:
- `--no-preserve` — clean flash with new defaults
- `--dry-run` — upload only, don't flash
- `--apply-defaults` — re-run uci-defaults scripts after upgrade (e.g., add new camera VLAN config)
- `--host <ip>` — specify router IP (default: `OPENWRT_HOST` or `10.0.0.1`)

### Adding Camera VLAN to Existing Router (No Firmware Flash)

```bash
scp openwrt/scripts/setup-camera-subnet.sh root@10.0.0.1:/tmp/
ssh root@10.0.0.1 'sh /tmp/setup-camera-subnet.sh'
```

The script is idempotent (safe to re-run) and supports:
- `--status` — show connected cameras and VLAN config
- `--remove` — tear down the camera subnet
- `--dry-run` — preview changes without applying
- `--vlan-id <id>` — custom VLAN ID (default: 100)
- `--subnet <ip>` — custom gateway IP (default: 192.168.100.1)

## File Structure

```
openwrt/
├── build.sh                            # Image builder (produces .img.gz + sysupgrade)
├── README.md                           # This file
├── files/                              # OpenWrt overlay (baked into image)
│   ├── etc/config/
│   │   ├── network                     # WAN/LAN/bridge + camera VLAN 100
│   │   ├── wireless                    # WiFi 7 tri-band AP
│   │   ├── firewall                    # NAT, zones, rules + camera isolation
│   │   ├── dhcp                        # DHCP (LAN + camera subnet)
│   │   ├── uhttpd                      # Web server + ubus endpoint
│   │   ├── rpcd                        # RPC daemon + droplet-ai user
│   │   └── system                      # Hostname, NTP, LEDs
│   ├── etc/droplet/
│   │   └── droplet-ai-password         # AI agent RPC password
│   ├── etc/uci-defaults/
│   │   └── 99-droplet-setup            # First-boot setup script
│   └── usr/share/rpcd/acl.d/
│       └── droplet-ai.json             # ubus API permissions for AI agent
├── scripts/
│   ├── setup-camera-subnet.sh          # Standalone camera VLAN setup for existing routers
│   ├── upgrade-router.sh               # Remote firmware upgrade (sysupgrade)
│   ├── jetson-router-connect.py        # Connection test & monitor
│   └── droplet-router-monitor.service  # systemd unit for Jetson
└── output/                             # Built images (gitignored)
```

## Hardware

| Component | Model | Driver | Notes |
|-----------|-------|--------|-------|
| SBC | Raspberry Pi 5 (bcm2712) | Built-in | 4GB+ RAM |
| WiFi | MediaTek MT7922 (M.2 → FPC PCIe) | `kmod-mt7921e` | Wi-Fi 6, dual-band capable, 5 GHz primary |
| USB NIC | TP-Link UE306 | `kmod-usb-net-rtl8152` | RTL8153B, Gigabit |

## MT7922 — required boot configuration

The MT7922 on the Pi 5's FPC PCIe lane will not enumerate without **all three** of the following. The first-boot script (`files/etc/uci-defaults/99-droplet-setup`) and the package list in `build.sh` handle them automatically — this section documents the *why* for anyone debugging:

1. **`dtoverlay=pcie-32bit-dma-pi5` in `/boot/config.txt`**
   Forces 32-bit DMA addressing on the external PCIe lane. The MT7922's mt7921e probe path allocates DMA-coherent ring buffers; without 32-bit-DMA bouncing through SWIOTLB, the chip can't address the buffers and the probe fails with `mt7921e: probe of 0000:01:00.0 failed with error -12` (`-ENOMEM`). The first-boot script appends this line idempotently.

2. **`mt7921e disable_aspm=1` in `/etc/modules.d/mt7921e`**
   Disables PCIe Active State Power Management L0s/L1 negotiation on this device. ASPM negotiation between mt7921e and the Pi 5's `brcm-pcie` host bridge is unreliable and can stall the probe. Per-device, no effect on RP1 or other PCIe devices.

3. **`kmod-mt7921e` + `kmod-mt7922-firmware` baked into the image** (`build.sh` package list)
   The driver and the MT7922-specific firmware blobs (`WIFI_MT7922_patch_mcu_1_1_hdr.bin` + `WIFI_RAM_CODE_MT7922_1.bin`) must be present at boot.

### MT7922 known limitations

- **TX power capped at ~3 dBm** on the in-image OpenWrt 24.10 mt76 driver. Channel 149 in US allows 30 dBm but the firmware regulatory state defaults to a conservative cap that doesn't lift even with `country=US` set in UCI. Coverage is room-scale; long-range clients should bridge through a downstream AP. Tracking as a follow-up — likely needs a newer mt76 driver via custom OpenWrt build.
- **WPA3 transition mode (`sae-mixed`) breaks Apple devices.** iPhones/iPads fail association in mixed mode. Stay on `psk2` (WPA2) for production; revisit when iOS WPA3 transition handling improves.
- **2.4 GHz radio is disabled by default** in `etc/config/wireless`. The MT7922 supports simultaneous dual-band but enabling 2.4 GHz adds beacon airtime; flip `wireless.radio3_2g.disabled=0` if you need a 2.4 GHz AP for legacy IoT devices.

## OpenWrt Version

Uses **OpenWrt 24.10.0** targeting `bcm27xx/bcm2712`.
