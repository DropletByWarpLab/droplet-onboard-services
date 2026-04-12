# LLM Safety Tier System

The Droplet platform prevents the AI assistant (and any API client) from performing dangerous hardware operations without explicit user approval. All destructive actions are classified into safety tiers.

## Tiers

| Tier | Behavior | Examples |
|------|----------|---------|
| **Tier 1** | Auto-execute (with rate limiting) | Read port status, list VLANs, get camera list, WiFi scan |
| **Tier 2** | Requires user confirmation token | Delete camera, disable PoE, create/delete VLAN, change SSID, firewall rules |
| **Tier 3** | Blocked for AI entirely | Reboot, factory reset, VPN config, disable Jetson's switch port |

## How Confirmation Works

1. LLM calls a Tier 2 tool (e.g., `set_port_poe`)
2. Orchestrator returns HTTP 202 with `confirmationToken`
3. LLM tells user: "This requires your confirmation in the dashboard"
4. User clicks Confirm in the dashboard (sends token to `/command/confirm`)
5. Orchestrator executes the operation and logs it

Tokens expire after 60 seconds. Each confirmation is logged to the audit trail.

## Protected Operations

### Switch
| Operation | Tier | Why |
|-----------|------|-----|
| `switch_port_enable` | 2 | Could re-enable a quarantined port |
| `switch_port_disable` | 2 | Could disconnect a device |
| `switch_disable_protected_port` | **3** | Would sever Jetson's management connection |
| `switch_create_vlan` | 2 | Network topology change |
| `switch_delete_vlan` | 2 | Could orphan devices |
| `switch_set_vlan_membership` | 2 | Could isolate the Jetson |
| `switch_poe_enable` | 2 | Could power unexpected devices |
| `switch_poe_disable` | 2 | Could kill camera power |
| `switch_setup_cameras` | 2 | Bulk VLAN reassignment |

### Camera
| Operation | Tier | Why |
|-----------|------|-----|
| `delete_camera` | 2 | Permanent data loss |
| `disable_camera` | 2 | Stops surveillance |
| `camera_subnet_setup` | 2 | Network infrastructure change |
| `camera_subnet_teardown` | 2 | Removes security isolation |

### Router/Network
| Operation | Tier | Why |
|-----------|------|-----|
| `set_wifi_ssid` | 2 | Disconnects all wireless clients |
| `set_wifi_password` | 2 | Locks out WiFi users |
| `block_device` / `unblock_device` | 2 | Firewall change |
| `add_port_forward` | 2 | Exposes internal services |
| `interface_down` | 2 | Could sever LAN/WAN |
| `reboot` | **3** | Service interruption |
| `factory_reset` | **3** | Total data loss |

## Protected Port

The `SWITCH_PROTECTED_PORT` environment variable designates the switch port the Jetson is connected to. Disabling this port is classified as Tier 3 (blocked for AI), preventing the LLM from ever severing its own management connection.

Set in docker-compose or .env:
```
SWITCH_PROTECTED_PORT=10
```

## Service-to-Service Auth

The routing and switch services require a `SERVICE_SECRET` Bearer token on all endpoints (except `/health`). This ensures only the orchestrator — which enforces the safety tier system — can send commands to hardware. Direct access from other containers is blocked.

```
Orchestrator (has SERVICE_SECRET) → Routing Service (validates token) → Router
                                  → Switch Service (validates token)  → Switch
```

## LLM Information Redaction

Camera IP addresses and MAC addresses are stripped from LLM tool responses (`get_cameras`). The AI has no legitimate need for internal network topology — it works with camera names, status, and detection events.

## Audit Trail

All Tier 2 and Tier 3 operations are logged to `CommandAuditLog` in the database:
- Who requested it (userId)
- What was requested (operation, parameters)
- Whether it was confirmed, blocked, or rate-limited
- Timestamp

Query the audit log: `GET /api/network/audit`
