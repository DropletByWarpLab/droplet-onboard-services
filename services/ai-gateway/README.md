# AI Gateway

FastAPI + LiteLLM model routing proxy with tool execution. Routes LLM requests to local (Ollama on Jetson) or cloud providers, and executes tool calls against the orchestrator API.

## Architecture

```
Dashboard / API client
       │
       ↓
  Orchestrator (/api/llm/*)
       │
       ↓
  AI Gateway (FastAPI :8000)
  ├── LiteLLM router (multi-provider)
  ├── Tool executor (calls orchestrator REST API)
  └── gRPC server (:50051)
       │
       ├──→ Ollama (Jetson local inference)
       ├──→ OpenAI API
       ├──→ Anthropic API
       └──→ Other providers
```

## Tool System

The AI assistant can call tools to interact with the Droplet system. Tools are defined as OpenAI function-calling schemas and executed by making HTTP calls back to the orchestrator.

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
├── grpc_server.py       # gRPC interface for orchestrator
├── tools/
│   ├── definitions.py   # Tool schemas (OpenAI function-calling format)
│   └── executor.py      # Tool dispatch → orchestrator HTTP calls
├── Dockerfile
├── requirements.txt
└── TESTING.md           # Test procedures
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JETSON_OLLAMA_URL` | `http://inference-engine.local:11434` | Local Ollama endpoint |
| `REDIS_URL` | `redis://localhost:6379` | Response caching |
| `MQTT_BROKER` | `mqtt://localhost:1883` | Event bus |
| `DEVICE_SECRET` | (required) | Device auth secret |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Orchestrator API for tool execution |
| `GRPC_PORT` | `50051` | gRPC listen port |

## Adding a New Tool

1. **Define the schema** in `tools/definitions.py`:
   ```python
   ToolDefinition(
       function=ToolFunction(
           name="my_new_tool",
           description="What this tool does.",
           parameters={
               "type": "object",
               "properties": {
                   "param1": {"type": "string", "description": "..."},
               },
               "required": ["param1"],
           },
       )
   ),
   ```

2. **Add the handler** in `tools/executor.py`:
   ```python
   async def _my_new_tool(args: dict) -> dict:
       client = _get_client()
       resp = await client.get("/api/my-endpoint")
       resp.raise_for_status()
       return resp.json()
   ```

3. **Register** in the `TOOL_HANDLERS` dict in `executor.py`.

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
