# ADR-033: The `edge-router` deployment shape — external OpenWrt router, switch, and AP as one control plane

**Status:** Proposed (pending review — human gate)
**Date:** 2026-07-30
**Deciders:** Stefan (founder directives 2026-07-27/28) + Engineering to execute
**Source:** Founder directives: networking moves off the compute box onto a dedicated edge router "to ensure the two chip distinction" (2026-07-28); the coverage AP is reflashed to OpenWrt and "totally integrated with the OpenWrt instance on the Pi" (2026-07-28); **onboard box radios are never APs — all traffic flows via the edge router** (2026-07-28). Epic WARP-1671 (control-surface audit 2026-07-30). Builds on ADR-009 (canonical architecture), ADR-011 (capability shapes), ADR-018 (network unification), ADR-024 (multi-backend AP onboarding), FOUNDATION.md (Vault ‖ WAN-Edge two-subsystem split).

## Context

- The **foundation** mandates two physically separate subsystems: a trusted Vault (compute + data + LAN) and an untrusted WAN/Edge. Running OpenWrt **in a container on the compute box** (the `single-box` shape) was always the compromise that folded both into one chassis.
- Since 2026-07-28 the lab runs the split in silicon: a **Pi 5 on bare-metal OpenWrt** (repo `DropletByWarpLab/droplet-edge-router`; hostname `droplet-edge`) owns WAN/routing/DHCP/DNS on LAN `192.168.9.0/24`; the compute box sits **behind it as a DHCP client**. A **Zyxel GS1900-10HP** switch (OpenWrt image, `switch/` subtree, static `192.168.9.2`) and a **Zyxel NWA50BE** AP (OpenWrt image, `ap/` subtree, DHCP + mDNS) complete the fabric.
- Every device provisions the same control account at first boot: a per-unit-passworded **`droplet-ai` rpcd user** with a scoped JSON ACL, serving ubus over HTTP on the LAN side only. The AP's ACL is a deliberate subset of the router's; the switch's adds `poe` and grants **no** `file exec` at all.
- Until this ADR the shape existed only as an `.env.example` comment: absent from ADR-011's shape list, the image manifest enum, and `setup.sh` shape detection. Control-plane support landed piecemeal: router repoint (WARP-1648/1649), typed credential-rejection surfacing (WARP-1673), the `openwrt` switch driver (WARP-1674), AP direct-rpcd configuration (WARP-1675).

## Decision

### 1. `edge-router` is a first-class capability shape (extends ADR-011)

Named by role, not silicon: an **external OpenWrt edge router** owns WAN/LAN/DHCP/DNS; the box is Vault compute only. The lab Pi 5 is one incarnation; any device running the droplet-edge-router image qualifies. Canonical addresses: router `192.168.9.1` (LAN gateway), switch `192.168.9.2` (static, mirrors the image), AP via DHCP + `_droplet-ap._tcp` mDNS discovery.

### 2. One protocol, three endpoints — no new backend kinds

All three devices are OpenWrt speaking rpcd/ubus over LAN-side HTTP as `droplet-ai`. The control plane maps onto the **existing** service seams rather than inventing new ones:

| Device | Control path | Config |
|---|---|---|
| Router | `services/routing` (unchanged singleton) | `OPENWRT_HOST=192.168.9.1`, `OPENWRT_PORT=80`, `OPENWRT_USERNAME=droplet-ai`, secret `openwrt_password` |
| Switch | `services/switch` via the `openwrt` SwitchDriver (WARP-1674) | `SWITCH_DRIVER=openwrt`, `SWITCH_HOST=192.168.9.2`, `SWITCH_USERNAME=droplet-ai`, secret `switch_password` |
| AP | ADR-024 `DROPLET_IMAGE` backend + direct-rpcd push at the discovered address (WARP-1675) | secret `ap_openwrt_password`; address from mDNS, never env |

### 3. Onboard radios are never APs (founder rule, now codified)

In this shape the box's own radios are **deactivated scaffolding** — Wi-Fi is served by the external AP(s), steered per ADR-005. Consequences: the router-side `wifi-iface` staging in AP approval is **skipped** when the router reports zero radios (WARP-1675); on-box radio surfaces render honest-empty; nothing may re-enable an on-box AP as a "fallback".

### 4. The uplink never joins the LAN bridge

The rogue-DHCP incident class (uplink NIC landing inside the DHCP-serving bridge) is designed out device-side (`droplet-dhcp-guard`, pinned port roles) and is an invariant here: no control-plane write path may stage a config that puts the WAN/uplink device into `br-lan`, and topology posture detection treats it as a fault, never a topology.

### 5. Credentials: per-unit, operator-synced today, paired tomorrow

Every device mints its own random `droplet-ai` password at first boot under `/etc/droplet/`. The box learns them via **operator copy into `.env` → `setup.sh --sync-secrets` → docker secrets** (`openwrt_password`, `switch_password`, `ap_openwrt_password`). A device reflash regenerates its credential and strands the copy — the dashboard surfaces this as the typed **AUTH / "Credentials rejected"** state (WARP-1673, and its AP/switch analogues) rather than "offline". **An automatic pairing/enrollment handshake is the named gap** (candidate: extend the QR tunnel-enroll pattern); until it lands, the manual recipe in droplet-edge-router `docs/OPERATIONS.md` is the contract.

### 6. ADR-018 §5 and ADR-024 are a registry with a default, not a contradiction

ADR-018 §5 ("no EasyMesh / TR-069") and ADR-024 (EasyMesh + UniFi backend scaffolds, merged #670) read as conflicting. Resolution: **`DROPLET_IMAGE` is the sanctioned default and the only path for Droplet-supplied hardware** — both ADRs agree on it. ADR-024's `EASYMESH`/`UNIFI` are **disabled-by-default, explicitly-opted-in backends for third-party ecosystems the operator already owns**, not a reversal of the `dawn` decision. ADR-018 §5 is annotated accordingly (this ADR); `AP_ONBOARDING.md` says the same in operator language.

## Consequences

**Easier:** the two-subsystem foundation is enforced in silicon; one ubus/ACL idiom covers router+switch+AP (the ACL parity contract extends naturally); the dashboard's existing Network/Switch/Coverage-Extenders surfaces drive the new fabric with env + driver selection only.

**Harder:** the box is a DHCP client behind NAT — every runbook/bookmark addressing it by a fixed LAN IP is stale; reflash-credential rotation is now a routine operational event; cross-repo coupling (ACL shapes live in droplet-edge-router, fallbacks + tests here).

**Risks:** manual credential sync fails silently between reflash and re-sync (mitigated by the typed AUTH surfacing); switch live-writes remain unconfirmed until the GS1900 is flashed off stock firmware (plan-only default holds); mDNS discovery across the Pi's umdns is the single AP-addressing source.

## Action items (each a scoped ticket)

1. [ ] This ADR — review + accept (human gate).
2. [x] Router repoint + read fixes (WARP-1648/1649, #1308).
3. [x] Typed credential-rejection surfacing (WARP-1673).
4. [x] `openwrt` switch driver + panel generalization (WARP-1674).
5. [x] AP direct-rpcd configuration + radio gating (WARP-1675).
6. [x] Secrets plumbing for the AP credential + shape documentation in `.env.example` (this change).
7. [ ] `setup.sh` shape detection for `edge-router` (auto-write the table in §2) + manifest enum entry.
8. [ ] Pairing/enrollment handshake replacing the manual credential copy (design ticket; QR tunnel-enroll pattern).
9. [ ] GS1900 bench flash + supervised live-write confirmation → flip `SWITCH_LIVE_WRITES` (droplet-edge-router `switch/docs/STATUS.md`).
10. [ ] AP radio bring-up (WARP-1664, droplet-edge-router `ap/`).
11. [ ] Handbook: merge the pi-edge-router runbook (PR #23) + refresh `lab-network-topology`.
