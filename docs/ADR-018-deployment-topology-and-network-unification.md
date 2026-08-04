# ADR-018: Deployment-topology auto-detection + single-box network unification + WAN passthrough

**Status:** Proposed (pending review — human gate)
**Date:** 2026-06-03
**Deciders:** Stefan (CEO directive) + Engineering to execute
**Source:** CEO directive 2026-06-03 — "Droplet is the router; if it's plugged in as a client it must auto-configure itself as a downstream router, keep its own network for devices, and pass internet through; Wi-Fi goes out through the AP, not the on-board radio." Live diagnosis of `droplet-sys` (`192.168.1.87`) on 2026-06-03 showing the single-box network divergence. Builds on ADR-002 (network-page persona), ADR-005 (AP auto-onboarding), ADR-009 (canonical system architecture), ADR-011 (hardware-agnostic codebase).

## Context

- **ADR-009** pins the orchestrator-centric shape: `services/routing/` wraps OpenWrt via ubus/UCI; off-LAN access is via WireGuard; there is no public TLS endpoint.
- **ADR-011** establishes capability shapes (`single-box` / `multi-box` / `v2-6`) and role-based, hardware-agnostic vocabulary.
- The **`multi-box` shape is the clean reference** (`openwrt/README.md`): OpenWrt owns the **WAN** (DHCP client of the upstream), the **LAN** (`br-lan`), an **isolated camera VLAN 100** (`192.168.100.0/24`), and NATs the LAN out the WAN.
- **Live divergence on the `single-box` (2026-06-03):** a *host* dnsmasq (`droplet-host-net`, originally `droplet-poc-host-net`) serves `br-lan` (`192.168.20.0/24`); the containerized OpenWrt (`172.18.0.7`) runs alongside but does **not** own LAN DHCP/clients. Observed consequences:
  - **Dashboard shows 0 connected devices.** The orchestrator reads clients from OpenWrt ubus, but the real DHCP leases live in the host dnsmasq (a phone leased `192.168.20.33`, invisible to the dashboard).
  - **Camera discovery misses cameras.** Default `CAMERA_SUBNET=192.168.100.0/24` (the OpenWrt camera VLAN) doesn't match the single-box's actual LAN (`192.168.20.0/24`), and the `camera-discovery` service isn't running (gated behind the `full` compose profile).
  - **Wi-Fi is unusable.** It rides the on-board radio inside OpenWrt; with the operator's antennas removed, the Droplet SSID can't be joined → devices can't reach the LAN → Matter can't commission.
  - The original `poc-host-net` naming violated rule 17 (no `poc`/`test`/`dev` framing in shipping surfaces) — since renamed to `droplet-host-net` (de-`poc` lifecycle-naming sweep).
- **Exact mechanism — host/switch VLAN divergence (verified live, read-only, 2026-06-03):** The managed switch (`SM8TAT2SA`, FW `v1.04.0079`) is **already segmented** per the lab topology, *not* flat/unprovisioned: `VLAN 1` (default/mgmt, `192.168.1.0/24`, where the switch's own `192.168.1.77` lives), `VLAN 10` "lan" (client ports `1,4,5,8,9` — **the AP is on port 4, PoE+ Class 4 ≈ 5.2 W**), `VLAN 100` "cameras" (isolated; untagged on port `6`), with **port 5 a trunk** (native `VLAN 10` + tagged `VLAN 100`). The host, however, bridges its client network onto the **wrong segment**: `br-lan` (`192.168.20.0/24`, host-dnsmasq) has its UP uplink NIC (`enp12s0`) cabled to a **`VLAN 1` access port**, and the host carries **no VLAN sub-interfaces** at all. So `br-lan` (the client DHCP/router) sits on `VLAN 1` while the AP and every client port sit on `VLAN 10` — **two different L2 segments**. *This* — not a missing switch config — is the concrete reason the dashboard shows 0 clients and the AP reads "undetected": AP clients on `VLAN 10` never reach the host's `br-lan` DHCP, and cameras on `VLAN 100` are unreachable (no tagged `VLAN 100` sub-interface on the host). The single `192.168.20.33` lease is a stale lease from the now-disabled on-board radio, not the AP. **Implication:** the fix is to align the *host uplink* to the switch's existing segmentation (uplink on a trunk; native = client VLAN → `br-lan`; tagged camera VLAN → a camera sub-interface) and make the switch a first-class, auto-managed fabric the dashboard reflects — *not* to rebuild the switch's VLANs from scratch. (This is exactly why the bring-up provisioner below is **converge-not-rebuild** and camera-safe.)
- **Product requirement:** Droplet is a router that must run in two postures and **auto-detect** which:
  1. **`PRIMARY_ROUTER`** — owns the WAN uplink (ISP).
  2. **`DOWNSTREAM_ROUTER`** — plugged into an existing upstream network; that uplink is the WAN-in. Keep its own LAN for devices and NAT/route them out the WAN (internet passthrough). **Never touch the upstream network.**

## Decision

### 1. One OpenWrt-managed network model across all shapes
Retire the single-box's ad-hoc host dnsmasq (`droplet-host-net`). On every shape, **OpenWrt owns the LAN** — DHCP, the client/lease table, Wi-Fi (hostapd), and the isolated camera VLAN — exactly as the `multi-box` reference already does. The orchestrator's existing OpenWrt-ubus client/lease source then becomes correct on the single-box with **no special-case read path** (root-fix for the "0 devices" bug). The containerized OpenWrt is bridged to the host's physical LAN NIC(s) so it owns `br-lan`. Remove `droplet-host-net`; fold its function into the OpenWrt overlay + `setup.sh` provisioning (rule 20 — no hand-rolled box scripts bypassing `setup.sh`). *(The de-`poc` lifecycle-naming sweep — `droplet-poc-host-net` → `droplet-host-net` — is already done; what remains is folding the host plane into OpenWrt.)*

**Host uplink ↔ switch alignment (the concrete single-box gap above).** Where a managed switch is present, the host's LAN uplink NIC connects to a switch **trunk** port, and `setup.sh` provisions the matching host side: the trunk's **native** VLAN is the client LAN (untagged → `br-lan`), and the isolated **camera VLAN is tagged** and lands on a dedicated camera sub-interface (e.g. `enp12s0.100`) bridged to the camera network — never a flat untagged bridge that strands cameras on the client L2. Management stays reachable on its own port/VLAN (`br-mgmt`) so the alignment never strands switch/box management. Because the switch is already segmented, this is **convergence to the switch's existing layout**, applied via `setup.sh` + the switch auto-provisioner (action item 9 addendum), staged with rollback (ADR-002 `safe_apply`) — never a live hand-edit.

### 2. Deployment-topology auto-detection — explicit state, not guessed
The routing service probes the WAN-facing interface for an upstream gateway/DHCP lease and records an **explicit `DeploymentTopology` enum** (`PRIMARY_ROUTER` | `DOWNSTREAM_ROUTER`) — never derived from absence (rule 10; mirrors the `ApDeviceStatus` / `BrainMemoryItemStatus` pattern). Re-evaluated on link/carrier-change **events** (event-driven; **no `while True`** per rule 9 — use the existing scheduler/event patterns). The detected posture is surfaced on the dashboard network page (ADR-002 persona) and via a read-only tool. In `DOWNSTREAM_ROUTER` posture the WAN side is a **DHCP client only**; the upstream/home router is never mutated (hard rule).

### 3. WAN / internet passthrough
In both postures the LAN is NAT'd (masquerade on the WAN firewall zone) out the WAN so LAN devices get internet. The `multi-box` OpenWrt firewall already does this; unifying the single-box onto OpenWrt brings it along. The unification ticket verifies masquerade + forwarding + DNS resolution on the single-box.

### 4. Camera network alignment + discovery enablement
Under the unified model the isolated camera VLAN becomes real on the single-box; `camera-discovery` is enabled and `CAMERA_SUBNET` is set to the actual camera network for the shape (role-based config, no hardware names — ADR-011). Cameras attach to a camera-VLAN port (or the VLAN is bridged), matching the ADR-005 / openwrt isolation posture (cameras→LAN REJECT, LAN→cameras ACCEPT).

### 5. AP provisioning = reuse ADR-005 (no EasyMesh / TR-069)
Wi-Fi coverage and AP onboarding stay on **ADR-005**'s `dawn` + mDNS auto-onboarding of OpenWrt-imaged APs. A third-party AP (e.g. the TRENDnet TEW-932DAP) is brought in by **flashing it with the Droplet OpenWrt image where the hardware is supported** (verified per model), or by recommending a supported AP for true zero-touch. **EasyMesh / TR-069 are rejected:** they would override ADR-005's `dawn` decision (preserved as a point-in-time record by ADR-011 §5) and would not configure a non-certified stock AP anyway.

> **Amended by ADR-033 §6 (2026-07-30):** "rejected" here means *not the
> Droplet path* — `DROPLET_IMAGE` (this section's flash-and-onboard flow)
> remains the sanctioned default and the only path for Droplet-supplied
> hardware. ADR-024's `EASYMESH`/`UNIFI` backend scaffolds (merged #670,
> disabled by default) exist as explicit opt-ins for third-party ecosystems an
> operator already owns; they do not reverse the `dawn` decision. The two
> documents are a registry with a default, not a contradiction.

## Consequences

**Easier:** one consistent OpenWrt-managed network model across shapes; the dashboard device list, camera discovery, and Wi-Fi all work from a single source of truth; the product becomes a true auto-configuring router in either posture; the `host-net` debt is retired.

**Harder:** the single-box unification touches host network provisioning (`setup.sh` + `scripts/host/` + `openwrt/` overlay) and must not disrupt the box's own management reachability (`br-mgmt`). Validated via `./scripts/test/ship-check.sh --full` (clean-environment isolation) + the harness — **never** a live hand-edit on a box.

**Risks:** changing LAN/DHCP ownership on a deployed box is invasive; staged rollout with rollback (ADR-002 `safe_apply` discipline) is required; the operator's current devices re-lease under OpenWrt.

**Revisit:** when `v2-6` hardware lands the same model applies; topology detection may extend to multi-WAN / failover.

## Action items (each a scoped harness ticket)

1. [ ] This ADR — review + accept (human gate).
2. [ ] Routing service: `DeploymentTopology` WAN probe + explicit-state enum + event-driven re-eval + pytest (mock-router fixtures).
3. [ ] Single-box unification: OpenWrt owns `br-lan` DHCP/clients/Wi-Fi; retire `droplet-host-net`; fold into the OpenWrt overlay + `setup.sh`. *(De-`poc` naming sweep done; the OpenWrt unification remains — largest, may split into sub-tickets.)*
4. [ ] Orchestrator + dashboard: client/lease list reads the unified OpenWrt source on all shapes; network page renders the topology posture. *(Root-fix for the "0 devices" symptom.)*
5. [ ] Camera: enable `camera-discovery` on single-box + align `CAMERA_SUBNET` + camera-VLAN wiring. *(Camera-not-found symptom.)*
6. [ ] WAN passthrough verification: masquerade / forwarding / DNS in `DOWNSTREAM_ROUTER` posture (pytest + ship-check).
7. [ ] AP: verify TEW-932DAP OpenWrt support + document the flash path (reuse ADR-005); recommend a supported AP otherwise.
8. [ ] Update `docs/ROADMAP.md`; add a ship-check assertion that no new `poc-*` tokens are introduced.
9. [x] **Switch auto-provisioning on bring-up (shape-aware, camera-safe).** See the addendum below.
10. [ ] **Switch driver correction:** point `services/switch/drivers/lantronix.py` at the verified WebStaX JSON API (reads `/stat/vlan_membership_stat`, `/stat/vlan_port_stat`, `/stat/poe_status`, `/stat/sysinfo`, `/stat/ip_status` + `/config/login` cookie/`userip` auth); unit tests against recorded JSON fixtures; writes via `POST /config/<name>` gated behind `safe_apply` + read-back-verify, defaulting to plan/report mode until a one-time supervised write-confirm. *(Replaces the `TODO(ADR-018-item9)` markers; see Driver caveat.)*
11. [ ] **Host-uplink alignment:** `setup.sh` puts the LAN uplink on the switch trunk (native = client VLAN → `br-lan`; tagged camera VLAN → camera sub-interface), keeps mgmt on `br-mgmt`; staged + rollback; ship-check `--full`. *(The live fix for the "0 clients / AP undetected" symptom; depends on item 3.)*
12. [ ] **Dashboard switch surface:** `/api/switch/*` (status / ports / vlans + Write-tier port-VLAN/PoE/enable actions, Activity-logged) + the full Network-page switch panel per `design_handoff_droplet_dashboard/ADDON-network-switch-management.md`. The `/api/switch/ports` payload must carry the §7 contract shape (friendly `name`, `role`, `vlan_name`, `status`, `device`) so the map can be **persona-correct**. *(A preliminary read-only `SwitchPortMap` was built in item 9 but deferred here per UX review — it must lead with the friendly device name + a role/status chip + per-port VLAN, with the port id/VLAN as the mono secondary, and use list/table semantics; it cannot do this until this backend contract exists.)*

## Addendum — Action item 9: switch auto-provisioning on bring-up (shape-aware, camera-safe)

**Problem.** The managed-switch service (`services/switch/`) was gated behind the `full` compose profile, so on the `single-box` shape it never ran. Nothing reconciled the switch on bring-up, so a plugged-in AP (or any device) on an access port that the switch had left on a non-LAN VLAN sat **stranded on an isolated VLAN — invisible to the LAN, the dashboard, and Matter commissioning.**

**Decision.** Add an idempotent bring-up provisioner that reconciles the switch to an **explicit desired VLAN state** (`services/switch/provisioner.py`), gated by env and safe by default.

### Two profiles, explicit (never inferred — rule 10)

- **`flat-lan`** (default; the `single-box` value). Every access port — *including camera ports* — belongs untagged on VLAN 1; the uplink is the trunk. The ONLY action is moving an access port that's currently on a non-LAN VLAN back to untagged VLAN 1 (this is what un-strands the AP). It **never creates VLAN 100/50**, and a camera already on VLAN 1 is a no-op. This is correct for the single-box because it runs a flat `br-lan` with **no inter-VLAN routing yet** (item 3 has not landed); isolating the camera VLAN there would cut the working camera + Frigate off.
- **`segmented`** (multi-box / once item 3 lands). VLAN 1 LAN + isolated camera VLAN 100 + AP-downstream VLAN 50, per the openwrt/handbook posture. **Double-gated:** isolation is applied only if (a) `SWITCH_VLAN_PROFILE=segmented` AND (b) a live cross-check of the routing service confirms the camera-VLAN routing exists. If segmented is requested but cameras are not present, the provisioner **refuses to isolate, stays flat-lan, and logs an ERROR** — a misconfiguration is surfaced, not honoured.

### The routing `cameras.present` cross-check (item 9 → item 3 dependency)

The segmented gate reads the routing service (`ROUTING_SERVICE_URL`, `GET /network/interfaces`) for the **explicit** `cameras.present` flag — the same shape-detection presence mechanism ADR-018 T2 added (`get_all_interface_statuses()` / `interface_stub(present=…)`), never inferred from a missing key. **Item 9 therefore depends on item 3:** until the camera VLAN + inter-VLAN routing is real on a shape, `cameras.present` is not `true` there and the provisioner will not isolate — exactly the camera-safety guarantee the single-box needs today.

### System path, distinct from the orchestrator Tier-2 human-confirmation path

This is the **system** provisioning path: it runs unattended on bring-up and on an event-driven re-run, so it is deliberately conservative — read live state before writing, `driver.backup_config()` before the first write, and **read-back-verify after every write** (a silent write failure surfaces as an error). It is **distinct from the orchestrator's Tier-2 human-confirmation switch path** (`apps/orchestrator/src/routes/switch.ts`), where a human confirms each mutation through the network-safety tier system. The bring-up reconcile has no human in the loop, hence the extra guards; it never reuses or bypasses the Tier-2 path.

### Lifespan + event-driven re-run (no polling — rule 9)

- The switch service `lifespan` schedules the reconcile as a **non-blocking background task**, gated by `SWITCH_AUTOPROVISION` (default `0`/off) AND only when the driver connected (switch-absent = no-op). Boot/health are never delayed; the task is bounded by a hard timeout (`SWITCH_PROVISION_TIMEOUT`) and **no exception escapes** (logged WARNING/ERROR). The task is cancelled on shutdown.
- `POST /provision` re-runs the reconcile on demand (e.g. a switch coming online after the service started, or an AP being plugged in) — an **event-driven one-shot, not a busy loop.**

### Configuration (explicit env; no host-specific defaults — rule 12)

`SWITCH_AUTOPROVISION` (gate), `SWITCH_VLAN_PROFILE` (`flat-lan` | `segmented`), `SWITCH_PROTECTED_PORT` (the uplink/trunk port — **never moved off LAN/trunk**; no value is baked because the port map is host-specific), and the optional `SWITCH_{CAMERA,AP,CLIENT}_PORTS` (empty = safe default). `single-box` enablement: the `switch` service joins `profiles: ["full", "single-box"]`, and `scripts/lib/single-box.sh` upserts `SWITCH_AUTOPROVISION=1` + `SWITCH_VLAN_PROFILE=flat-lan` (segmented is never baked on single-box).

### Driver caveat (separate supervised live step)

The prototype driver's VLAN endpoints (`/stat/port`, `/stat/vlan`, `/stat/vlan_membership`, `/config/vlan_membership`) **return 404 on SM8TAT2SA firmware v1.04.0079**. A subsequent **read-only** live discovery (2026-06-03) found the switch's *actual* WebStaX JSON API, so the driver is being corrected to it (action item 10):

- **Auth:** `GET /config/login` → returns `userip`; then `POST /config/login` with `{"users_login_auth":{"agent":4,"username","password","userip"}}` and client-generated `cid`/`seid`/`sesslid` cookies.
- **Reads (confirmed 200, JSON):** `/stat/vlan_membership_stat` → `{"data":[[vid,name,[members],[untagged]],…]}` (gzip — request with `--compressed`); `/stat/vlan_port_stat` → per-port `PVID`/tagging (a trunk shows `txtag:"All except-native"`); `/stat/poe_status`; `/stat/sysinfo` (model/FW/MAC); `/stat/ip_status`.
- **Writes:** follow the WebStaX `POST /config/<name>` convention with the read-shaped body. Writes are **not GET-verifiable**, so the live write shape is confirmed **once, supervised** (backup-first + read-back-verify on a non-critical port, never the camera/uplink), before apply-mode is enabled on a given firmware. Until then the driver's write methods run in **plan/report mode** (compute + surface the diff; never blind-write).

The provisioner remains tolerant of read 404s (logs + no-ops rather than crash/blind-write), and read-back-verify means any remaining endpoint mismatch surfaces as a verification failure, not a silent mis-provision — so correcting the driver (item 10) cannot regress safety.
