# ADR-024: Multi-backend coverage-AP onboarding (Droplet-image + EasyMesh + UniFi)

**Status:** Proposed (implementation merged on main — #670; `DROPLET_IMAGE` live, `EASYMESH`/`UNIFI` disabled-by-default scaffolds. Reconciliation with ADR-018 §5 recorded in [ADR-033 §6](ADR-033-edge-router-shape.md).)
**Date:** 2026-06-19
**Deciders:** Stefan + Romain (Romain sign-off pending)
**Source:** Extends ADR-005 (AP auto-onboarding). Product requirement: a household can buy a *third-party* coverage AP, plug it in, have it auto-discovered, and add it through the LLM — without it being a Droplet-flashed unit. Threads through ADR-002 (network supervision), ADR-004 (RBAC), ADR-011 (hardware-agnostic), ADR-014 (LLM client-dispatched actions), ADR-018 (single-box network unification), ADR-022 (host-sidecar container pattern).
**Validation:** [ADR-025 — Lab validation checklist](ADR-025-lab-validation-checklist.md) — the hardware punch-list for this ADR's exit gates (renumbered from a duplicate "ADR-024" filename, WARP-1563).

## Context

ADR-005 shipped AP auto-onboarding for exactly one vendor: **Droplet's own OpenWrt extender image**. The pipeline is:

```
mDNS _droplet-ap._tcp announce  →  ApDevice(AWAITING_APPROVAL)  →  approve (LLM/dashboard)  →  uci wifi-iface push
```

Every link in that chain is Droplet-image-specific: discovery keys on a service type our own `99-droplet-setup` first-boot script publishes, and provisioning writes a `wifi-iface` UCI section the AP must accept. A retail AP does neither.

The product now needs two more ecosystems to flow through the *same* "plug in → auto-discover → LLM adds it" experience:

1. **Wi-Fi Alliance EasyMesh** — the cross-vendor standard. Brands with certified agents: TP-Link (Archer/RE line), Zyxel, D-Link, ZTE, plus MediaTek/Qualcomm/Broadcom reference designs and operator CPE. Discovery is **IEEE 1905.1** topology; onboarding is **Multi-AP M1/M2** (WPS-style) over a fronthaul/backhaul BSS.
2. **Ubiquiti UniFi** — proprietary, so it can never speak EasyMesh, but uniquely integrable among proprietary brands because it is self-hostable and ships an **official local API**. Discovery is the **UBNT device-discovery broadcast (UDP 10001)**; onboarding is **adoption by a UniFi Network controller**.

Neither shares ADR-005's mDNS-and-uci mechanism. This ADR decides how all three coexist behind one state machine, one LLM tool surface, and one dashboard panel — rather than three parallel features.

## Decision

### 1. Generalize onboarding into backend-pluggable dispatch

`ApDevice` stays the single canonical entity and keeps the `ApDeviceStatus` enum from ADR-005. We add a discriminator so every row knows which backend owns its discovery + provisioning:

```prisma
enum ApOnboardBackend {
  DROPLET_IMAGE   // ADR-005: mDNS _droplet-ap._tcp + uci wifi-iface push
  EASYMESH        // IEEE 1905.1 discovery + prplMesh controller M1/M2 onboarding
  UNIFI           // UBNT UDP 10001 discovery + UniFi Network API adoption
}

model ApDevice {
  // ...existing ADR-005 columns (mac, status, model, serial, version, lastSeen, approved* ...)
  backend     ApOnboardBackend @default(DROPLET_IMAGE)
  backendRef  String?          // backend-scoped opaque id: UniFi device_id, 1905.1 AL-MAC, etc.
  vendor      String?          // human label surfaced in dashboard/LLM ("TP-Link", "Ubiquiti")
}
```

`reconcileDiscovered()` and `approveAp()` become thin routers that dispatch to a backend interface:

```ts
interface ApOnboardBackend {
  discover(): Promise<DiscoveredApObservation[]>;   // one source's current snapshot
  approve(mac, opts, actor): Promise<ApOnboardResult>;
  decommission(mac): Promise<ApOnboardResult>;
}
```

The existing Droplet-image logic moves behind `DropletImageBackend` **unchanged** — Phase 1 is a pure refactor with no behavior delta, guarded by the current ADR-005 tests.

### 2. EasyMesh backend = prplMesh in **Controller-only** mode

**Spike finding (2026-06-19):** prplMesh (prpl Foundation, EasyMesh R1–R5) builds as Agent/Controller/both on OpenWrt, but its wireless HAL officially targets **Intel + Qualcomm** SoCs — there is no mt76/MT7922 support. The single-box radio (MT7922, mainline mt76) therefore **cannot run as an EasyMesh RF agent**. However, hostapd implements the Multi-AP *onboarding* primitive (WPS M1/M2) on any nl80211/mac80211 driver — which mt76 is — and "most of the Multi-AP spec falls outside hostapd," i.e. lives in the controller logic.

Decision: the box runs **prplMesh Controller-only**. It owns the 1905.1 control plane and the onboarding/credential push; its *own* fronthaul BSS on the MT7922 uses hostapd Multi-AP (nl80211) + `dawn` for steering (consistent with ADR-005 §2). The **certified third-party AP is the Agent** and brings its own vendor RF stack. This sidesteps the mt76 gap entirely — we never ask mainline mt76 to be an EasyMesh agent.

- **Discovery:** a 1905.1 topology bridge surfaces newly-seen Agent AL-MACs as `DiscoveredApObservation` rows (`backend=EASYMESH`).
- **Approve:** the controller runs the M1/M2 onboarding and pushes the household SSID/PSK to the Agent; `PROVISIONING → ONLINE` is driven by the controller's topology-confirmed state, mirroring ADR-005's operation-driven transition.
- **Residual risk to validate in Phase 4:** hostapd Multi-AP fronthaul BSS on mt76 + the 1905.1 transport on our overlay, on real hardware, against a TP-Link agent. Recorded as the phase's exit gate.

### 3. UniFi backend = bundled/attached controller + official-API adapter

UniFi APs adopt **only** to a UniFi Network controller — there is no protocol shortcut. The backend is an orchestrator adapter that drives the **official, local, API-key-authenticated UniFi Network API** (released 2024) against a controller.

- **Discovery:** a factory-default UniFi AP broadcasts UBNT discovery on **UDP 10001** once it has a lease and appears as *Pending Adoption* on the controller. The backend reads the controller's pending-device list (primary) and may additionally sniff UDP 10001 to surface "a Ubiquiti AP appeared" before the controller has it. L3 fallback (AP on the camera VLAN, etc.) is `set-inform http://<box>:8080/inform`.
- **Approve:** the adapter calls the official API's *adopt-by-MAC* endpoint, then pushes the household WLAN config. `backendRef` stores the UniFi `device_id`.
- **Auth:** API key only (the legacy `:8443` cookie API breaks across versions — not used). Stored as a secret env var, never tracked. See §"Open decision".

### 4. One LLM + dashboard surface across all three

`approve_ap` / `list_ap_devices` / `decommission_ap` (tools-core) are unchanged in shape — they already `requiresWrite + requiresConfirmation` (ADR-005). They route by the row's `backend`. The dashboard "Coverage Extenders" panel (ADR-005 §IA) gains a `vendor` column and a per-backend "Add" affordance; the state machine and polling contract are identical, so the UX the household sees is one list regardless of vendor.

**RBAC (ADR-004) unchanged:** reads open to all authenticated principals incl. `service` (the LLM); `approve` / `decommission` are `owner`+`admin`. Adopting any vendor's AP changes the wireless surface, so the existing SSID/PSK-class gate applies uniformly.

### 5. Config — `DROPLET_AP_*` only, never `MATTER_*`

Per the CLAUDE.md rule (matter.js auto-imports `MATTER_*` into VariableService):

| Variable | Default | Purpose |
|---|---|---|
| `DROPLET_AP_EASYMESH_ENABLED` | `0` | Master switch for the EasyMesh backend + prplMesh controller. |
| `DROPLET_AP_UNIFI_ENABLED` | `0` | Master switch for the UniFi backend. |
| `DROPLET_AP_UNIFI_CONTROLLER_URL` | — | Local controller base URL (e.g. `https://127.0.0.1:8443`). |
| `DROPLET_AP_UNIFI_API_KEY` | — | **Secret.** Official-API key. Sourced from the secret store, never a tracked file. |
| `DROPLET_AP_DISCOVERY_INTERVAL` | `10` | Reused from ADR-005; now drives all discovery sources. |

Both backends default **off** — a single-box with no extenders ships exactly as today.

### 6. Scheduling

Per CLAUDE.md (no `while True`, no hand-rolled schedulers): the discovery multiplexer runs under the existing `cron-runtime.service.ts` `scheduleInterval` at `DROPLET_AP_DISCOVERY_INTERVAL`, same pg-advisory-lock pattern as ADR-005's poller. The 1905.1 and UDP 10001 listeners are event-driven sockets (bounded reads), not pollers.

## Architecture

```
                         ┌──────────────── orchestrator ────────────────┐
 plug in AP  ──mDNS───▶  │  discovery multiplexer (cron scheduleInterval)│
            ──1905.1──▶  │     ├─ DropletImageBackend.discover()         │
            ──UDP10001▶  │     ├─ EasyMeshBackend.discover()  ───────────┼──▶ prplMesh Controller (sidecar)
                         │     └─ UniFiBackend.discover()     ───────────┼──▶ UniFi Network controller
                         │  reconcileDiscovered() → ApDevice(AWAITING)   │
                         │  approve_ap (LLM, confirm) → backend.approve() │
                         └───────────────────────────────────────────────┘
```

`ApDevice.backend` is the single source of truth for which arrow a given row took. No state derived from absence (CLAUDE.md no-guessing rule) — the backend is an explicit column, same discipline as `ApDeviceStatus`.

## Security / threat model

ADR-005's posture holds: the LAN is the trust boundary (ADR-002), so auto-*discovery* is acceptable and the gate is the manual `owner`+`admin` approve. New surfaces:

- **EasyMesh** — a malicious LAN device can emit 1905.1 frames; worst case is discovered-list spam, bounded by the existing 25-row LRU cap (extended to count all backends). Onboarding still requires explicit approval before any PSK leaves the controller.
- **UniFi** — the API key is the sensitive new secret; it lives in the secret store, never tracked, and the adapter talks to the controller over loopback/LAN only. UDP 10001 is read-only sniffing for surfacing; adoption always goes through the authenticated API.

## Open decision (needs sign-off)

**Where does the UniFi Network controller run?** UniFi adoption is impossible without one, and it is Ubiquiti's closed-source Java + MongoDB stack.

- **Option A — bundle it on the box** (container per ADR-022). Cleanest UX ("it just works"), but ships a third-party closed-source controller + MongoDB footprint, and **redistributing UniFi Network in a commercial product needs a licensing/legal review** (free-to-use ≠ free-to-redistribute).
- **Option B — customer-supplied / attached controller.** The household points Droplet at an existing UDM/CloudKey/self-host via `DROPLET_AP_UNIFI_CONTROLLER_URL` + API key. No redistribution risk, lighter box, but only serves households that already run UniFi.

The adapter code (§3) is identical either way — only packaging differs. **Phase 3 is gated on this choice.** Recorded as Proposed pending Stefan + Romain.

## Phased rollout (one WARP ticket per phase, through the droplet-dev → qa → ui-ux → manager → code-reviewer harness)

| Phase | Scope | Exit gate |
|---|---|---|
| **0 (this ADR)** | ADR-024 + EasyMesh feasibility spike | ADR merged; prplMesh-controller-only path confirmed |
| **1** | Schema: `ApOnboardBackend` enum + `backend`/`backendRef`/`vendor` cols + migration; refactor reconcile/approve to backend dispatch; `DropletImageBackend` extraction | All ADR-005 tests green, zero behavior delta |
| **2** | Discovery multiplexer: pluggable sources; 1905.1 + UDP 10001 listener scaffolds (stubbed backends) | Multiplexer reconciles mock sources; LRU cap covers all backends |
| **3** | UniFi backend: official-API adapter (adopt + WLAN push), controller-pending discovery, mock-UniFi-API tests; controller packaging per the §Open-decision outcome | Adopt + push verified against a real/mock controller |
| **4** | EasyMesh backend: prplMesh Controller in the overlay/compose, hostapd Multi-AP fronthaul on MT7922, 1905.1 discovery bridge | Onboard a real TP-Link EasyMesh agent on the lab box |
| **5** | Dashboard: vendor column + per-backend Add flows; LLM tool descriptions | UX review (droplet-ui-ux) passes; both vendors add via chat |
| **6** | `docs/ROADMAP.md` update + `shared_brain` re-sync | Brain mirror current |

## Consequences

**Easier:** "bring a coverage AP" stops being Droplet-image-only. Three vendors (and any future EasyMesh-certified brand) flow through one approval UX and one audit trail. The backend discriminator keeps the state machine join-free and reportable for the future analytics repo (extends ADR-005's forward-compatible note).

**Harder:** two external controllers (prplMesh + UniFi) become part of the box's runtime surface — more failure modes, more to maintain. Cross-vendor EasyMesh interop is specified but flaky in practice (documented agent↔controller incompatibilities), so we ship a *tested-compatible* agent list, not a blanket "any EasyMesh AP" claim. The UniFi path is vendor-specific glue that does not generalize to other proprietary brands (Eero/Nest have no local API).

**Rejected alternatives:**

- *Make UniFi speak EasyMesh* — impossible; closed firmware.
- *Run prplMesh as an Agent on the box's mt76 radio* — unsupported HAL; would block the whole EasyMesh path on a driver port we don't control.
- *Three independent features* — triples the LLM/dashboard/state-machine surface and forks the audit story; rejected for the single-entity-with-discriminator design above.
- *Reuse ADR-005's mDNS discovery for all* — third-party APs don't announce `_droplet-ap._tcp`; a non-starter.

## Action items

1. [ ] Stefan + Romain decide the §Open-decision (UniFi controller bundling A vs B).
2. [ ] Create WARP tickets for Phases 1–6; link this ADR.
3. [ ] Phase 1 Prisma migration + backend-dispatch refactor (first implementation PR).
4. [ ] EasyMesh Phase-4 hardware validation booked on the lab box with a TP-Link agent.
5. [ ] `docs/ROADMAP.md` coverage-AP line updated to reference ADR-024 (Manager handles in PR body).
