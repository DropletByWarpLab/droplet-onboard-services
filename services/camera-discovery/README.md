# Camera Discovery Service

Automatic detection of IP cameras on the network via ONVIF WS-Discovery and RTSP port probing. When a camera is found, it's auto-configured in Frigate NVR and published to the dashboard via MQTT.

## How It Works

```
DHCP Leases (router) ──→ Camera Discovery ──→ Frigate Config API
ONVIF WS-Discovery ─────┘      │
                               ↓
                         MQTT: droplet/cameras/discovered
                               ↓
                         Orchestrator → Dashboard (real-time)
```

1. **Poll DHCP leases** from the routing service every 30s
2. **ONVIF WS-Discovery** multicast scan for cameras announcing on the LAN
3. **RTSP port probe** — scan ports 554, 8554, 80, 8080 on candidate IPs
4. **ONVIF device probe** — query manufacturer, model, stream URI
5. **Auto-configure** — push camera config to Frigate NVR via its API
6. **Publish** discovery event on MQTT for the orchestrator to relay to clients

## Security

- **IP validation** — only probes RFC 1918 private addresses (10.x, 172.16-31.x, 192.168.x). Rejects loopback, link-local, multicast, and public IPs.
- **Subnet filtering** — when `CAMERA_SUBNET` is set (default: `192.168.100.0/24`), only scans that subnet. Prevents probing devices on the main LAN. `CAMERA_SUBNET=auto` (WARP-1805, the single-box provisioning default) resolves the network from the edge router at scan time via the routing service's `/network/interfaces`, so the filter follows the LAN that actually hands cameras their DHCP leases instead of a provision-time constant that goes stale when the fabric moves. While auto is unresolved (routing service unreachable), the sweep stays off and candidates are gated to private (RFC 1918) IPs only — discovery degrades, never widens.
- **RTSP URL validation** — validates scheme (`rtsp://`/`rtsps://`) and host before passing to Frigate.
- **Driver fix auth** — the `/drivers/fix` endpoint (which runs `modprobe`) requires `DEVICE_SECRET` bearer token.
- **ONVIF probes are read-only** — only calls `GetDeviceInformation` and `GetStreamUri`, never modifies camera config.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service + Frigate connectivity status |
| GET | `/cameras/discovered` | Pending cameras (not yet in Frigate) |
| GET | `/cameras/known` | Active cameras (configured in Frigate) |
| POST | `/cameras/discovered/{mac}/accept` | Accept camera into Frigate |
| POST | `/cameras/discovered/{mac}/reject` | Reject camera (won't rediscover) |
| POST | `/scan` | Manually trigger a discovery scan |
| GET | `/subnet/status` | Which subnet is being scanned |
| GET | `/drivers` | Camera driver status report (kernel modules, V4L2, USB) |
| POST | `/drivers/fix` | Auto-fix driver issues (requires auth) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTING_SERVICE_URL` | `http://localhost:8080` | Router API for DHCP leases |
| `FRIGATE_URL` | `http://localhost:5000` | Frigate NVR API |
| `MQTT_BROKER` | `mqtt://localhost:1883` | MQTT broker URL (with credentials) |
| `SCAN_INTERVAL` | `30` | Seconds between discovery scans (min: 5) |
| `CAMERA_SUBNET` | `192.168.100.0/24` | Subnet to scan (empty = all private; `auto` = resolve from the edge router at scan time) |
| `CAMERA_INIT_CA_CERT` | (unset) | Path to a CA bundle/cert for TLS verification of the camera first-run (vendor-init) HTTPS clients (WARP-583). When set, httpx verifies the camera cert against it; a set-but-missing path fails closed rather than silently downgrading. When unset, verification is disabled — cameras ship per-device self-signed certs on first run, so pinning is not always feasible — and a warning is logged once per process. Residual risk while unpinned: an on-LAN MITM between this service and the camera VLAN can intercept the first-run admin-password set. Pinning also verifies the hostname/IP against the cert's SANs, so a device cert without the camera's IP in its SANs will fail verification against raw-IP targets — fail-closed, by design; provision a cert carrying the device IP in its SANs, or fall back to unpinned. Mirrors the switch service's `SWITCH_CA_CERT`. |
| `DEVICE_SECRET` | (empty) | Auth token for `/drivers/fix` |

## Files

```
services/camera-discovery/
├── main.py              # FastAPI app, discovery loop, MQTT publishing
├── onvif_scanner.py     # ONVIF WS-Discovery + device probing
├── rtsp_prober.py       # RTSP port scanning + stream path probing
├── frigate_client.py    # Frigate NVR config API client
├── driver_checker.py    # Kernel module + V4L2 + USB camera detection
├── Dockerfile
└── requirements.txt
```

## Running Locally

```bash
cd services/camera-discovery
pip install -r requirements.txt

ROUTING_SERVICE_URL=http://localhost:8080 \
FRIGATE_URL=http://localhost:5000 \
MQTT_BROKER=mqtt://user:pass@localhost:1883 \
uvicorn main:app --host 0.0.0.0 --port 8085
```

## Docker

Runs with `network_mode: host` (required for ONVIF multicast) and `NET_ADMIN` capability:

```bash
docker compose --profile full up camera-discovery
```

## Camera Detection Methods

| Method | How | What it finds |
|--------|-----|---------------|
| DHCP lease scanning | Polls router for active leases, checks hostnames for camera keywords | Cameras with recognizable hostnames (hikvision, reolink, etc.) |
| ONVIF WS-Discovery | UDP multicast on 239.255.255.250:3702 | Any ONVIF-compliant camera |
| RTSP port probe | TCP connect to 554, 8554 + OPTIONS request | Any device with an RTSP stream |
| RTSP path probe | Tries 13 common stream paths | Cameras without ONVIF support |

## Driver Checker

The built-in driver checker reports host-level camera support:

```bash
curl http://localhost:8085/drivers
```

Returns kernel module status, V4L2 devices, USB cameras, and required tools (v4l-utils, ffmpeg, usbutils). The `/drivers/fix` endpoint can load missing modules and fix device permissions.
