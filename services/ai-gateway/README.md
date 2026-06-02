# AI Gateway

> **As of WARP-104, ai-gateway is purely a provider router** (LiteLLM proxying
> to Ollama, Anthropic, OpenAI). Tool dispatch lives in
> [`services/mcp-server/`](../mcp-server/) with handlers in
> [`packages/tools-core/`](../../packages/tools-core/). The orchestrator's
> `llm-agent.service.ts` runs the agent loop and calls MCP for every
> `tool_calls[]` the model emits — the gateway just forwards the model
> response (tool calls included) back unchanged. If you're looking to add a
> new LLM-callable tool, see the "LLM tool calling" section in the repo
> root [CLAUDE.md](../../CLAUDE.md).

FastAPI + LiteLLM model routing proxy. Routes LLM requests to local (Ollama on Jetson) or cloud providers and forwards model responses verbatim — including any `tool_calls[]` the model produces — to the orchestrator's agent loop.

## Architecture

```
Dashboard / API client
       │
       ↓
  Orchestrator (/api/llm/*) ──── stdio ────▶ MCP Server ──▶ tools-core handlers
       │                                       (tool dispatch, RBAC)
       ↓
  AI Gateway (FastAPI :8000)
  ├── LiteLLM router (multi-provider)
  └── gRPC server (:50051)
       │
       ├──→ Ollama (Jetson local inference)
       ├──→ OpenAI API
       ├──→ Anthropic API
       └──→ Other providers
```

## Tool System (historical — see banner above)

The AI assistant can call tools to interact with the Droplet system. As of WARP-104, tools are defined and executed in `packages/tools-core/` via the MCP server; this section is preserved for context only and does not describe the current dispatch path.

### Available Tools

#### File Management
| Tool | Description |
|------|-------------|
| `list_files` | List files and directories on the device |
| `read_file` | Read text file contents |
| `search_files` | Search for files by name pattern |

#### Device Management
| Tool | Description |
|------|-------------|
| `list_devices` | List registered edge devices |
| `get_system_health` | System health status for all services |
| `list_sync_targets` | List file sync targets |
| `trigger_sync` | Trigger a file sync operation |

#### Network / Router
| Tool | Description |
|------|-------------|
| `get_network_status` | Network overview (interfaces, wireless, DHCP, firewall) |
| `get_connected_devices` | All devices on the network with IPs and MACs |
| `get_wifi_settings` | Current WiFi configuration |
| `scan_wifi_networks` | Scan for available WiFi networks |
| `set_wifi_ssid` | Change the WiFi SSID |
| `set_wifi_channel` | Change the WiFi channel |
| `get_firewall_rules` | List firewall zones, rules, and port forwards |
| `block_network_device` | Block a device by MAC address (Tier 2 — needs confirmation) |
| `unblock_network_device` | Unblock a device (Tier 2) |
| `add_port_forward` | Add a port forwarding rule (Tier 2) |
| `get_router_system_info` | Router hardware, firmware, uptime |

#### Cameras / Frigate NVR
| Tool | Description |
|------|-------------|
| `get_cameras` | List all cameras and their status (recording/detecting/offline) |
| `get_camera_events` | Recent AI detection events (person, car, animal) |
| `get_camera_snapshot` | Get snapshot URL for a specific camera |

#### Managed Switch
| Tool | Description |
|------|-------------|
| `get_switch_ports` | Port status (link, speed, VLAN, PoE) for all 10 ports |
| `get_switch_vlans` | All VLANs with port memberships |
| `set_port_vlan` | Assign ports to a VLAN (Tier 2 — needs confirmation) |
| `get_switch_poe` | PoE power delivery status per port |
| `set_port_poe` | Enable/disable PoE on a port (Tier 2) |
| `detect_wan_port` | Auto-detect which port is the WAN uplink |
| `setup_camera_ports` | One-click camera VLAN setup on switch (Tier 2) |

### Safety Tiers

Tools that modify system state go through a safety tier framework:

| Tier | Action | Examples |
|------|--------|---------|
| **Tier 1** | Auto-execute | WiFi SSID, channel, DNS, file listing |
| **Tier 2** | Requires user confirmation | Firewall rules, PoE toggle, VLAN changes, device blocking |
| **Tier 3** | Blocked for AI | System reboot, VPN config, factory reset |

When the LLM calls a Tier 2 tool, it returns `{"status": "confirmation_required"}` and instructs the user to confirm in the dashboard.

## Files

```
services/ai-gateway/
├── main.py              # FastAPI app with LiteLLM integration
├── router.py            # Provider router (forwards tools[] verbatim — no dispatch)
├── grpc_server.py       # gRPC interface for orchestrator
├── schemas.py           # Pydantic request/response models (incl. ToolDefinition for OpenAI passthrough)
├── Dockerfile
├── requirements.txt
└── TESTING.md           # Test procedures
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://host.docker.internal:11434` | **Direct** to Ollama's OpenAI-compat `/v1/chat/completions`. Do **not** point this at ollama-manager's `:8002/proxy` for chat — that path has a 120 s read leg (`TIMEOUT_PROXY`) that breaks the agent loop on cold/CPU model loads (see repo `CLAUDE.md` → "Ollama call path"). The `:8002/proxy` URL is an explicit opt-in for tool-call observability + JSON repair + circuit breaker only; lifecycle + `/health.limits` live on ollama-manager `:8002`, **not** in the chat path. |
| `OLLAMA_READ_TIMEOUT` | `300` | Read timeout (s) for Ollama HTTP calls. Cold-loading a model on the Jetson can take 30-90s; long completions stream for minutes. Bump if a larger model on slower hardware times out during load. |
| `REDIS_URL` | `redis://localhost:6379` | Response caching |
| `MQTT_BROKER` | `mqtt://localhost:1883` | Event bus |
| `DEVICE_SECRET` | (required) | Device auth secret |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Orchestrator API for tool execution |
| `GRPC_PORT` | `50051` | gRPC listen port |

## Adding a New Tool

LLM-callable tools live in [`packages/tools-core/`](../../packages/tools-core/),
not in this service. Add a handler under
`packages/tools-core/src/handlers/<domain>/`, register it in
`packages/tools-core/src/registry.ts`, set `requiresWrite` and
`requiresConfirmation`, and add a unit test. The MCP server
(`services/mcp-server/`) picks it up automatically and the orchestrator's
agent loop will dispatch it. See the "LLM tool calling" section in the
repo root [CLAUDE.md](../../CLAUDE.md) for the full walkthrough.

## Running Locally

```bash
cd services/ai-gateway
pip install -r requirements.txt
ORCHESTRATOR_URL=http://localhost:3000 uvicorn main:app --port 8000
```

## Docker

```bash
docker compose up ai-gateway
```
