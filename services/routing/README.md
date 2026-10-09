# Routing Service

FastAPI wrapper around the Droplet OpenWrt SDK. Exposes the OpenWrt router's ubus JSON-RPC API as REST endpoints for the orchestrator and AI gateway.

## Architecture

```
Orchestrator ──→ Routing Service (FastAPI :8080) ──→ OpenWrt Router (ubus JSON-RPC)
AI Gateway ────┘                                     192.168.50.1 (multi-box)
                                                     127.0.0.1:8181 (single-box)
```

The routing service runs with `network_mode: host` so it can reach the router directly. All requests go through the orchestrator's auth middleware before reaching this service.

## REST API

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Router connectivity check. Carries `error_code` (`ROUTER_AUTH` / `ROUTER_PAIRED_ELSEWHERE` / null) and the `pairing` block below |

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

- While the service is in the AUTH state (router answers, rejects the `droplet-ai` credential) the background reconnect tick also calls `droplet.pair status` with the **null session** and caches the result. No probing happens while connected or while the router is merely unreachable.
- Connected: `state` is `paired` after a successful claim in this process (or a `paired` probe), otherwise `unknown`.
- `paired_elsewhere` is true when the router reports `paired` with a `paired_box` that is not this box's fingerprint. The fingerprint comes from the orchestrator (first `POST /pairing/claim`, or `PUT /pairing/identity`); while it is unknown the state is never raised. Router-backed routes then answer HTTP 502 `{"detail": {"code": "ROUTER_PAIRED_ELSEWHERE", "paired_box": ...}}` instead of `ROUTER_AUTH`, and `/health` sets `error_code` accordingly. Logged once per distinct foreign fingerprint.

### Router pairing (ADR-071 slice B)
All routes require the service token.

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/pairing/identity` | `{"box_fingerprint": "<64 hex>"}` — tell routing which box it serves (enables `ROUTER_PAIRED_ELSEWHERE`) |
| POST | `/pairing/claim` | `{"box_fingerprint": "<64 hex>"}` — mint a 32-hex password, `droplet.pair claim`, prove it by logging in with it, switch the live session, clear the AUTH state, reconnect immediately. `200 {"ok": true, "password", "host", "model", "paired_at"}` |
| GET | `/pairing/pending` | `{"pending": bool, "password": "<32hex>" \| null, "paired_at": ...}` — a minted password the orchestrator has not yet confirmed persisted |
| POST | `/pairing/persisted` | Orchestrator confirms the password is saved; routing forgets it. `{"ok": true}` |

`POST /pairing/claim` errors are `{"code", "detail"}` (plus `paired_box` for the elsewhere case): `400 INVALID_FINGERPRINT`, `409 PAIR_WINDOW_CLOSED`, `409 ROUTER_PAIRED_ELSEWHERE`, `502 PAIR_UNSUPPORTED` (no `droplet.pair` plugin, or `ROUTING_MODE` is not `real`), `502 PAIR_CLAIM_FAILED`, `502 PAIR_VERIFY_FAILED` (claim accepted but login with the new password failed: logged at ERROR, AUTH state kept, nothing switched), `503 ROUTER_UNREACHABLE`. The password appears only in the 200 body and `GET /pairing/pending`; it is never logged.

### AP pairing (ADR-071 slice C, §2.3)
The external AP's `droplet.pair` window (the same rpcd plugin as the router's) is claimed through the AP onboarding path. All routes require the service token; the AP's address is resolved from the same live mDNS inventory `POST /aps/{mac}/approve` uses, so they need the router session.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/aps/{mac}/pairing` | The AP's `droplet.pair status` (null session), shaped for the orchestrator's pairing service: `{mac, host, connected: null, error_code, pairing: {state, window_ends_at, paired_box, paired_elsewhere, pending_persist}}`. `error_code` is `AP_PAIRED_ELSEWHERE` / `AP_UNREACHABLE` / null. A plugin-less AP is `state: "unknown"`, not an error. |
| POST | `/aps/{mac}/pairing/claim` | `{"box_fingerprint": "<64 hex>"}` — mint a 32-hex password, claim **that** AP, prove it by logging in to the AP as `droplet-ai`, then every AP-direct call uses it. `200 {"ok": true, "password", "host", "mac", "model", "paired_at"}` |
| GET | `/aps/pairing/pending` | `{"pending", "password", "paired_at", "mac"}` — an AP password minted but not yet confirmed persisted |
| POST | `/aps/pairing/persisted` | Orchestrator confirms `ap_openwrt_password` is saved. `{"ok": true}` |

Claim errors are `{"code", "detail"}`: `400 INVALID_FINGERPRINT`, `409 PAIR_WINDOW_CLOSED`, `409 AP_PAIRED_ELSEWHERE` (+ `paired_box`), `502 PAIR_UNSUPPORTED`, `502 AP_UNREACHABLE` (AP not in the inventory), `503 AP_UNREACHABLE` (inventory has it, it does not answer), `502 PAIR_CLAIM_FAILED`, `502 PAIR_VERIFY_FAILED` (nothing switched on the box). The password appears only in the 200 body and `GET /aps/pairing/pending`; it is never logged.

**Reloadable AP credential.** AP-direct calls resolve the password through `current_ap_password()`: the password claimed in this process, else the `ap_openwrt_password` secret file re-read per call, else the value read at import. A freshly paired AP is therefore approvable with no restart, and "is an AP credential configured?" is answered from the holder rather than from an import-time constant.

**Limitation: one AP secret.** ADR-071 §2.3 keeps a **single** `ap_openwrt_password` for every AP (`docker/secrets/ap_openwrt_password`, one file the compose file reads). Pairing a second AP therefore **overwrites** the credential the first AP was paired with; the first reads `AP_AUTH` on the next AP-direct call until it is paired again. This is deliberate for now (per-device escrow rows are future work and are not invented here); with one AP per box, which is the shipping shape, nothing is lost. The AP flow keeps its own pairing state, so a claim never touches the router's password or `/health.pairing`.

### Network
| Method | Path | Description |
|--------|------|-------------|
| GET | `/network/summary` | Full network summary (interfaces, wireless, DHCP, firewall) |
| GET | `/network/interfaces` | All interface statuses |
| GET | `/network/interfaces/{name}` | Single interface status |
| POST | `/network/interfaces/{name}/up` | Bring interface up |
| POST | `/network/interfaces/{name}/down` | Bring interface down |

### Wireless
| Method | Path | Description |
|--------|------|-------------|
| GET | `/wireless/status` | WiFi radio status |
| GET | `/wireless/scan` | Scan available networks |
| GET | `/wireless/clients` | Connected WiFi clients |
| POST | `/wireless/ssid` | Set SSID |
| POST | `/wireless/password` | Set WiFi password |
| POST | `/wireless/channel` | Set channel |
| POST | `/wireless/guest` | Create guest network |

### DHCP
| Method | Path | Description |
|--------|------|-------------|
| GET | `/dhcp/leases` | Active DHCP leases (IPv4) |
| GET | `/dhcp/leases/v6` | Active DHCP leases (IPv6) |
| POST | `/dhcp/static-lease` | Add static IP reservation |
| POST | `/dhcp/dns` | Set upstream DNS servers |

### Firewall
| Method | Path | Description |
|--------|------|-------------|
| GET | `/firewall/zones` | Firewall zones |
| GET | `/firewall/rules` | Firewall rules |
| GET | `/firewall/redirects` | Port forwarding rules |
| POST | `/firewall/block-device` | Block device by MAC |
| POST | `/firewall/unblock-device` | Unblock device by MAC |
| POST | `/firewall/port-forward` | Add port forwarding rule |

### VLANs / Camera Subnet
| Method | Path | Description |
|--------|------|-------------|
| GET | `/network/vlans` | List all configured VLANs |
| POST | `/network/vlans` | Create a new VLAN |
| GET | `/network/subnets/cameras` | Camera subnet status and config |
| POST | `/network/subnets/cameras/setup` | One-click camera subnet setup (VLAN + firewall + DHCP) |
| DELETE | `/network/subnets/cameras` | Remove camera subnet |

### Remote Access (WireGuard VPN)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/vpn/setup` | Idempotent: bring up the wg interface, generate server keypair, install firewall zone + WAN allow rule. Returns the server pubkey and `created: true/false`. |
| GET | `/vpn/status` | Server pubkey, listen port, addresses, peer count. 404 until `/vpn/setup` is called. |
| GET | `/vpn/peers` | List configured peers (no private keys ever returned). |
| POST | `/vpn/peers` | Mint a peer: server generates a fresh X25519 keypair, installs the pubkey on the router, returns the priv+pub keys ONCE. The orchestrator builds the client `.conf` from this response and renders it as a QR — the priv key is never stored server-side. |
| DELETE | `/vpn/peers` | Remove peers matching `public_key`. 404 if none match. |

Keypair generation is pure Python (Curve25519 via `cryptography`) — no shell-out to `wg genkey`, because the `droplet-ai` rpcd ACL deliberately denies `file.exec`. See [`droplet_openwrt_sdk.py::VPNApi`](droplet_openwrt_sdk.py).

After `/vpn/setup` commits the firewall changes, the routing service emits a `service event {type: "config.change", data: {package: "firewall"}}` ubus call. This is a workaround for an OpenWrt 24.10 ordering bug where the wg0 ifup hotplug fires `firewall reload` *before* the firewall config commit lands — without the explicit nudge, fw4 misses the new `Allow-WireGuard` rule on first run. ACL grants `service.event` for this purpose.

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/system/info` | Board info + resource usage |
| POST | `/system/reboot` | Reboot router |

### Config Management
| Method | Path | Description |
|--------|------|-------------|
| POST | `/config/apply` | Safe apply with automatic rollback on connectivity loss |

## Camera Subnet Setup

The `POST /network/subnets/cameras/setup` endpoint creates everything in a single atomic transaction with automatic rollback:

1. Bridge VLAN 100 on br-lan
2. `cameras` interface (192.168.100.1/24)
3. `cameras` firewall zone (REJECT/ACCEPT/REJECT)
4. Forwarding: LAN → cameras, cameras → WAN
5. Allow rules: camera DHCP, DNS, ping
6. DHCP pool: 192.168.100.100-249

If connectivity is lost during setup, all changes automatically roll back.

## OpenWrt SDK

The `droplet_openwrt_sdk.py` file provides a high-level Python SDK with sub-APIs:

| Sub-API | Class | Capabilities |
|---------|-------|-------------|
| Network | `NetworkApi` | Interface status, VLAN creation, IP configuration |
| Wireless | `WirelessApi` | WiFi scan, SSID/password, channel, guest networks |
| DHCP | `DHCPApi` | Active leases, static reservations, DNS |
| Firewall | `FirewallApi` | Zones, rules, forwarding, port forwards, device blocking |
| System | `SystemApi` | Board info, reboot, hostname |
| VPN | `VPNApi` | WireGuard management |
| UCI | `UCIApi` | Low-level config read/write/commit |

All config changes can be wrapped in `router.safe_apply(timeout=30)` for automatic rollback.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENWRT_HOST` | `192.168.50.1` | OpenWrt router IP. Default is the legacy multi-box bare-metal router host. `scripts/lib/single-box.sh` overrides it to `127.0.0.1` (in-container OpenWrt on `:8181`) on the single-box shape. |
| `OPENWRT_PORT` | `80` | OpenWrt uhttpd port (single-box override: `8181`). |
| `OPENWRT_USERNAME` | `droplet-ai` | rpcd user (single-box override: `root`). |
| `OPENWRT_PASSWORD_FILE` | `/run/secrets/openwrt_password` | Path to the Docker secret file containing the rpcd password. See "OpenWrt password" below. |
| `OPENWRT_PASSWORD` | (empty) | **Deprecated** — env fallback kept for local dev and upgrades. Prefer the secret file. |
| `ROUTING_SERVICE_TOKEN` | (empty) | Shared bearer enforced on all routes except `/health`. When empty, auth is disabled (dev only). Generated by `scripts/setup.sh`. |
| `ROUTING_MODE` | `real` | `real` (default) connects to OpenWrt. `mock` swaps in a fixture-returning stub so dev laptops work without a router. `disabled` is an orchestrator-side flag; this service runs fine with it. See WARP-44. |
| `DROPLET_WIFI_SCAN_DEVICE` | (empty → `wlan0`) | Wi-Fi radio the SDK scans when the `/wireless/scan` and `/wireless/clients` callers omit an explicit `device`. Empty falls back to the literal `wlan0` (multi-box UCI radio). `scripts/lib/single-box.sh` sets it to the single-box AP radio `wlp14s0` (sourced from `DROPLET_AP_IFACE`). See WARP-815. |
| `PORT` | `8080` | Service listen port |

## Authentication

All routes except `GET /health` require `Authorization: Bearer <ROUTING_SERVICE_TOKEN>`. Missing or mismatched tokens return `401`. To rotate: regenerate the token in `.env`, restart the routing, orchestrator, and camera-discovery containers.

## OpenWrt password

The rpcd password is mounted as a Docker secret at `/run/secrets/openwrt_password` (0600). The env var `OPENWRT_PASSWORD` is no longer present in `docker inspect` output. Resolution order at startup:

1. `OPENWRT_PASSWORD_FILE` (default `/run/secrets/openwrt_password`) — preferred
2. `OPENWRT_PASSWORD` env var — deprecated, logged as a warning

**Runtime reload (ADR-071).** The password is not frozen at startup: every router login resolves it through `current_openwrt_password()` — the password minted by a pairing claim in this process, else the secret file **re-read at login time**, else the value read at import. After a claim, routing therefore runs on the new password with no container recreate. The secret file still holds the old value until the orchestrator persists the new one (device-bridge `droplet-pair-apply`); a container recreate after persistence simply reads the new file. `POST /pairing/persisted` drops the in-memory copy once the file agrees with it, and keeps it otherwise so the process never regresses to a stale password.

To update the password:

```bash
# 1. Edit .env
sed -i '' 's/^OPENWRT_PASSWORD=.*/OPENWRT_PASSWORD=newvalue/' .env

# 2. Rewrite the secret file (writes atomically with chmod 600)
./scripts/setup.sh --sync-secrets

# 3. Restart the routing container
docker compose -f docker/docker-compose.yml restart routing
```

## Local Development

```bash
cd services/routing
pip install -r requirements.txt

OPENWRT_HOST=192.168.50.1 \
OPENWRT_PASSWORD=yourpassword \
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

## Mock mode (WARP-44)

Set `ROUTING_MODE=mock` in `.env` to swap the live OpenWrt SDK for a fixture-
driven stub. Every read endpoint returns realistic static data; every write
is a logged no-op. Useful for dev laptops, CI, and demos without a physical
router.

```bash
# .env
ROUTING_MODE=mock
# ...then:
npm run dev:docker
```

To disable router supervision entirely (orchestrator skips all routing
calls and the dashboard shows a "Router supervision disabled" banner):

```bash
ROUTING_MODE=disabled
```

Fixtures live inline in `mock_router.py`.

## Tests (WARP-45)

```bash
cd services/routing
pip install -r requirements-dev.txt
pytest
```

Fixtures in `tests/conftest.py` mock `DropletRouter`, so no live OpenWrt is needed. Add new tests in `tests/test_*.py`; shared fixtures (`connected_client`, `disconnected_client`, `mock_router`, `set_token`) stay reusable across future tickets.

CI runs this suite on every PR that touches `services/routing/` — see `.github/workflows/routing-tests.yml`.

## Docker

```bash
docker compose --profile full up routing
```

Runs with `network_mode: host` and `NET_ADMIN` capability for direct router access.

## Endpoints

## LLM Tools

The LLM network tools (defined in `packages/tools-core/src/handlers/network/`) call the orchestrator's safety-tiered REST surface, which fronts this service:

| Tool | Endpoint |
|------|----------|
| `get_network_status` | `/api/network/status` |
| `get_connected_devices` | `/api/network/devices` |
| `scan_wifi_networks` | `/api/network/wifi/scan` |
| `set_wifi_ssid` | `/api/network/wifi/ssid` |
| `set_wifi_channel` | `/api/network/wifi/channel` |
| `get_firewall_rules` | `/api/network/firewall` |
| `block_network_device` | `/api/network/firewall/block` |
| `unblock_network_device` | `/api/network/firewall/unblock` |
| `add_port_forward` | `/api/network/firewall/port-forward` |
| `get_router_system_info` | `/api/network/system` |
