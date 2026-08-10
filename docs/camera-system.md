# Camera System

End-to-end camera management for the Droplet edge platform — auto-discovery, NVR recording with AI detection, network isolation, and remote viewing.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Droplet Camera System                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │ Camera Discovery │───→│   Frigate NVR   │───→│    MQTT      │ │
│  │ ONVIF + RTSP    │    │ TensorRT GPU AI │    │   Broker     │ │
│  │ Port probing    │    │ Record + Detect  │    │              │ │
│  └────────┬────────┘    └────────┬────────┘    └──────┬───────┘ │
│           │                      │                     │         │
│  ┌────────┴──────────────────────┴─────────────────────┴───────┐ │
│  │                    Orchestrator API                          │ │
│  │  /api/cameras/* — auth-gated, snapshot proxy, SSE events    │ │
│  └─────────────────────────────┬───────────────────────────────┘ │
│                                │                                 │
│  ┌─────────────────────────────┴───────────────────────────────┐ │
│  │                    Web Dashboard                             │ │
│  │  Camera grid, events timeline, discovery banner, toasts     │ │
│  │  Works on-LAN and off-LAN (all streams proxied via auth)   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  OpenWrt Router   │    │  Managed Switch  │                   │
│  │  VLAN 100 L3     │    │  VLAN 100 L2     │                   │
│  │  Firewall zones  │    │  Port tagging    │                   │
│  └──────────────────┘    └──────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Frigate NVR** | `docker/frigate/` | Recording, AI object detection (TensorRT), snapshots, RTSP restream |
| **Camera Discovery** | `services/camera-discovery/` | Auto-detect cameras via ONVIF/RTSP, configure in Frigate |
| **Camera API** | `apps/orchestrator/src/routes/cameras.ts` | Auth-gated REST API for cameras, snapshots, events, SSE |
| **Camera Dashboard** | `apps/web-dashboard/src/app/cameras/` | Camera grid, events, discovery banner, notification toasts |
| **Camera Subnet** | `openwrt/files/etc/config/` | VLAN 100 isolation (router firewall + switch port tagging) |
| **Camera Drivers** | `scripts/lib/camera-drivers.sh` | Kernel modules, udev rules, host-level driver setup |
| **LLM Tools** | `services/ai-gateway/tools/` | `get_cameras`, `get_camera_events`, `get_camera_snapshot` |

## How Cameras Get Connected

### Automatic Flow (Plug and Play)

1. **Plug camera into switch port** (or connect via WiFi)
2. **Switch** tags the port as VLAN 100 (if camera setup was run)
3. **Router** serves DHCP on the camera subnet (192.168.100.100-249)
4. **Camera Discovery** detects the new DHCP lease within 30 seconds
5. **ONVIF probe** queries camera for manufacturer, model, stream URI
6. **Frigate** gets the camera auto-configured with RTSP stream
7. **MQTT event** published → orchestrator → dashboard shows toast notification
8. **Recording + AI detection** starts immediately (person, car, animal, package)

### Manual Flow (Dashboard)

1. Go to **Cameras** page in the dashboard
2. Click **Add Camera** button
3. Enter camera name and RTSP URL (e.g., `rtsp://192.168.100.101:554/stream1`)
4. Optionally add manufacturer and model
5. Click **Add Camera** — it's immediately configured in Frigate

### Manual Flow (Frigate Config)

Add a camera directly to the Frigate config file:

```yaml
# docker/frigate/config.yml
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://user:pass@192.168.100.101:554/stream1
          roles: ["detect", "record"]
```

### Scan Network

Click **Scan** in the dashboard to trigger immediate ONVIF/RTSP discovery. This runs the same scan that auto-discovery performs every 30 seconds, but on demand. Requires the camera-discovery service to be running (`--profile full`).

## Network Isolation

Cameras are on a separate VLAN (100) so users on the main LAN can't browse feeds directly.

```
Main LAN (192.168.50.0/24)          Camera Subnet (192.168.100.0/24)
  Users, phones, laptops              Cameras only
       │                                    │
       └──── BLOCKED (firewall) ────────────┘
                     │
              Droplet appliance ← Only device on both subnets
              (Frigate, Discovery)
```

### Firewall Rules

| From | To | Action | Why |
|------|----|--------|-----|
| LAN → cameras | ACCEPT | Droplet needs RTSP/ONVIF access |
| cameras → LAN | REJECT | Cameras can't reach user devices |
| cameras → cameras | REJECT | No lateral movement between cameras |
| cameras → WAN | ACCEPT | NTP, DNS, firmware updates |
| cameras → router | ACCEPT (DHCP/DNS/ping only) | Basic network services |

### Setup

**One-click via API:**
```bash
# Router side (VLAN + firewall + DHCP)
curl -X POST http://localhost:3000/api/cameras/subnet/setup

# Switch side (port tagging)
curl -X POST http://localhost:3000/api/switch/setup/cameras
```

**Manual on existing OpenWrt:**
```bash
scp openwrt/scripts/setup-camera-subnet.sh root@192.168.50.1:/tmp/
ssh root@192.168.50.1 'sh /tmp/setup-camera-subnet.sh'
```

## Remote Access

All camera access works through the authenticated Nginx HTTPS gateway. The same URLs work on-LAN and off-LAN:

| What | URL | Auth |
|------|-----|------|
| Camera list | `GET /api/cameras` | Session cookie or Bearer token |
| Live snapshot | `GET /api/cameras/{name}/snapshot` | Session cookie or Bearer token |
| Live MJPEG stream | `GET /api/cameras/{name}/live` | Session cookie or Bearer token |
| HLS recording playback | `GET /api/cameras/{name}/playback.m3u8` | Session cookie or Bearer token |
| Detection events | `GET /api/cameras/events/recent` | Session cookie or Bearer token |
| Real-time alerts | `GET /api/cameras/events/sse` | Session cookie or Bearer token |

**Security:** Camera IPs and RTSP URLs are never exposed to clients. The orchestrator proxies all snapshots and streams through authenticated endpoints. Frigate's bundled UI on `:8971` is reachable only on the internal Docker network — there is no `/frigate/` gateway route by design (see `docs/FRIGATE_PARITY.md`).

## Frigate Configuration

Base config at `docker/frigate/config.yml`:

| Setting | Value | Notes |
|---------|-------|-------|
| Detector | TensorRT (NVIDIA GPU) | Hardware-accelerated AI detection |
| Alert clip retention | 14 days | `record.alerts.retain.days` |
| Detection clip retention | 14 days | `record.detections.retain.days` |
| 24/7 footage retention | 0 days (not kept) | `record.continuous.days` — Frigate's default; raise per camera |
| Motion footage retention | 0 days (not kept) | `record.motion.days` |
| Snapshot retention | 14 days | `snapshots.retain.default` |
| Detection FPS | 5 | Per camera |
| Detection resolution | 1280x720 | |
| Objects tracked | person, car, dog, cat, package | |
| MQTT | Connected to broker | Events published for orchestrator |

## Retention — who deletes what

**Frigate owns expiry. The orchestrator only sets the policy.**

Frigate keeps four independent retention windows per camera, and its own
`RecordingCleanup` (`frigate/record/cleanup.py`) expires against them:

| Key | Covers |
|-----|--------|
| `record.continuous.days` | 24/7 footage — by far the largest consumer of disk |
| `record.motion.days` | segments containing motion |
| `record.alerts.retain.days` | review items escalated to alerts |
| `record.detections.retain.days` | lower-confidence review items |

Snapshots retain separately via `snapshots.retain.default`. On top of the
age windows, Frigate evicts oldest-first when the volume runs low
(`frigate/storage.py`).

The orchestrator writes these keys through
`PATCH /api/cameras/:name/settings` and otherwise stays out of the way.

**Three traps, all of which shipped once (WARP-1849):**

0. **Never save the resolved `/api/config` back.** `/api/config` returns the
   *resolved* tree, which carries computed-only fields (`model.colormap`,
   `model.all_attributes`, `auth.roles` filled with the reserved names, …).
   The config models are `extra="forbid"`, so posting it back fails — an
   untouched resolved config produces **42** validation errors. Any code
   that writes a whole config must start from the *authored* yaml at
   `/api/config/raw` (`fetchRawConfigYaml` / `saveRawConfig`). Read from
   resolved, write to authored.


1. **There is no delete-by-window API.** `DELETE /api/recordings?before=`
   and `DELETE /api/events?before=` both return **405** on Frigate 0.17 —
   they do not exist. Only `DELETE /api/events/{id}` and the bulk
   `DELETE /api/events/` (body of ids) do. A cron that "purges by age"
   against Frigate cannot work; age-based expiry is Frigate's job.

2. **`record.retain` is not a valid key and is not ignored.** Frigate 0.17
   removed it, and `FrigateBaseModel` is declared
   `ConfigDict(extra="forbid")` — so a camera block carrying `record.retain`
   fails validation and Frigate rejects the **entire** config save, silently
   discarding whatever else was batched into it. `camera-settings.service.ts`
   strips the key on every write for exactly this reason.

Before changing any retention behaviour, verify the key against the running
container rather than the docs:

```bash
docker exec droplet-frigate-1 python3 -c "from frigate.config.camera.record import RecordConfig; RecordConfig(**{'continuous':{'days':30}})"
```

## Dashboard Features

### Camera Page (`/cameras`)

1. **Network Isolation card** — enable/disable camera VLAN with one click
2. **Discovery banner** — "3 new cameras detected" with Accept All / Review
3. **Camera grid** — snapshot thumbnails (auto-refresh 10s), status badges, last detection
4. **Events timeline** — recent detections with thumbnails, confidence, time
5. **Detail panel** — larger live view, enable/disable/remove controls, Frigate UI link

### Notifications

Real-time SSE toast notifications for:
- Person/vehicle/animal detected (with snapshot thumbnail)
- New camera discovered on network
- Camera online/offline status changes

## LLM Integration

The AI assistant can interact with cameras via natural language:

| Tool | Example Prompt |
|------|---------------|
| `get_cameras` | "What cameras are connected?" |
| `get_camera_events` | "Were there any detections in the last hour?" |
| `get_camera_snapshot` | "Show me the front door camera" |

## Camera Driver Management

### Setup Script (`scripts/camera-drivers.sh`)

```bash
./scripts/camera-drivers.sh check    # Show driver status
./scripts/camera-drivers.sh install  # Install UVC/V4L2 drivers + packages
./scripts/camera-drivers.sh scan     # Detect USB + network cameras
./scripts/camera-drivers.sh fix      # Auto-fix permissions + load modules
```

### What Gets Installed

- **Kernel modules:** uvcvideo, videodev, videobuf2_v4l2, videobuf2_vmalloc
- **Packages:** v4l-utils, ffmpeg, usbutils
- **Udev rules:** Auto-permission on USB camera hotplug, Frigate restart on new device
- **Boot persistence:** Modules auto-load via `/etc/modules-load.d/droplet-cameras.conf`

## Docker Services

| Service | Port | Profile | Purpose |
|---------|------|---------|---------|
| `frigate` | 8971 (internal) | *(always on)* | NVR + AI detection |
| `camera-discovery` | 8085 (host) | full | ONVIF/RTSP auto-detection |

Both are internal-only — no ports exposed to host. All access through Nginx.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FRIGATE_URL` | `http://frigate:5000` | Frigate API endpoint |
| `CAMERA_SCAN_INTERVAL` | `30` | Discovery scan interval (seconds) |
| `CAMERA_SUBNET` | `192.168.100.0/24` | Camera isolation subnet. `auto` (single-box provisioning default, WARP-1805) resolves the network from the edge router at scan time via the routing service, so the filter follows the LAN that hands cameras their leases; an explicit CIDR pins it (multi-box camera VLAN, future isolated VLAN per ADR-018 T3) |
| `CAMERA_DISCOVERY_URL` | `http://localhost:8085` | Discovery service endpoint |
