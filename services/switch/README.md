# Switch Service

Managed switch control service for the Droplet edge platform. Provides a REST API for port management, VLAN configuration, PoE control, and WAN detection.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Switch Service (FastAPI)            │
│                   main.py                        │
│  REST endpoints — talks to driver, never to HW   │
├─────────────────────────────────────────────────┤
│            Abstract SwitchDriver                 │
│              drivers/base.py                     │
│  23 methods: ports, VLANs, PoE, system, WAN     │
├──────────────────┬──────────────────────────────┤
│ OpenWrtSwitch-   │  ASICDriver (future)          │
│ Driver drivers/  │  drivers/asic.py              │
│ openwrt.py       │  Custom PCB via SPI/I2C       │
│ ubus-over-HTTP   │                               │
└──────────────────┴──────────────────────────────┘
```

**To swap hardware:** Set `SWITCH_DRIVER=asic` in the environment. Nothing else changes — same REST endpoints, same orchestrator client, same LLM tools, same dashboard.

## Supported Hardware

| Driver | Model | Protocol | Status |
|--------|-------|----------|--------|
| `openwrt` | Zyxel GS1900-10HP (Droplet OpenWrt image) | ubus-over-HTTP (rpcd, `droplet-ai`) | Shipping (edge-router shape) |
| `asic` | Custom PCB | SPI/I2C registers | Future |

Managed switches are Zyxel units **reflashed to the Droplet OpenWrt image**
(see `DropletByWarpLab/droplet-edge-router` `switch/`). The retired Lantronix
SM8TAT2SA WebStaX driver was removed in WARP-1674.

### GS1900-10HP Port Layout

| Ports | Type | PoE | Description |
|-------|------|-----|-------------|
| 1-8 | Copper GbE | Yes (PoE+) | Camera/device ports |
| 9-10 | SFP | No | Uplink/trunk ports |

## REST API

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Connection status, driver type. Carries `error_code` (`SWITCH_AUTH` / `SWITCH_PAIRED_ELSEWHERE` / null) and the `pairing` block below |

`/health.pairing` (ADR-071 §2.2 step 1) is served from a cache and never blocks on the network:

```json
"pairing": {
  "state": "open | closed | paired | unknown",
  "window_ends_at": "<iso8601> | null",
  "paired_box": "<64 lowercase hex> | null",
  "paired_elsewhere": false,
  "pending_persist": false
}
```

- **Explicit auth state.** The service enters `SWITCH_AUTH` only when the switch *answered and refused* the `droplet-ai` credential (startup connect, a runtime login, or `/health` seeing `AuthenticationError`). "Unreachable" and "never configured" are different states and are never probed for a pairing window.
- **One apscheduler job, only in that state.** While `SWITCH_AUTH` holds, the `switch-pairing-probe` interval job (every `SWITCH_PAIRING_PROBE_SECONDS`, default 30) re-tries the login with the current password holder, then calls `droplet.pair status` with the **null session** and caches the answer. It removes itself when the state clears (a successful login, or the switch becoming unreachable). Nothing polls while connected.
- Connected: `state` is `paired` after a claim in this process, otherwise `unknown`.
- `paired_elsewhere` is true when the switch reports `paired` with a `paired_box` that is not this box's fingerprint (supplied by the orchestrator via `PUT /pairing/identity` or the first claim; never guessed while unknown). `/health` then reports `SWITCH_PAIRED_ELSEWHERE` instead of `SWITCH_AUTH`; re-pairing needs the switch's button (or a factory reset).

### Pairing (ADR-071 slice C)
All routes require the service token. Same contract as `services/routing`'s router pairing, against `SWITCH_HOST`.

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/pairing/identity` | `{"box_fingerprint": "<64 hex>"}` — tell the service which box it serves (enables `SWITCH_PAIRED_ELSEWHERE`) |
| POST | `/pairing/claim` | `{"box_fingerprint": "<64 hex>"}` — mint a 32-hex password, `droplet.pair claim`, prove it by logging in as `droplet-ai` with it, switch the live driver, clear the auth state, run the bring-up reconcile if `SWITCH_AUTOPROVISION` is on. `200 {"ok": true, "password", "host", "model", "paired_at"}` |
| GET | `/pairing/pending` | `{"pending": bool, "password": "<32hex>" \| null, "paired_at": ...}` — a minted password the orchestrator has not yet confirmed persisted |
| POST | `/pairing/persisted` | Orchestrator confirms the password is saved; the service forgets it. `{"ok": true}` |

`POST /pairing/claim` errors are `{"code", "detail"}` (plus `paired_box` for the elsewhere case): `400 INVALID_FINGERPRINT`, `409 PAIR_WINDOW_CLOSED`, `409 SWITCH_PAIRED_ELSEWHERE`, `409 PAIR_BUSY`, `502 PAIR_UNSUPPORTED` (no `droplet.pair` plugin, or a non-`openwrt` driver), `502 PAIR_CLAIM_FAILED`, `502 PAIR_VERIFY_FAILED` (claim accepted but the login with the new password failed: logged at ERROR, auth state kept, nothing switched), `503 SWITCH_UNREACHABLE`. The password appears only in the 200 body and `GET /pairing/pending`; it is never logged.

The orchestrator (`POST /api/network/switch/pair`) persists the password through the device-bridge (`target: "switch"` → `docker/secrets/switch_password`, then `docker compose up -d --force-recreate switch`) and confirms with `/pairing/persisted`. The pairing code is a sibling of `services/routing/pairing.py` (`pairing.py` here): the two images share no Python package path, so the state/helper code is duplicated by design and only the null-session client differs (async httpx here).

### Ports
| Method | Path | Description |
|--------|------|-------------|
| GET | `/ports` | All port statuses (link, speed, VLAN, PoE) |
| GET | `/ports/{port}` | Single port status |
| POST | `/ports/{port}/enable` | Enable a port |
| POST | `/ports/{port}/disable` | Disable a port |

### VLANs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/vlans` | List all VLANs |
| POST | `/vlans` | Create VLAN (`{"vlan_id": 100, "name": "cameras"}`) |
| DELETE | `/vlans/{vlan_id}` | Delete a VLAN |
| GET | `/vlans/{vlan_id}/membership` | Port membership for a VLAN |
| POST | `/vlans/{vlan_id}/membership` | Set port membership (`{"ports": [...], "mode": "merge"\|"replace"}`) |

`mode` declares what happens to the VLAN's EXISTING members, because a
one-port list means both "move this port here" and "this VLAN has exactly one
member" and only one of those is recoverable:

* **`merge`** (default) — each entry is an access move: the port becomes the
  VLAN's untagged member, every other member is preserved, and the port is
  dropped from other VLANs' untagged membership (tagged trunks are left
  alone). Entries that cannot be expressed that way (`tagged: true`,
  `member: false`) are refused with a 400 naming `replace`.
* **`replace`** — write the whole member list; anything absent is removed.
  Only for callers that computed the complete membership.

### PoE
| Method | Path | Description |
|--------|------|-------------|
| GET | `/poe` | PoE status for all ports |
| GET | `/poe/{port}` | PoE status for one port (1-8 only) |
| POST | `/poe/{port}/enable` | Enable PoE on a port |
| POST | `/poe/{port}/disable` | Disable PoE on a port |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/system/info` | Model, firmware, MAC, uptime |
| POST | `/wan/detect` | Auto-detect WAN uplink port |
| POST | `/setup/cameras` | One-click camera VLAN setup |

### Camera Setup Example

```bash
curl -X POST http://localhost:8081/setup/cameras \
  -H "Content-Type: application/json" \
  -d '{
    "vlan_id": 100,
    "camera_ports": [1, 2, 3, 4, 5, 6, 7, 8],
    "uplink_ports": [9, 10]
  }'
```

This creates VLAN 100, assigns ports 1-8 as untagged access ports (cameras), and ports 9-10 as tagged trunk (uplinks to router).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SWITCH_HOST` | `192.168.9.2` | Switch management IP (the image's static mgmt address) |
| `SWITCH_PORT` | `80` | Switch rpcd/ubus HTTP port (LAN-side only) |
| `SWITCH_USERNAME` | `admin` | Switch admin username |
| `SWITCH_PASSWORD_FILE` | `/run/secrets/switch_password` | Path to the Docker secret file holding the switch admin password. Resolved first. See "Switch password" below. |
| `SWITCH_PASSWORD` | (empty) | **Deprecated** — env fallback kept for local dev and upgrades. Prefer the secret file. Empty → the switch reports `disconnected` (non-fatal). |
| `SWITCH_CA_CERT` | (unset) | Path to a CA bundle/cert for TLS verification of the switch. When set, the HTTPS session to the switch is verified against it. When unset, verification is disabled (the embedded switch ships a self-signed cert) and a warning is logged. A configured-but-missing path fails closed (the driver refuses to start) rather than silently downgrading to unverified TLS. |
| `SWITCH_DRIVER` | `openwrt` | Driver implementation (`openwrt`; `asic` future) |
| `SWITCH_LIVE_WRITES` | `0` (off) | ADR-018 item 10 discipline: the uci write shapes are built from the committed image config and not yet confirmed on flashed hardware. The driver runs **plan-only** by default — writes compute the intended change and log it without applying. Set truthy (`1`/`true`/`yes`/`on`) ONLY after a one-time supervised post-flash confirmation; live writes are then read-back-verified and raise on mismatch. |
| `PORT` | `8081` | Service listen port |

## Switch password

The managed switch's admin credential is **operator-supplied** — unlike the
per-device secrets `setup.sh` mints (the OpenWrt rpcd password, service tokens,
the audit key), the switch is third-party hardware whose password the operator
sets on the switch itself, so the platform never generates or commits one
(ADR-018 T1).

In production it is mounted as a Docker secret at `/run/secrets/switch_password`
(0600). `drivers._load_switch_password()` resolves it in this order at startup:

1. `SWITCH_PASSWORD_FILE` (default `/run/secrets/switch_password`) — preferred.
2. `SWITCH_PASSWORD` env var — deprecated, logged as a warning.

If neither is set the switch service still starts but logs a warning and reports
`disconnected` (every authenticated call fails at login) — the same graceful
degradation as when the switch is unreachable. **Boxes without a managed switch
are unaffected:** they leave `SWITCH_PASSWORD` empty and the service idles
disconnected.

**Runtime reload (ADR-071).** The password is not frozen at startup: every switch login
resolves it through `current_switch_password()` — the password minted by a pairing claim in this
process, else the secret file **re-read at login time**, else the deprecated env var. After a claim the
service runs on the new password with no container recreate; the secret file still holds the old value
until the orchestrator persists the new one (device-bridge `droplet-pair-apply`, which then recreates
this container). On a switch flashed with the Droplet OpenWrt image the dashboard's **Pair** card
replaces the manual copy below; the manual path remains the fallback for an image without the
`droplet.pair` plugin.

To configure (or rotate) the credential:

```bash
# 1. Set the operator-supplied password in .env (the password already set ON the
#    switch — this command does NOT change the switch's password).
sed -i 's/^SWITCH_PASSWORD=.*/SWITCH_PASSWORD=theswitchpassword/' .env \
  || echo 'SWITCH_PASSWORD=theswitchpassword' >> .env

# 2. Rewrite the secret file (writes atomically with chmod 600).
./scripts/setup.sh --sync-secrets

# 3. Restart the switch container.
docker compose -f docker/docker-compose.yml restart switch
```

When `SWITCH_PASSWORD` is empty `setup.sh` writes an empty placeholder file so
Docker Compose can still mount the secret and the service starts (degraded). It
never generates a switch password.

## Running Locally

```bash
cd services/switch
pip install -r requirements.txt

SWITCH_HOST=192.168.9.2 \
SWITCH_PASSWORD=yourpassword \
uvicorn main:app --host 0.0.0.0 --port 8081
```

## Running via Docker

```bash
# Part of the full stack (profile: full)
docker compose --profile full up switch

# Or standalone
docker compose --profile full up --build switch
```

## Writing a New Driver

To add support for new hardware (e.g., the custom ASIC PCB):

1. Create `drivers/asic.py`:
   ```python
   from .base import SwitchDriver

   class ASICDriver(SwitchDriver):
       async def connect(self) -> None:
           # Open SPI/I2C bus
           ...

       async def get_ports(self) -> list[dict]:
           # Read port status registers
           ...

       # Implement all 23 abstract methods from SwitchDriver
   ```

2. Register in `drivers/__init__.py`:
   ```python
   elif driver_type == "asic":
       from .asic import ASICDriver
       return ASICDriver(bus=os.environ.get("ASIC_BUS", "/dev/spidev0.0"))
   ```

3. Set `SWITCH_DRIVER=asic` in the environment.

That's it. The FastAPI endpoints, orchestrator, LLM tools, and dashboard all work without changes.

## Integration Points

| Component | How it connects |
|-----------|----------------|
| **Orchestrator** | HTTP client at `SWITCH_SERVICE_URL` (default `http://localhost:8081`) |
| **LLM/AI Gateway** | 7 tools: `get_switch_ports`, `get_switch_vlans`, `set_port_vlan`, `get_switch_poe`, `set_port_poe`, `detect_wan_port`, `setup_camera_ports` |
| **Dashboard** | `SwitchPortMap` component + `useSwitch` hook polling `/api/switch/*` |
| **Health** | Included in `/api/health` response as `services.switch: true/false` |
| **Camera Discovery** | Camera subnet on VLAN 100 — switch tags ports, router handles L3 |
