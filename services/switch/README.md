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
│  LantronixDriver │  ASICDriver (future)          │
│  drivers/        │  drivers/asic.py              │
│  lantronix.py    │  Custom PCB via SPI/I2C       │
│  HTTPS JSON API  │                               │
└──────────────────┴──────────────────────────────┘
```

**To swap hardware:** Set `SWITCH_DRIVER=asic` in the environment. Nothing else changes — same REST endpoints, same orchestrator client, same LLM tools, same dashboard.

## Supported Hardware

| Driver | Model | Protocol | Status |
|--------|-------|----------|--------|
| `lantronix` | SM8TAT2SA (10-port PoE+) | HTTPS JSON API | Prototype |
| `asic` | Custom PCB | SPI/I2C registers | Future |

### SM8TAT2SA Port Layout

| Ports | Type | PoE | Description |
|-------|------|-----|-------------|
| 1-8 | Copper GbE | Yes (PoE+) | Camera/device ports |
| 9-10 | SFP | No | Uplink/trunk ports |

## REST API

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Connection status, driver type, system info |

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
| POST | `/vlans/{vlan_id}/membership` | Set port membership |

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
| `SWITCH_HOST` | `192.168.1.77` | Switch management IP |
| `SWITCH_PORT` | `443` | Switch HTTPS port |
| `SWITCH_USERNAME` | `admin` | Switch admin username |
| `SWITCH_PASSWORD` | (required) | Switch admin password |
| `SWITCH_CA_CERT` | (unset) | Path to a CA bundle/cert for TLS verification of the switch. When set, the HTTPS session to the switch is verified against it. When unset, verification is disabled (the embedded switch ships a self-signed cert) and a warning is logged. A configured-but-missing path fails closed (the driver refuses to start) rather than silently downgrading to unverified TLS. |
| `SWITCH_DRIVER` | `lantronix` | Driver implementation (`lantronix` or `asic`) |
| `SWITCH_LIVE_WRITES` | `0` (off) | ADR-018 item 10: the WebStaX write shape (`POST /config/<name>`) is pattern-inferred and not yet confirmed on firmware v1.04.0079. The Lantronix driver runs **plan-only** by default — writes compute the intended change and log it without POSTing. Set truthy (`1`/`true`/`yes`/`on`) ONLY after a one-time supervised confirmation of the write shape per firmware; live writes are then read-back-verified and raise on mismatch. |
| `PORT` | `8081` | Service listen port |

## Running Locally

```bash
cd services/switch
pip install -r requirements.txt

SWITCH_HOST=192.168.1.77 \
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
