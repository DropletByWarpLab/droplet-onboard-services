# LLM Safety Tier System

The Droplet platform prevents the AI assistant (and any API client) from performing dangerous hardware operations without explicit user approval. All destructive actions are classified into safety tiers.

## Tiers

| Tier | Behavior | Examples |
|------|----------|---------|
| **Tier 1** | Auto-execute (with rate limiting) | Read port status, list VLANs, get camera list, WiFi scan |
| **Tier 2** | Requires user confirmation token | Delete camera, disable PoE, create/delete VLAN, change SSID, firewall rules |
| **Tier 3** | Blocked for AI entirely | Reboot, factory reset, VPN config, disable Jetson's switch port |

### Desktop-client tools (the *target axis*)

[ADR-011](ADR-011-llm-client-dispatched-actions.md) extends this same model with a **target axis** — a tool call targets either `self` (the appliance, the default everything above assumes) or `client:{device_id}` (a paired desktop). Tier-2 client-target confirmations prompt on the **target device's native modal**, not the dashboard. Desktop tools are **default-off** (every tool is `block` until the user opts in per tool). `get_clipboard` and `screenshot` are **Tier-3 (blocked) on clients** in V1, pending the deep-assist ADR (WARP-549) + enrollment gate (WARP-550).

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

As of WARP-456, **`ActivityRow`** is the canonical audit table for every observable event on the device — chat turns, MCP tool calls, file indexing, camera writes, network ops, smart-home commands, email sends, auth events, scheduled tool runs, and system events. Every row carries an HMAC-SHA256 `signature` over its canonical content + the `prevSignatureHash` of the row before it, forming a tamper-evident hash chain. The chain is verifiable offline via `POST /api/activity/export`, which streams a sealed JSON-Lines bundle plus the public verification bytes.

`CommandAuditLog` is now a **read view** kept for the existing `GET /api/network/audit` query path; all new writes flow through `activity.service.ts::record({kind, severity, sourceIcon, what, sub?, refs?})`, which dual-writes the legacy `CommandAuditLog` row alongside the signed `ActivityRow`. Future audit consumers should read `ActivityRow` directly (filtered by `kind="network"` for the safety-tier-specific subset).

Both tables capture the same per-command facts:
- Who requested it (userId)
- What was requested (operation, parameters)
- Whether it was confirmed, blocked, or rate-limited
- Timestamp

Operator-facing query paths:
- `GET /api/activity?kind=network&from=&to=&q=` — paginated, filterable, signed rows (owner/admin).
- `POST /api/activity/export` — sealed JSONL bundle for offline verification.
- `GET /api/network/audit` — legacy `CommandAuditLog` view (kept for backwards compatibility).

### Factory-reset era boundary

`scripts/factory-reset.sh` is treated as an explicit chain-era boundary, not a soft-reset of state under a preserved key. Specifically, `data/secrets/audit.key` is deleted alongside the ActivityRow table contents and the Postgres volume, so the next `setup.sh` run regenerates a fresh 32-byte key via `sync_audit_signing_key` (`scripts/lib/secrets.sh`). The first ActivityRow written after the reset is the new chain's genesis — `prevSignatureHash = ""` — signed by the new key.

Why the boundary matters: preserving the old key against an empty ActivityRow table would silently fork the chain. Two distinct genesis rows would carry the same HMAC key, with no marker telling a verifier the rows belong to different histories. A signed export bundle from the new era would verify identically against the old era's archived bundle — meaningfully the same chain to any consumer, semantically two different ones.

The old key can still be retained off-device by the operator (export the bundle before `factory-reset`, store the verification bytes alongside it) — the verifier accepts the union of (current, prior) keys, so historical bundles remain verifiable. The box itself only carries the current era's key.

Era-boundary contract:

| Event | `data/secrets/audit.key` | `ActivityRow` rows | First post-event row |
|---|---|---|---|
| `setup.sh` on a fresh device | generated | 0 | genesis |
| `setup.sh` re-run on a provisioned device | preserved (existing chain continues) | N | next row in chain |
| `factory-reset.sh` | deleted | 0 (table dropped) | (none yet) |
| `setup.sh` after `factory-reset.sh` | regenerated (NEW key) | 0 | genesis of new era |
