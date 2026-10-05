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

### Cameras Frigate already has (WARP-3508)

Frigate is the source of truth for "this host is a camera". Discovery reads
`cameras.<name>.ffmpeg.inputs[].path` from Frigate's config and treats every IP it
finds as *managed*: a managed IP is never probed (no ONVIF login, no
default-credential ladder), never published, and any pending record sitting on it is
dropped. This is what stops a camera added by hand — which never passes through
this service — from lingering in the discovered list as "needs sign-in" and being
re-probed every sweep; Hanwha locks the admin account after ~5 failed logins.

The managed set is refreshed at startup, before an operator-triggered
`POST /scan`, and every 10th scheduled sweep (~5 minutes at the default
`SCAN_INTERVAL`). Each refresh *replaces* the set, so a camera removed from Frigate
becomes discoverable again; if Frigate cannot be reached the previous set is kept.
The refresh before `POST /scan` waits at most 5 s (`RECONCILE_TIMEOUT_SECONDS`): a
Frigate that is restarting costs that refresh, never the scan.

### Credential probing budget (WARP-3508)

Hanwha, Axis and some Hikvision cameras lock the admin account after ~5 failed
logins and answer `490 Account Blocked` for several minutes. A camera still waiting
for the operator's password used to be re-probed every sweep — ONVIF as
admin/blank, then up to ~14 default logins per stream path — and so sat in
permanent lockout, the operator locked out with it. The default-credential ladder
now keeps a per-IP budget (`LADDER_*` in `rtsp_prober.py`):

- at most 2 rejected logins per run, then it stands down for 10 minutes; the ONVIF
  admin/blank login stands down with it. The next run *resumes at the next
  credential* rather than restarting at the first;
- a `490` stops it at once, for an hour; so does a camera that has rejected every
  credential (it needs the operator's password), before a new pass starts;
- a stream path that does not exist, or does not challenge, costs one anonymous
  request and no login.

Anonymous probes (port scan, `OPTIONS`, the classifier's `DESCRIBE`) never spend a
camera's lockout budget and keep running every sweep, so a camera that is standing
down still appears in the list as needing credentials. The price is slower adoption
of a camera whose factory default is not among the first few credentials — set
`CAMERA_DEFAULT_USERNAME` / `CAMERA_DEFAULT_PASSWORD` and the site's real credential
is the first one tried.

### Decisions made while a sweep is probing

A sweep spends seconds per candidate (ONVIF, RTSP, the credential ladder, Frigate).
If the operator accepts, dismisses or hand-adds that camera in the meantime, the
sweep drops what it found instead of writing it back — otherwise a camera already
live in Frigate reappears as "needs credentials", and a dismissed one reappears at
all. The check runs when the candidate list is built, before each candidate's
probes, and again immediately before the sweep records a result or adds the camera
to Frigate (`_already_decided` in `main.py`). The sweep's own Frigate add holds the
same in-flight claim `accept` does, so a reject arriving during it gets a `409`.

## Security

- **IP validation** — only probes RFC 1918 private addresses (10.x, 172.16-31.x, 192.168.x). Rejects loopback, link-local, multicast, and public IPs.
- **Subnet filtering** — when `CAMERA_SUBNET` is set (default: `192.168.100.0/24`), only scans that subnet. Prevents probing devices on the main LAN. `CAMERA_SUBNET=auto` (WARP-1805, the single-box provisioning default) resolves the network from the edge router at scan time via the routing service's `/network/interfaces`, so the filter follows the LAN that actually hands cameras their DHCP leases instead of a provision-time constant that goes stale when the fabric moves. While auto is unresolved (routing service unreachable), the sweep stays off and candidates are gated to private (RFC 1918) IPs only — discovery degrades, never widens.
- **RTSP URL validation** — validates scheme (`rtsp://`/`rtsps://`) and host before passing to Frigate.
- **No clear-text camera passwords (WARP-3597)** — a camera that asks for RTSP Basic auth gets no credentials; Digest is used where offered (preferred when both are). A Basic-only camera must be listed in `CAMERA_RTSP_BASIC_ALLOW_IPS`. Discovery MQTT events and `/cameras/*` responses carry the RTSP URL without `user:pass@` (plus `has_credentials`); the full URL stays internal and is written to Frigate.
- **Driver fix auth** — the `/drivers/fix` endpoint (which runs `modprobe`) requires `DEVICE_SECRET` bearer token.
- **ONVIF probes are read-only** — only calls `GetDeviceInformation` and `GetStreamUri`, never modifies camera config.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service + Frigate connectivity status |
| GET | `/cameras/discovered` | Pending cameras (not yet in Frigate) |
| GET | `/cameras/known` | Active cameras (configured in Frigate) |
| POST | `/cameras/discovered/{mac}/accept` | Accept camera into Frigate |
| POST | `/cameras/discovered/{mac}/credentials` | Add a discovered camera with operator-supplied `{username, password}` (probes RTSP first, ONVIF only if RTSP found no path; 422 `auth_failed`/`no_stream_path`/`basic_auth_only`, 423 `locked`, 502 `unreachable`, 504 `timeout`, 400 `invalid_credentials`/`unsupported_password`/`unsupported_stream_address`) |
| POST | `/cameras/discovered/{mac}/reject` | Reject camera (won't rediscover — the dismissal survives a restart, see [State](#state)) |
| POST | `/scan` | Manually trigger a discovery scan |
| GET | `/subnet/status` | Which subnet is being scanned |
| GET | `/drivers` | Camera driver status report (kernel modules, V4L2, USB) |
| POST | `/drivers/fix` | Auto-fix driver issues (requires auth) |

`{mac}` is the camera's key: its MAC, or `ip:<addr>` / `onvif_<addr_with_underscores>`
for a camera found without a DHCP lease. It may be spelled in any case — it is
lower-cased before use, because the pending list is keyed by the lower-case form
(the orchestrator sends it lower-case, but nothing depends on that). Anything that
cannot be a key is a `400`; a well-formed key that is not pending is a `404`.

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
| `CAMERA_RTSP_BASIC_ALLOW_IPS` | (empty) | Comma-separated camera IPs the prober may answer with RTSP Basic auth (clear-text password). Empty = Digest only |
| `CAMERA_DISCOVERY_STATE_DIR` | `/var/lib/droplet/camera-discovery` | Directory for the dismissed-camera list (`rejected-macs.json`). Compose mounts the `camera-discovery-state` named volume here; set it only to run the service outside the container (WARP-3508). |

## State

Camera-discovery keeps its working state in memory and re-derives it from the
network and from Frigate on every start. The one exception is the list of cameras
the operator **dismissed** (`POST .../reject`): that is a decision, not something
discovery can re-derive, so it is written to `rejected-macs.json` under
`CAMERA_DISCOVERY_STATE_DIR` and read back at startup.

- The file is `{"rejected_macs": ["aa:bb:...", ...]}` — MACs only, no credentials.
- Writes are atomic (temp file in the same directory, `fsync`, rename), so a crash
  or full disk leaves the previous list intact.
- Saving is best-effort: if the directory is unwritable the camera is still
  dismissed for this run, the error is logged, and the reject response carries
  `"persisted": false`.
- A missing, corrupt or over-long file never stops the service from starting; the
  list is capped at 1000 entries, as it is in memory.
- There is no "un-reject" endpoint. To bring a dismissed camera back, delete its
  entry from the file (or the file) and restart the service; a factory reset wipes
  the volume.
- `known_cameras` is deliberately **not** persisted: its records embed
  `user:pass@` stream URLs, and what Frigate already manages is re-derived from
  Frigate itself.

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
