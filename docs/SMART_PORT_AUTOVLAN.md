# Smart-Port Auto-VLAN

Multi-session design for **per-port device classification**: a computer plugged into the Lantronix lands on the Droplet LAN, a camera plugged into the same port automatically gets moved into the isolated CAMS VLAN. Builds on the static camera VLAN model in [`docs/camera-system.md`](camera-system.md); this doc is the dynamic extension.

> **Status:** Phase 1 shipped in PR #TBD (today's session — single-VLAN baseline + plumbing). Phase 2+ are scoped Jira tickets — see [Roadmap](#roadmap) below.

---

## Why this exists

The production camera design already specifies a separate CAMS VLAN (100) and the orchestrator already has `/api/switch/setup/cameras` to bulk-tag ports. That works once an operator has identified which ports will carry cameras. It does NOT handle:

- A camera plugged into a port that was previously a computer port.
- A new camera that the operator wasn't expecting.
- A port that flips between use-cases over the appliance's lifetime.

Auto-VLAN closes that gap. The default state is "trust LAN"; new devices are classified the moment they appear and the port gets moved if needed.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Lantronix SM8TAT2SA (8x PoE + 2x SFP)                              │
│                                                                    │
│  Port 1-8: PoE copper        ← devices plug in here                │
│  Port 9-10: SFP fiber        ← uplink to host enp12s0 (port 10)    │
│                                                                    │
│  PVID per port flips between VLAN 1 (LAN) and VLAN 10 (CAMS)       │
│  based on LLM classification.                                      │
│                                                                    │
│  Uplink (port 10) is a TRUNK: tagged VLAN 1 + VLAN 10.             │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│ Host (Droplet POC box)                                             │
│                                                                    │
│  br-lan       (untagged VLAN 1, 192.168.20.0/24)  ← LAN devices    │
│  br-lan.10    (tagged   VLAN 10, 192.168.30.0/24) ← cameras        │
│                                                                    │
│  Both served by dnsmasq instances bound to those bridges.          │
│  Inter-VLAN routing handled by an nftables ruleset (LAN→CAMS       │
│  blocked except for the Frigate/ONVIF host process).               │
└────────────────────────────────────────────────────────────────────┘
                                ↑
┌────────────────────────────────────────────────────────────────────┐
│ Event source (services/switch/watcher.py — Phase 3)                │
│                                                                    │
│  Lightweight loop that watches three signals and publishes MQTT    │
│  events when ANY of them changes:                                  │
│    - new MAC in switch's dynamic_mac_table                         │
│    - PoE class transition (no PD → class N, or N → no PD)          │
│    - new lease in droplet-poc-lan.leases                           │
│                                                                    │
│  Topic: smart-port/event   Payload: { port, mac, oui, poe_class,   │
│                                       ip, hostname, source }       │
│                                                                    │
│  NO classification logic of its own — only the "something just     │
│  happened" signal. Classification + action are the LLM's job.      │
└────────────────────────────────────────────────────────────────────┘
                                ↓ MQTT event
┌────────────────────────────────────────────────────────────────────┐
│ Local LLM (orchestrator agent loop, via tools-core)                │
│                                                                    │
│  The classifier IS the LLM. Triggered by the MQTT event OR by an   │
│  operator prompt ("a new camera was plugged in, can you add it?"). │
│  Runs the ReAct loop using MCP tools to decide what kind of device │
│  appeared and what to do about it.                                 │
│                                                                    │
│  Why LLM and not a hardcoded classifier:                           │
│    - Vendor-specific init flows differ wildly (Hanwha RSA, Axis    │
│      mDNS setup, Reolink first-boot wizard) — easier to lean on    │
│      the LLM's pretrained knowledge than maintain a per-vendor     │
│      decision tree in the daemon.                                  │
│    - Operators can intervene mid-flow ("no, that's actually a      │
│      laptop, keep it in LAN") without code changes.                │
│    - Falls back gracefully on novel hardware: if classification is │
│      ambiguous the LLM asks the operator instead of guessing.      │
│                                                                    │
│  Tools the LLM uses (most already exist — see "Tool catalog"       │
│  below):                                                           │
│    get_switch_ports, get_switch_poe, set_port_vlan,                │
│    list_discovered_cameras, scan_for_cameras,                      │
│    get_camera_init_status (NEW), initialize_camera (NEW),          │
│    accept_discovered_camera                                        │
└────────────────────────────────────────────────────────────────────┘
```

The smart-port system is **LLM-driven, not deterministic-daemon-driven**. The Phase 3 watcher is just an event source; the Phase 4+ adoption logic is the orchestrator's agent loop talking to MCP tools.

---

## VLAN layout

| VLAN | Subnet | Purpose | Notes |
|------|--------|---------|-------|
| 1 (default) | 192.168.20.0/24 | LAN — computers, phones, default landing zone | dnsmasq on host's `br-lan` |
| 10 | 192.168.30.0/24 | CAMS — cameras, NVRs, intercoms | dnsmasq on `br-lan.10`; isolated from VLAN 1 by default |

**Why VLAN 10 and not VLAN 100** (which `docs/camera-system.md` originally specified)?
Live recon of the photo-studio POC's Lantronix turned up an **already-deployed VLAN map** from the previous build: VLAN 1 = LAN (ports 2, 3, 10), **VLAN 10 = cameras (ports 1, 4, 7, 8, 9)**, VLAN 100 = a third zone (port 6), and port 5 was a trunk to an upstream router. The daemon adopts the existing VLAN 10 instead of inventing a new "VLAN 50" — saves a re-config pass on every existing customer switch and matches what the operator already sees in the web UI. Production deployments still get `.env` overrides if their own switch uses a different ID.

**Why 192.168.20.0/24 / 192.168.30.0/24?** Stays inside RFC1918 ranges already used by the appliance (`.10.x` = mgmt, `.20.x` = LAN today). The CAMS jump to `.30.x` keeps the per-subnet maps easy to recognize without colliding with any home-router default range.

---

## LLM classification flow

The MQTT event lands at the orchestrator. The agent loop runs a prompt roughly like:

> Switch port `<N>` just learned a new device: MAC `<mac>` (OUI `<oui>`), PoE class `<class>`, current IP `<ip>` if any. Decide whether this is a camera, a computer, or something else, and act on it. Available tools: get_switch_ports, get_switch_poe, list_discovered_cameras, get_camera_init_status, initialize_camera, scan_for_cameras, accept_discovered_camera, set_port_vlan.

Heuristics the LLM has from training + can verify with tools:

- **OUI lookup** (camera vendors: Hanwha `E4:30:22`, Axis `00:40:8C`, Hikvision `BC:AD:28`/`C0:51:7E`, Dahua `4C:11:BF`, Reolink `EC:71:DB`, Amcrest `9C:8E:CD`, etc.). The LLM compares the observed OUI against its training data; we don't ship a watchlist.
- **PoE class 3+** + **port 554 (RTSP)** + **port 80/443 with non-browser headers** → almost certainly a camera.
- **ONVIF probe** at `http://<ip>/onvif/device_service` (anonymous GetDeviceInformation) — if it speaks ONVIF, it's a camera.
- **DHCP hostname** containing model strings (`XNV-`, `AXIS-`, `HIK-`, `IPC-`, etc.) — strong signal.
- **DHCP vendor-class-id** — fallback for cameras without ONVIF.

The LLM doesn't need a deterministic decision tree — it weighs the evidence the same way it would for any classification task and either acts confidently (run `set_port_vlan` + `initialize_camera` + `accept_discovered_camera`) or asks the operator for confirmation through the existing Tier-2 prompt path.

### Why LLM and not a hardcoded classifier daemon

Previous version of this doc proposed a Python classifier with a decision tree. Stefan flagged on 2026-05-21 that this should be the **local LLM's job**, not a daemon's. The reasons hold up:

1. Vendor-specific init flows are not stable enough to encode once. Hanwha cameras went through three different init-cgi shapes between 2018–2022; Reolink rolled out a wholesale rewrite in 2024. The LLM pulls the right flow from training; the daemon would need a rolling update for every camera model the field deploys.
2. ONVIF probes catch off-brand cameras whose OUI isn't on any vendor list — but the LLM still needs to *interpret* the probe's response (which profiles to pull, which stream URI to feed Frigate). A daemon can do the probe; only the LLM can read the response intelligently.
3. The Lantronix has a built-in `voice_vlan_oui` feature that auto-moves OUI-matched MACs to a target VLAN. We push the OUI watchlist into that table as an *optimization* (Phase 5) so the switch handles routine cases without bothering the LLM, and the LLM stays involved for edge cases + demotion (cam unplugged → port back to LAN).
4. Operators trust an LLM that asks "this looks like an Amcrest cam, OK to add?" more than they trust a daemon that silently moves ports.

### Tool catalog (state of `packages/tools-core/src/handlers/` on this branch)

| Tool | Status | Notes |
|---|---|---|
| `get_switch_ports` / `get_switch_poe` / `get_switch_vlans` | ✅ exists | Reads via the orchestrator's switch service client. |
| `set_port_vlan` / `set_port_poe` / `setup_camera_ports` | ✅ exists | Writes; Tier 2 (operator confirm). |
| `detect_wan_port` | ✅ exists | Used by setup wizard. |
| `list_cameras` / `list_discovered_cameras` / `scan_for_cameras` | ✅ exists | Camera-discovery surface. |
| `accept_discovered_camera` | ✅ exists | Adds to Frigate via the discovery service. |
| `get_camera_snapshot` / `get_camera_live_url` / `list_camera_events` | ✅ exists | Operator consumption. |
| `get_camera_init_status(ip)` | ⬜ **MISSING** | Wraps `GET /cameras/{ip}/init-status` on camera-discovery. Returns `{vendor, initialized, needs_initialization}`. Tier 1 (read-only). |
| `initialize_camera(ip, username?, password?)` | ⬜ **MISSING** | Wraps `POST /cameras/{ip}/initialize`. Tier 2 — writes to the camera. |
| `add_camera_to_frigate(name, rtsp_url)` | ⬜ **MISSING** | Manual override path for when `accept_discovered_camera` writes a wrong URL (Hanwha case). Tier 2. Removable once `services/camera-discovery/frigate_client.py` learns ONVIF GetStreamUri. |

Three new tool handlers + one bug fix in camera-discovery are what stand between today's manual flow and an LLM-driven flow. All three of the missing tools are thin proxies over endpoints camera-discovery already exposes.

---

## Inter-VLAN policy

Default deny between VLAN 1 and VLAN 10. Specific allowances:

| From | To | Allow | Reason |
|------|----|-------|--------|
| Host (Frigate) | CAMS | ✓ | RTSP pull, ONVIF, snapshot |
| Host (camera-discovery) | CAMS | ✓ | Scan + probe |
| CAMS | Host (NTP, DNS) | ✓ | Time + name resolution |
| CAMS | CAMS | ✗ | No lateral cam→cam |
| LAN | CAMS | ✗ | LAN users get to cameras via the dashboard, not direct |
| CAMS | LAN | ✗ | Cameras must not reach user devices |
| CAMS | WAN | ✗ by default, opt-in per camera | Most cams don't need internet; firmware-update flow opens a temporary path |

Enforcement lives in an nftables ruleset shipped under `openwrt/poc-single-box/nftables-vlan.conf`. (Production appliances hand this off to OpenWrt's firewall, but on the POC's single box the host does it directly.)

---

## Phase 1 — landed in this PR

Everything below is the floor the daemon will sit on. Today the system is **single-VLAN** (everything in VLAN 1, on 192.168.20.0/24) — enough to verify Frigate end-to-end while we lay the auto-classification pipework.

- ✅ Host-side DHCP on `br-lan` via dedicated dnsmasq instance.
  See [`scripts/poc/droplet-poc-lan-dhcp.conf`](../scripts/poc/droplet-poc-lan-dhcp.conf) and `scripts/poc/droplet-poc-host-net.service`.
- ✅ Persistent `/32` route to the Lantronix mgmt IP so the orchestrator's `switch` service can reach `192.168.1.77` without re-IPing either side.
- ✅ `.env` wired with `SWITCH_HOST` / `SWITCH_USERNAME` / `SWITCH_PASSWORD` / `SWITCH_DRIVER=lantronix` and `CAMERA_SUBNET=192.168.20.0/24`.
- ✅ `switch` + `camera-discovery` services enabled via the `full` Compose profile.
- ✅ `docker/frigate/config.yml`: dropped the stale static `front_door` entry pointing at a long-gone IP — it was pinning Frigate to a ffmpeg connection-timeout loop that interfered with auto-adoption. File is now `cameras: {}` with a worked example in the comment header.
- ✅ Port 7 (camera) moved from the legacy VLAN 10 back to VLAN 1 (running config only — `/config/conf_save` returns 500 on JSON bodies, persistence across switch reboot is Phase 2 follow-up).
- ✅ Camera plugged into Lantronix port 7 (PoE class 3, ~7.8 W) gets a DHCP lease and is auto-adopted into Frigate. The cam (Hanwha XNV-C8083R, OUI `E4:30:22`) lands at `192.168.20.176`.
- ✅ Hanwha first-run init flow (`/init-cgi/pw_init.cgi?msubmenu=statuscheck&action=view` -> RSA-encrypt -> `setinitpassword`) wired and verified live — runs automatically through `vendor_init.py` when the camera reports `Initialized=False` and `CAMERA_AUTO_INITIALIZE=1`.
- ✅ Frigate is **live** on `hanwha_dome`, ~5 fps capture / 8 fps detect, 1280x720 JPEGs in `/api/hanwha_dome/latest.jpg`. The disk config in `docker/frigate/config.yml` carries the explicit RTSP URL with creds (manual entry, since the camera-discovery auto-add still defaults to `rtsp://<ip>:554/stream1` with no creds — see "Carryover" below).

Bring-up procedure:

```bash
# On the POC box, after pulling this branch:
sudo bash scripts/poc/install-poc-host-net.sh
# Add to .env:
#   SWITCH_HOST=192.168.1.77
#   SWITCH_USERNAME=admin
#   SWITCH_PASSWORD=<the same password as docker/secrets/openwrt_password>
#   CAMERA_SUBNET=192.168.20.0/24
#   CAMERA_DEFAULT_USERNAME=admin
#   CAMERA_DEFAULT_PASSWORD=<your camera bootstrap password>
#   CAMERA_AUTO_INITIALIZE=1
#   ONVIF_WS_DISCOVERY_ENABLED=1
docker compose --profile full -f docker/docker-compose.yml -p droplet-pi-platform up -d switch camera-discovery
```

---

## Roadmap

| Phase | Ticket (proposed) | Scope |
|-------|-------------------|-------|
| 1 — Foundation (this PR) | — | DHCP on br-lan, switch reachable, single-VLAN camera path working, Hanwha cam live in Frigate via manual override. |
| 2 — VLAN segmentation + switch mgmt re-IP + camera-discovery URL fix | WARP-NEW-A | VLAN 10 (CAMS) reactivated on switch + `br-lan.10` on host + per-VLAN dnsmasq + nftables policy. Re-IP Lantronix mgmt 192.168.1.77 → 192.168.20.77 so the switch survives when the home router (and its `192.168.1.0/24` subnet) goes away. Fix `services/camera-discovery/frigate_client.py` so `accept_discovered_camera` writes a real ONVIF-probed RTSP URL with Digest creds (Hanwha = `/profile2/media.smp`, not `/stream1`). Removes the need for `add_camera_to_frigate`. |
| 3 — Event source + missing LLM tools | WARP-NEW-B | `services/switch/watcher.py` (lightweight loop, publishes `smart-port/event` over MQTT). Three new tool handlers in `packages/tools-core/src/handlers/cameras/`: `get_camera_init_status`, `initialize_camera`, `add_camera_to_frigate`. Wire them through the orchestrator's MCP server + register in `registry.ts`. Tier-2 confirm UX in the dashboard. |
| 4 — LLM adoption agent | WARP-NEW-C | Orchestrator subscribes to `smart-port/event` MQTT topic, kicks off an agent loop with a `new-device-on-switch` system prompt. Loop uses the tools from Phase 3 to classify + adopt or surface to operator. Audit log entry per port flip. Demotion path (cam unplugged → port back to LAN) is the same agent reacting to a `device-disappeared` event. |
| 5 — Voice-VLAN-OUI hand-off | WARP-NEW-D | Push known camera OUIs into the switch's native `voice_oui_vlan_table` so routine cases move at the switch without bothering the LLM. The agent stays involved for novel OUIs, demotion, and audit. |
| 6 — Dashboard surface | WARP-NEW-E | `/cameras` page gets a "Network" tab with per-port live status (class, MAC, PoE, PVID), manual override, and a feed of the LLM's recent adoption decisions. |

Each phase is independently shippable — Phase 3's tools let the LLM run the adoption flow on-demand (operator prompt) before Phase 4 makes it event-driven.

---

## Droplet-replaces-home-router future direction

The end state Stefan flagged on 2026-05-21: the Droplet eventually **replaces the home router entirely**. The home `192.168.1.0/24` segment goes away; the Droplet's WAN side terminates the ISP handoff directly, and everything downstream is the Droplet's own LAN. That changes what counts as "stable" for this design:

- **Switch mgmt IP `192.168.1.77` must move.** Today it's reachable via the `/32` host-route hack because `br-mgmt` shares that `/24` with the home router. When the home router goes away, that subnet goes too — the Lantronix would be orphaned at an address with no upstream gateway and no host route. Phase 2 needs a one-shot migration that re-IPs the switch to something inside the Droplet's own LAN range (e.g. `192.168.20.77/24` on `br-lan` natively) or a dedicated mgmt VLAN. Once the switch is on a Droplet-owned subnet, the `/32` route in `droplet-poc-host-net.sh` becomes a no-op and gets deleted.
- **No camera or service config may reference `192.168.1.x`.** Cameras live on `192.168.30.0/24` (VLAN 10 in Phase 2). Frigate, MQTT, the orchestrator, ops-console — all stay inside `192.168.10.x` / `192.168.20.x` / `192.168.30.x`. Anything that pins to `192.168.1.x` is a regression to fix before the home-router switchover.
- **DHCP / DNS / WireGuard upstream all migrate to the Droplet.** OpenWrt's container already runs DHCP for the Wi-Fi AP segment; the host's `droplet-poc-host-net.service` runs DHCP for `br-lan`. When the home router goes, the Droplet's WAN side needs PPPoE / DHCP-client (whatever the ISP hands it), and `ethmgmt` becomes the WAN interface (not the LAN-to-home uplink it is today). The smart-port classifier doesn't care which side faces the ISP — it only manages the downstream switch ports — but the operations runbook has to.
- **No customer-visible disruption during cutover.** Existing LAN/CAMS clients keep their leases as long as the dnsmasq pool stays the same. The cutover is just "swap which port is WAN" + reboot.

This doc treats the home router as a temporary upstream that's allowed to disappear. Any code in this PR or its successors that bakes in `192.168.1.x` is a bug.

## Open questions

1. **Should LAN clients reach the dashboard directly or only via the home network?**
   Today the dashboard is reachable via the host's `br-mgmt` (`https://droplet-ai.local/`). Once LAN devices (computers) live on `br-lan` (VLAN 1), they need a path to the dashboard too — probably an nginx side-listen on `192.168.20.1`. Not decided.
2. **WireGuard peer subnets vs the new VLANs.**
   `dhcp-option=3` on the LAN points at `.20.1`. Remote peers entering via WireGuard see a different topology. Need a quick check that the routing tables align.
3. **Where does the OUI watchlist live?**
   Two options: in-repo JSON (versioned with the code) or operator-editable on the appliance. Probably both, with the in-repo file as the default + an override path on disk.
4. **PoE classes 0–2 (low-power devices: APs, sensors).**
   Currently the decision tree skips them. If a Class-0 ONVIF camera shows up (rare but possible) we'd miss it. Worth a follow-up.

## Lantronix SM8TAT2SA REST endpoint map (firmware v1.04.0079)

Capture from live recon — `services/switch/drivers/lantronix.py` doesn't fully match. Use these names directly until the driver is updated in Phase 2.

| Working endpoint | Method | Body envelope |
|---|---|---|
| `/config/login` | GET → POST | `{"users_login_auth": {"agent": 4, "username": ..., "password": ..., "userip": ...}}` (userip pulled from the GET response). Client-side cookies `cid`/`seid`/`sesslid` must be pre-set; switch never sends `Set-Cookie`. |
| `/stat/sysinfo` | GET | — |
| `/stat/ip_status` | GET | — |
| `/stat/port_status` | GET | — |
| `/stat/poe_status` | GET | — |
| `/stat/lldp_neighbor` | GET | — |
| `/stat/dynamic_mac_table` | GET (use `--compressed`) | — (gzipped response) |
| `/stat/diagcable?port=N` | GET | TDR cable diagnostic |
| `/stat/voice_oui_vlan_table` | GET | Pre-existing OUI→VLAN auto-classify feature; usable as the Phase 5 hand-off path. |
| `/config/vlan` | GET, POST | POST envelope: `{"vlan_config_set": {"conf": [...per-port...], "allow_vlans": "1,10,...", "cust_tpid": 34984}}` — per-port shape: `{port, mode, pvid, portype, infilter, inaccept, etagging, allowedvlan}`. |
| `/config/poe_config` | GET, POST | POST envelope: `{"poe_config_set": {"poe_mgmt_mode": ..., "capacitor": ..., "poe_config": [{Port, Mode, Pri, MaxPwr, pid}, ...]}}` — `Mode: 0`=disabled, `Mode: 2`=auto. |
| `/config/ports` | GET, POST | POST envelope: `{...port_state_set wrapper TBD...}` — only the GET shape is confirmed; saving config returned 500. |
| `/config/diagnostic` | POST | `{"port": N}` to trigger cable diagnostic. |
| `/config/conf_save` | POST | **500 on every JSON body shape attempted** — running-config changes don't persist across switch reboot today. Phase 2 follow-up to figure out the right form-data shape. |

Wrong endpoint names in the current driver: `/stat/port`, `/stat/vlan`, `/stat/vlan_membership`, `/stat/mac_table`, `/config/poe`, `/config/ports` (the per-port shape) — these either 404 or return empty stubs.

---

## Cross-references

- [`docs/camera-system.md`](camera-system.md) — base camera architecture (production OpenWrt + Switch model).
- [`docs/ADR-005-canonical-system-architecture.md`](ADR-005-canonical-system-architecture.md) — appliance-wide architecture; the smart-port daemon plugs into the switch service per the Apps Board surface.
- [`scripts/poc/droplet-openwrt-attach.sh`](../scripts/poc/droplet-openwrt-attach.sh) — POC's other host-network bring-up script. The smart-port host-net unit follows the same install pattern.
- [`services/switch/drivers/lantronix.py`](../services/switch/drivers/lantronix.py) — `LantronixDriver`, the switch-API surface the daemon will drive.
