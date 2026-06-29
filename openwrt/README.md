# Droplet OpenWrt

This directory holds the Droplet OpenWrt assets: the **in-container single-box
AP image** (the active, shipping path) and the **OpenWrt overlay files** shared
between deployment shapes.

> **Legacy router image retired (ADR-011).** The historical multi-box deployment
> ran OpenWrt on a separate **bare-metal router host** flashed from a custom
> SD-card image (`openwrt/build.sh`). That bare-metal router image-build +
> flash machinery has been removed — the shipping product is the **single-box**
> shape, which runs OpenWrt **in a container** on the appliance host. The
> overlay files under `files/` and the in-container image under
> `singlebox-image/` are what remain in use.

## How the AP runs today (single-box, in-container)

On the single-box shape the appliance host owns a Wi-Fi radio; the host's PHY is
moved into the OpenWrt container's network namespace and the container runs
`hostapd` to serve the AP. The container image is built from
[`singlebox-image/Dockerfile`](singlebox-image/Dockerfile) (compose service
`openwrt`, profile `single-box`) and bakes the AP/router packages (hostapd, iw,
wpad, umdns, wireguard, uhttpd/rpcd, DDNS) so a fresh container never depends on
a first-boot `opkg install`.

- The routing service (`services/routing/`) reaches the container's ubus
  JSON-RPC over `127.0.0.1:8181` on the host network.
- The bootstrap sequence (moving the PHY into the netns, attaching, the rpcd
  ACL safety net) lives in
  [`scripts/host/usr-local-sbin/droplet-openwrt-attach`](../scripts/host/usr-local-sbin/droplet-openwrt-attach).

The single-box image COPYs three things from this directory at build time:

| Source | Why |
|---|---|
| `files/usr/share/rpcd/acl.d/droplet-ai.json` | Canonical ubus ACL — without it even root sessions are denied `file`/`umdns` reads (the network tab + DDNS step 500). Shared source of truth. |
| `singlebox-image/uci-defaults/60-droplet-uhttpd-limits` | Raises uhttpd `max_requests` so the orchestrator's network-summary fan-out doesn't get connections reset. |
| `singlebox-image/uci-defaults/61-droplet-upnp-default` | Seeds a disabled-by-default `upnpd` config so the dashboard UPnP / NAT-PMP card reads `available:true` / `enabled:false` (miniupnpd ships in the image; the SDK degrades a missing config to "not available"). |

It does **not** consume `files/etc/config/*` or `files/etc/uci-defaults/99-droplet-setup`
— the in-container wireless config is created at runtime.

## Integration with the platform

The routing service (`services/routing/`) talks to OpenWrt's ubus JSON-RPC. The
connection flow:

```
Orchestrator (openwrt.client.ts)
   -> Routing service (services/routing/, FastAPI :8080)
      -> DropletRouter SDK (droplet_openwrt_sdk.py)
         -> HTTP POST /ubus  →  OpenWrt (127.0.0.1:8181 single-box)
```

The `droplet-ai` rpcd user (or `root` on single-box) matches the credentials
expected by:
- `services/routing/main.py` — via `OPENWRT_USERNAME` / `OPENWRT_PASSWORD`
- `services/routing/droplet_openwrt_sdk.py` — the Python SDK
- `apps/orchestrator/src/services/openwrt.client.ts` — the orchestrator client

## Overlay files (`files/`)

These are the OpenWrt UCI configs + first-boot script for the **legacy
bare-metal router image overlay**. They are retained because the rpcd ACL is the
canonical source shared with the single-box image, and the configs document the
network/firewall/camera-VLAN model. They are **not** applied to the single-box
container's `/etc/config` (which is a runtime named volume).

```
openwrt/
├── README.md                           # This file
├── singlebox-image/                    # In-container single-box AP image (ACTIVE)
│   ├── Dockerfile
│   └── uci-defaults/
│       ├── 60-droplet-uhttpd-limits
│       └── 61-droplet-upnp-default     # UPnP/NAT-PMP off-by-default seed
├── files/                              # OpenWrt overlay (legacy router image)
│   ├── etc/config/
│   │   ├── network                     # WAN/LAN/bridge + camera VLAN 100
│   │   ├── wireless                    # MT7922 5 GHz AP (legacy router image)
│   │   ├── firewall                    # NAT, zones, rules + camera isolation
│   │   ├── dhcp                        # DHCP (LAN + camera subnet)
│   │   ├── uhttpd                      # Web server + ubus endpoint
│   │   ├── rpcd                        # RPC daemon + droplet-ai user
│   │   └── system                      # Hostname, NTP, LEDs
│   ├── etc/droplet/
│   │   └── droplet-ai-password         # AI agent RPC password
│   ├── etc/uci-defaults/
│   │   └── 99-droplet-setup            # First-boot setup script (legacy router)
│   └── usr/share/rpcd/acl.d/
│       └── droplet-ai.json             # ubus API permissions (shared w/ single-box)
└── scripts/
    ├── setup-camera-subnet.sh          # Standalone camera VLAN setup
    ├── upgrade-router.sh               # OpenWrt sysupgrade (in-place firmware update)
    ├── router-connect.py               # Connection test & monitor
    └── droplet-router-monitor.service  # systemd unit for the appliance host
```

## Camera subnet (VLAN 100)

The overlay configs ship a pre-configured isolated subnet for IP cameras:

| Setting | Value |
|---------|-------|
| VLAN | 100 on br-lan |
| Interface | `cameras` (192.168.100.1/24) |
| DHCP pool | 192.168.100.100 — 192.168.100.249 |
| Firewall zone | `cameras` (REJECT input, REJECT forward) |
| LAN → cameras | ACCEPT (Droplet RTSP/ONVIF access) |
| cameras → LAN | REJECT (users can't browse camera feeds) |
| cameras → WAN | ACCEPT (NTP, DNS, firmware updates) |

Cameras plugged into VLAN 100 ports are isolated from the main network. Only the
Droplet appliance can reach them.

## Upgrading an OpenWrt router (in-place sysupgrade)

`scripts/upgrade-router.sh` pushes an OpenWrt sysupgrade image to a running
router and flashes it, preserving UCI config (`/etc/config/*`). This is a
generic OpenWrt mechanism — useful for any reachable OpenWrt router host.

```bash
./scripts/upgrade-router.sh output/openwrt-*-sysupgrade.img.gz
```

UCI configs are preserved across sysupgrade — WiFi, firewall, DHCP, camera VLAN
all stay intact.

Options:
- `--no-preserve` — clean flash with new defaults
- `--dry-run` — upload only, don't flash
- `--apply-defaults` — re-run uci-defaults scripts after upgrade
- `--host <ip>` — router IP (default: `OPENWRT_HOST` or `192.168.50.1`)
- `--force` — skip the firmware-filename sanity check

### Adding the camera VLAN to an existing router (no firmware flash)

```bash
scp openwrt/scripts/setup-camera-subnet.sh root@<router>:/tmp/
ssh root@<router> 'sh /tmp/setup-camera-subnet.sh'
```

The script is idempotent and supports `--status`, `--remove`, `--dry-run`,
`--vlan-id <id>`, and `--subnet <ip>`.

## OpenWrt version

The single-box container image is based on `openwrt/rootfs:x86_64-24.10.2`.
