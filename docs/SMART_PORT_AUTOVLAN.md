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
│  PVID per port flips between VLAN 1 (LAN) and VLAN 50 (CAMS)       │
│  based on classification.                                          │
│                                                                    │
│  Uplink (port 10) is a TRUNK: tagged VLAN 1 + VLAN 50.             │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│ Host (Droplet POC box)                                             │
│                                                                    │
│  br-lan       (untagged VLAN 1, 192.168.20.0/24)  ← LAN devices    │
│  br-lan.50    (tagged   VLAN 50, 192.168.30.0/24) ← cameras        │
│                                                                    │
│  Both served by dnsmasq instances bound to those bridges.          │
│  Inter-VLAN routing handled by an nftables ruleset (LAN→CAMS       │
│  blocked except for the Frigate/ONVIF host process).               │
└────────────────────────────────────────────────────────────────────┘
                                ↑
┌────────────────────────────────────────────────────────────────────┐
│ Smart-port classifier daemon (services/switch/classifier.py)       │
│                                                                    │
│  Inputs:                                                           │
│    - Lantronix PoE status     (per-port Pdclass, PwrUsed)          │
│    - Lantronix MAC table      (per-port MACs learned)              │
│    - dnsmasq lease file       (DHCP fingerprints + hostnames)      │
│    - ONVIF probe              (only on candidates)                 │
│    - OUI list                 (camera-vendor MACs)                 │
│                                                                    │
│  Output: port_state[port].class ∈ {unknown, lan, camera, isolated} │
│  Side-effect: switch.set_port_pvid(port, vlan) when class changes  │
└────────────────────────────────────────────────────────────────────┘
```

The classifier is a stateful loop, not a one-shot. It owns the port→VLAN mapping; the orchestrator's existing `/api/switch/setup/cameras` becomes a manual override.

---

## VLAN layout

| VLAN | Subnet | Purpose | Notes |
|------|--------|---------|-------|
| 1 (default) | 192.168.20.0/24 | LAN — computers, phones, default landing zone | dnsmasq on host's `br-lan` |
| 50 | 192.168.30.0/24 | CAMS — cameras, NVRs, intercoms | dnsmasq on `br-lan.50`; isolated from VLAN 1 by default |

**Why VLAN 50 and not VLAN 100** (which `docs/camera-system.md` mentions)?
The 100 in the existing doc refers to a future production network where the Lantronix is a customer-facing 24/48-port managed switch with multiple VLANs already in use. On the POC's 8-port Lantronix where we control everything, low VLAN IDs (1, 50) keep the per-port tables short and are easier to read at the CLI. Production deployments can renumber via `.env` overrides; the daemon doesn't care about the specific ID.

**Why 192.168.20.0/24 / 192.168.30.0/24?** Stays inside RFC1918 ranges already used by the appliance (`.10.x` = mgmt, `.20.x` = LAN today). The CAMS jump to `.30.x` keeps the per-subnet maps easy to recognize without colliding with any home-router default range.

---

## Device classification

The daemon classifies a port whenever any of these change:

- A new MAC appears in the switch's MAC table for that port.
- The PoE class changes (e.g. a new powered device just came up).
- A DHCP lease appears (or expires) on either bridge for a MAC observed on that port.

### Decision tree

```
1. PoE class on this port?
   ├── No → not a camera (skip ONVIF probe)
   └── Class 3/4 (~7.5W+) → candidate, continue
2. MAC OUI in CAMERA_VENDOR_OUIS?  (Hikvision, Dahua, Reolink, Axis, Hanwha, Amcrest, …)
   ├── Yes → CAMERA (move PVID to 50)
   └── No → continue
3. ONVIF probe at the device's current IP?
   ├── 200 from /onvif/device_service → CAMERA
   ├── No reply twice in 30s         → UNKNOWN (stay in LAN)
   └── Reply but not ONVIF-shaped    → UNKNOWN
4. DHCP vendor-class-id starts with "AXIS"/"HIKVISION"/etc?  (fallback for cameras without ONVIF)
```

Each rung that fires CAMERA bumps a confidence counter. The PVID move only happens at confidence ≥ 2 to avoid mis-classifying e.g. a PoE-powered Raspberry Pi.

### Why not lean on Voice-VLAN-OUI?

The Lantronix has a built-in `voice_vlan_oui` feature designed for IP phones — exactly the same mechanism we'd want for cameras (OUI match → port joins a specific VLAN). It's tempting to repurpose it, and Phase 3 below explores doing exactly that. **The reason the daemon is the source of truth and Voice-VLAN-OUI is just an optimization path:**

1. ONVIF probes catch cameras whose OUIs aren't on any vendor list (off-brand IPCs).
2. The daemon can demote a port too — a camera unplugged and replaced with a laptop needs the port to flip back to VLAN 1. The switch's Voice-VLAN logic only does the LAN→VOICE direction.
3. PoE class is observable per-port; OUI alone misses non-PoE cameras and false-positives PoE laptops with camera-vendor NICs.

---

## Inter-VLAN policy

Default deny between VLAN 1 and VLAN 50. Specific allowances:

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
- ✅ Camera plugged into Lantronix port 7 (PoE class 3, ~7.8 W) gets a DHCP lease and is auto-adopted into Frigate.

Bring-up procedure:

```bash
# On the POC box, after pulling this branch:
sudo bash scripts/poc/install-poc-host-net.sh
# Add to .env:
#   SWITCH_HOST=192.168.1.77
#   SWITCH_USERNAME=admin
#   SWITCH_PASSWORD=<the same password as docker/secrets/openwrt_password>
#   CAMERA_SUBNET=192.168.20.0/24
docker compose --profile full -f docker/docker-compose.yml -p droplet-pi-platform up -d switch camera-discovery
```

---

## Roadmap

| Phase | Ticket (proposed) | Scope |
|-------|-------------------|-------|
| 1 — Foundation (this PR) | — | DHCP on br-lan, switch reachable, single-VLAN camera path working |
| 2 — VLAN segmentation | WARP-NEW-A | VLAN 50 on switch + `br-lan.50` on host + per-VLAN dnsmasq + nftables policy. Cameras moved by hand. |
| 3 — Classifier daemon (passive) | WARP-NEW-B | Daemon reads PoE/MAC/leases/ONVIF, **logs** classifications, dashboard surfaces them. No PVID moves yet — operator-confirm only. |
| 4 — Classifier daemon (active) | WARP-NEW-C | Daemon writes PVID moves after the confidence-counter threshold. Demotion path (cam unplugged → port returns to LAN). Audit log. |
| 5 — Voice-VLAN-OUI hand-off | WARP-NEW-D | Push the OUI watchlist into the switch's native voice-VLAN-OUI table so VLAN moves happen at the switch with no host loop. Daemon stays as the audit + demotion path. |
| 6 — Dashboard surface | WARP-NEW-E | `/cameras` page gets a "Network" tab with per-port live status (class, MAC, PoE, PVID) + manual override. |

Each phase is independently shippable — the daemon is useful in passive (Phase 3) mode before any port moves happen, and operators get visibility without trusting automation yet.

---

## Open questions

1. **Should LAN clients reach the dashboard directly or only via the home network?**
   Today the dashboard is reachable via the host's `br-mgmt` (`https://droplet-ai.local/`). Once LAN devices (computers) live on `br-lan` (VLAN 1), they need a path to the dashboard too — probably an nginx side-listen on `192.168.20.1`. Not decided.
2. **WireGuard peer subnets vs the new VLANs.**
   `dhcp-option=3` on the LAN points at `.20.1`. Remote peers entering via WireGuard see a different topology. Need a quick check that the routing tables align.
3. **Where does the OUI watchlist live?**
   Two options: in-repo JSON (versioned with the code) or operator-editable on the appliance. Probably both, with the in-repo file as the default + an override path on disk.
4. **PoE classes 0–2 (low-power devices: APs, sensors).**
   Currently the decision tree skips them. If a Class-0 ONVIF camera shows up (rare but possible) we'd miss it. Worth a follow-up.

---

## Cross-references

- [`docs/camera-system.md`](camera-system.md) — base camera architecture (production OpenWrt + Switch model).
- [`docs/ADR-005-canonical-system-architecture.md`](ADR-005-canonical-system-architecture.md) — appliance-wide architecture; the smart-port daemon plugs into the switch service per the Apps Board surface.
- [`scripts/poc/droplet-openwrt-attach.sh`](../scripts/poc/droplet-openwrt-attach.sh) — POC's other host-network bring-up script. The smart-port host-net unit follows the same install pattern.
- [`services/switch/drivers/lantronix.py`](../services/switch/drivers/lantronix.py) — `LantronixDriver`, the switch-API surface the daemon will drive.
