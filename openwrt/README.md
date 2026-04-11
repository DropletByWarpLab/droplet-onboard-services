# Droplet OpenWrt Build System

Custom OpenWrt image for the Droplet router — Raspberry Pi 5 (bcm2712) with Intel BE200 WiFi 7 and TP-Link UE306 USB NIC.

## Network Topology

```
ISP / Upstream         Pi 5 (OpenWrt)                  Jetson (AI)
     |                 |-- ETH0 (onboard) = WAN         |
     +--- cable -------+                                |
                       |-- ETH1 (USB RTL8153B) --+      |
                       |                         |-- br-lan -- 192.168.50.0/24
                       +-- WiFi BE200 -----------+      |
                            2.4G / 5G / 6G              +--- 192.168.50.x
                                                         ubus JSON-RPC -> 192.168.50.1/ubus
```

- **WAN**: ETH0 (onboard BCM54213PE) — DHCP client from upstream
- **LAN**: ETH1 (TP-Link UE306 USB) + WiFi radios bridged as `br-lan` at `192.168.50.1/24`
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
| Root (SSH/LuCI) | `root` | `DropletAdmin2024!` | Full system access |
| AI Agent (ubus) | `droplet-ai` | `DropletAI2024!` | Jetson -> OpenWrt control |

**Change these before production deployment.** Edit `files/etc/droplet/droplet-ai-password` and `files/etc/uci-defaults/99-droplet-setup`.

## File Structure

```
openwrt/
├── build.sh                            # Image builder script (Pi 5 / bcm2712)
├── README.md                           # This file
├── files/                              # OpenWrt overlay (baked into image)
│   ├── etc/config/
│   │   ├── network                     # WAN/LAN/bridge config
│   │   ├── wireless                    # WiFi 7 tri-band AP
│   │   ├── firewall                    # NAT, zones, rules
│   │   ├── dhcp                        # DHCP server config
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
│   ├── jetson-router-connect.py        # Connection test & monitor
│   └── droplet-router-monitor.service  # systemd unit for Jetson
└── output/                             # Built images (gitignored)
```

## Hardware

| Component | Model | Driver | Notes |
|-----------|-------|--------|-------|
| SBC | Raspberry Pi 5 (bcm2712) | Built-in | 4GB+ RAM |
| WiFi | Intel BE200 (M.2) | `kmod-iwlwifi` | WiFi 7 tri-band |
| USB NIC | TP-Link UE306 | `kmod-usb-net-rtl8152` | RTL8153B, Gigabit |

## OpenWrt Version

Uses **OpenWrt 24.10.0** targeting `bcm27xx/bcm2712`.
