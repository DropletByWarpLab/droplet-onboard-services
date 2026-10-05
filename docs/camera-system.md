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

Step 6 only happens for a camera whose stream actually answers. Most cameras
don't on first contact — they ship locked, or their real stream sits behind a
vendor-specific path the prober can't guess — so they stay in the discovery
service's **pending** list and are re-probed every 30 s. That list is what the
dashboard shows (below); it is never auto-added, because promoting an unverified
guess installs a permanently-0-fps camera that the sweep then skips forever.

### Candidate states (WARP-1847)

`GET /api/cameras/discovered` merges camera-discovery's live pending list with
the orchestrator's DB rows and labels each one:

| Status | Means | Operator action |
|--------|-------|-----------------|
| `ready` | ONVIF stream URI, or default credentials answered a real `DESCRIBE` | **Add** — adopts it into Frigate |
| `needs_credentials` | It's a camera, but the stream needs a username/password or a corrected path (includes the `rtsp_port_open` placeholder) | **Set up** — asks for the camera's **Username** and **Password** (camera-discovery re-probes with them and adds the camera); a camera discovery holds no live record for opens the manual form prefilled |
| `unverified` | Something answered on a camera port; no stream confirmed | Investigate, or ignore the device |

The response is an envelope — `{ cameras, discoveryOnline }`. `discoveryOnline`
is false when camera-discovery itself is unreachable (it's profile-gated), which
is what lets the dashboard distinguish "nothing on your network" from "nothing is
scanning". `POST /api/cameras/scan` returns the same `cameras` array alongside its
`{ known, pending }` counts, so the scan button renders its result directly.

RTSP URLs are stripped of embedded credentials before leaving the orchestrator
(NET-05: the prober writes working credentials into the URL, and camera-discovery
gates its own endpoint behind `DEVICE_SECRET` for exactly that reason). Clients
get a redacted URL plus a `hasCredentials` boolean.

Accept/reject accept two id shapes: `mac:<MAC>` routes to camera-discovery (which
verifies the stream before committing it to Frigate, answering 422 when it can't),
and a uuid takes the DB path. The candidate id carries the upper-case MAC; the
orchestrator lower-cases it before calling camera-discovery, which keys its pending
list by the lower-case form (and itself accepts any case, so neither side depends on
the other getting it right — WARP-3508).

#### A camera you already have is not a candidate (WARP-3508)

camera-discovery only learns about the adoptions it made itself, so a camera added by
hand (`POST /api/cameras`) used to keep showing up here as "Needs sign-in" for good.
`GET /api/cameras/discovered` now drops a candidate when any of these holds:

- camera-discovery lists it as known (committed to Frigate by discovery);
- a **managed** Camera row carries its MAC (any letter case) or its IP — managed
  meaning `enabled`, or created by hand (`autoDiscovered = false`, even if switched
  off); `isManagedCameraRow()` in `camera-candidates.service.ts` is the one place that
  decides this;
- a Frigate camera input pulls from its IP (`cameras.<name>.ffmpeg.inputs[].path`).

A failed or slow (> 3 s) Frigate read costs only that last exclusion — never the
list. Known gap: a camera discovery adopted and the operator later *disabled* reads
as `enabled = false, autoDiscovered = true`, the same shape as a never-adopted
candidate; the explicit adoption state (WARP-3506/3510) replaces that inference.
camera-discovery applies the same Frigate rule on its side and stops probing those
hosts (see its README).

`POST /api/cameras/discovered/:id/credentials` (`mac:` ids only) takes
`{ username, password }` for a `needs_credentials` camera. camera-discovery tries
the RTSP stream paths with them — ONVIF is asked for a path only when RTSP found
none, so a wrong password costs the camera one failed sign-in, not one per
protocol (Hanwha locks the account after ~5) — and adds the camera on success.
Failures carry a `code`: `auth_failed`, `locked`, `no_stream_path`, `unreachable`,
`timeout`, and `invalid_credentials` / `unsupported_password` (nothing was tried
on the camera). The password is never logged, published or returned.

### Camera identity: key, label, adoption (WARP-3506, WARP-3510)

A camera has ONE name that Frigate and the database share, and a separate label.

- **`Camera.name` is the Frigate key** — always `toFrigateKey(name)`
  (`apps/orchestrator/src/services/camera-key.ts`): lower case, `[a-z0-9_]` only.
  Typing `Warp_Lab_Office` or `Front-Door` files the camera as `warp_lab_office` /
  `front_door` in both Frigate and the DB. What the operator typed becomes
  `displayName`. Everything that writes to or reads from Frigate's config (add,
  delete, reconcile, settings, accept, the discovery merge) goes through that one
  function; camera-discovery's Python `add_camera` applies the same rule.
- **`Camera.adoption` is an explicit state** — `CANDIDATE` (a placeholder
  discovery found, not yet in Frigate) or `ADOPTED` (a real camera). It is never
  inferred from `enabled`, which is only the operator's detection toggle: a
  disabled live camera is `enabled = false` and still `ADOPTED`.
  - A discovery merge keeps the `ADOPTED` row (then the oldest), deletes only
    `CANDIDATE` duplicates, and never renames an `ADOPTED` row. Two `ADOPTED` rows
    on one device are both left alone and logged.
  - **Add camera** and **accept** adopt the placeholder row for the device (found
    by MAC, then IP) in place instead of minting a duplicate.
  - A reconcile never prunes a Frigate key an `ADOPTED` row owns, and refuses a
    save that would leave `cameras` empty while `ADOPTED` rows exist.

Every Frigate config writer (add, delete, the reconcile prune, a settings save,
the retention backfill) holds one process-wide lock across read → edit → save, and
the reconcile reads the DB inside it. Before each save the YAML it replaces is
written to `$FRIGATE_CONFIG_PREIMAGE_DIR` (default
`/data/migration-snapshots/frigate-config/config-<timestamp>.yml`, newest 20 kept,
mode 0600; skipped when that volume is absent). To undo a bad write, POST the file
back as `text/plain` to Frigate's `/api/config/save?save_option=restart`.

### Manual Flow (Dashboard)

1. Go to **Cameras** page in the dashboard
2. Click **Add Camera** button
3. Enter the camera name and its RTSP stream address; the hint shows the detected manufacturer's usual path
4. If it needs a sign-in, enter **Username** and **Password** in their own fields
5. Optionally add manufacturer and model
6. Click **Add Camera** — the camera is written to Frigate, Frigate is restarted
   (on 0.17 `config/set` only writes `config.yml`; nothing starts until a restart),
   and the dashboard waits up to ~45 s for the camera to produce a frame before it
   says it worked

If no frame arrives the camera is still added, but the API answers
`202 { "status": "added_no_stream", "code", "reason" }` instead of `200 ok` and the
dialog stays open with the reason — typically a wrong address, path or password.
Re-adding under the same name updates that camera.

### Manual Flow (Frigate Config)

Add a camera directly to the Frigate config file:

```yaml
# docker/frigate/config.yml
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://user:pass@192.168.100.101:554/<your camera's stream path>
          roles: ["detect", "record"]
```

Write the password **as typed** — never percent-encoded. For a username made of
letters, digits, `_` and `-`, Frigate percent-encodes the password itself before
ffmpeg decodes it once, so a pre-encoded `%40` is encoded again and the camera
receives the literal `%40` (401, then a lockout). The dashboard and
camera-discovery already do this; only a hand-written entry needs the care. A
password written inline cannot contain spaces or curly braces (Frigate runs
`str.format` over the file and its credential pattern stops at whitespace). The
`{FRIGATE_CAMERA_FRONT_DOOR_PASSWORD}` placeholder from `.env`, as the baseline
`docker/frigate/config.yml` shows, keeps the password out of the file.

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

## Storage allocation (WARP-1851)

An operator can give a camera **an amount of disk**. Enforcement is a
**measured feedback controller**, not a formula.

Nightly, per `retentionMode = BUDGET` camera:

| condition | action |
|---|---|
| usage > budget | scale every **enabled** window down toward the target |
| usage < 80% of budget | grow back one step toward the operator's ceiling |
| otherwise | hold — no write, so no camera restart |

`Camera.retentionCeiling` stores the operator's preferred windows. It is
load-bearing: without it the controller cannot distinguish "I reduced this to
fit" from "the operator wants it low", and could never restore retention.

**Two invariants, both scars.**

1. **A window at 0 is never raised.** Scaling is multiplicative over the
   ceiling, and 0 scales to 0. The first cut of this feature derived a window
   and wrote it to `record.continuous.days` — which is **0** on a default box —
   so asking it to *cap* storage **switched 24/7 recording on** and drove usage
   up.
2. **All four windows move together.** Frigate keeps a segment if **any**
   window still covers it: per `record/cleanup.py`, segments past
   `max(continuous, motion)` days are deletion *candidates* but survive when
   they overlap a non-expired alert/detection review. Bounding one window
   cannot bound bytes.

**Why measured, not predicted.** Frigate's `bandwidth` is MiB/hr *while a
segment is being written*, not wall-clock growth. With continuous retention
off, segments are only kept around review items, so `bandwidth × 24`
describes a box that isn't this one. Measuring actual usage sidesteps the
model entirely and converges whatever the recording mode.

Convergence is deliberately gradual — Frigate deletes on its own schedule, so
usage responds a day or so after a window changes. Steps are clamped so the
loop damps rather than oscillates, and a dead band keeps it from restarting
cameras to chase noise.

**Hard cap?** No. Frigate has no per-camera quota, and the orchestrator must
not delete segments behind Frigate's recordings DB — that races its storage
maintainer and corrupts the index playback reads from. A budget is a target
the controller converges on, and the UI says so.

## Dashboard Features

### Camera Page (`/cameras`)

1. **Network Isolation card** — enable/disable camera VLAN with one click
2. **Available on your network** — one row per device the sweep found, with its
   address, vendor and candidate status (see above); Add / Set up / Ignore per
   row, and a Scan action that reports what it found. Doubles as the page's empty
   state when no cameras are set up yet, and carries distinct copy for
   "found nothing" vs "discovery isn't running"
3. **Camera grid** — snapshot thumbnails (auto-refresh 10s), status badges, last detection,
   and a recording line on each tile: a mode chip (24/7, Motion, Events or Off, with the
   camera's own retention on hover), when it last saved, and how much is stored.
   Detecting is blue and "Live · not saving" is orange. Owners and admins get a settings
   gear on each tile
4. **Events timeline** — recent detections with thumbnails, confidence, time
5. **Detail panel** — larger live view, enable/disable/remove controls, Frigate UI link

### Recording state and the camera service restarting (WARP-3511)

`CameraInfo.recording` (see `mobile-api-contract.md`) says what each camera keeps: its
mode, the days each retention window keeps, when the newest segment ended, bytes used
and a daily rate. The camera screen's rail and the top of each camera's settings page
show it, with links between the camera's Recordings, Settings, Notifications and the
Camera system page.

Saving settings restarts the camera service for **every** camera, for a few seconds.
While it cannot be read the grid and the camera screen show "Camera service
restarting…" instead of "Offline" on every tile, and make no recording claim either
way. Enable and Disable on the camera screen are confirmed first for the same reason;
they write the persisted `detect.enabled` setting (Frigate 0.17 has no
`/api/<camera>/detect/enable|disable` route).

A camera that is "Live · not saving" can be repaired from its own screen with **Fix**,
which runs the retention backfill (`GET`/`POST /api/cameras/retention/backfill`, owner
and admin). It checks first and names every camera it will touch, and states what it
will keep: the `GET` dry run returns the repair's effective defaults next to the plan
(the same `resolveRetentionDefaults()` the `POST` applies, set per box through the
`NVR_DEFAULT_*` variables), so no figure is written into the dashboard's copy. For a
camera whose retention was switched off on purpose it points at Settings instead.

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
