# ADR-005: Auto-onboard OpenWrt extender APs with dawn band-steering

**Status:** Accepted
**Date:** 2026-05-25
**Deciders:** Engineering team (Stefan + Romain)
**Source:** WARP-446 (Jira), product GTM milestone M2.5 follow-up, ADR-002 §"Phase 4" extension, ADR-004 (RBAC), lab-floor observation that single-router coverage doesn't reach the upstairs bedrooms.

## Context

The Droplet appliance ships as a single OpenWrt router today (192.168.50.1). For ~120 m² single-story homes the on-board MT7922 5 GHz radio is fine; for two-story houses, basements, and detached offices it isn't. The product needs a second (and eventually third) OpenWrt-based AP that:

1. Plugs into the LAN over PoE / Ethernet,
2. Boots up advertising itself on mDNS,
3. Appears in the dashboard as "Awaiting approval" within 30 s,
4. Joins the same SSID + PSK as the main router after a single-tap approval,
5. Cooperates with the main router on band-steering so an iPhone walking from kitchen to upstairs hands off cleanly.

Two specific decisions need to be locked down so the rest of WARP-446's implementation can flow:

- **Enrollment trust model.** How does the orchestrator know "this AP on the LAN is mine to onboard" without the operator typing a pairing code on each unit?
- **Band-steering daemon.** OpenWrt has two mature options — `usteer` and `dawn`. They are not drop-in compatible (different uci namespaces, different RRM heuristics, different client-compatibility surfaces).

This ADR records both.

## Decision

### 1. Enrollment trust = auto-trust LAN-side mDNS announces on `br-lan`

Every extender AP runs an updated `99-droplet-setup` first-boot script that, in addition to the existing root + droplet-ai password generation, advertises itself via umdns on the `_droplet-ap._tcp` service type with these TXT records:

| TXT key | Example value | Notes |
|---|---|---|
| `mac` | `B8:27:EB:12:34:56` | onboard NIC MAC, canonical uppercase per `normalizeMac()` |
| `serial` | `AP-00000000a1b2c3d4` | from `/sys/firmware/devicetree/base/serial-number` |
| `model` | `raspberrypi,5-model-b` | from `/proc/device-tree/compatible` — the literal device-tree compatible string a Pi-based AP emits; AP detection matches on this value (kept verbatim, ADR-011) |
| `version` | `1.0` | tied to the openwrt overlay version |
| `role` | `extender` | distinguishes from `router` (main box) |

The main router runs a small `dawn-discovery` poller in the orchestrator (apscheduler-driven, 10 s cadence) that queries `umdns -d` for `_droplet-ap._tcp` records on `br-lan` and upserts each new MAC into `ApDevice` with `status = AWAITING_APPROVAL`. Re-seen MACs touch `lastSeen` only.

**Why auto-trust:** The Droplet LAN is itself the trust boundary. ADR-002 establishes that the household network behind the OpenWrt router is the security perimeter — same posture the cameras get (auto-discovered, single-tap accept), same posture WireGuard peers get (admin opens the door manually but doesn't validate the peer's identity). Adding a PIN or pre-shared pubkey moves the trust boundary inward without moving any actual threat outward: an attacker on `br-lan` can already DHCP-flood, ARP-spoof, or run a rogue AP with no PIN required, so requiring one for a Droplet-signed AP image accomplishes nothing.

**What auto-trust does NOT mean:** the AP does NOT auto-join the WiFi. It sits in `AWAITING_APPROVAL` until the household admin (owner+admin per ADR-004 §3) hits "Approve" in the dashboard. Approval is the gate that hands the AP the WPA2/WPA3 PSK and pushes wireless config through `safe_apply`.

**Rejected alternatives:**

- *PIN exchange (matter-style commissioning):* nobody wants to retype a 10-digit code from a sticker on the bottom of a router unit. The whole point of an extender is "plug it in, it just works".
- *Pre-shared pubkey baked into the image:* would require per-customer image builds (we ship one image), and the pubkey would have to be revoked + redistributed if a unit is lost. Operational nightmare.
- *Manual MAC entry by the operator:* same UX failure as the PIN path. The operator may not know the MAC; the sticker on the unit isn't always readable when the unit's already in the attic.

### 2. Band-steering daemon = `dawn`

OpenWrt's two mature 802.11k/v/r daemons:

| Dimension | `dawn` | `usteer` |
|---|---|---|
| Apple iOS/macOS roaming | Works well; community has tuned the roaming hysteresis specifically for Apple's aggressive RSSI thresholds | Known to over-deauth Apple clients; multiple OpenWrt forum threads show iPhones jumping APs every 30 s under usteer's default thresholds |
| Configuration surface | Single `/etc/config/dawn` UCI namespace; readable defaults | Split between `/etc/config/usteer` and per-radio hostapd hooks |
| 802.11k neighbor reports | Yes, native, no extra config | Yes |
| 802.11v BSS Transition Mgmt | Yes | Yes |
| 802.11r Fast Transition | Configured separately in hostapd (same for both) | Same |
| Cross-AP coordination | UDP multicast on `br-lan` (port 1025); orchestrator can subscribe to MQTT relay if we want metrics | Same multicast pattern, port 1025 |
| Maintenance health | Active commits in OpenWrt master through 2026-05; package promoted out of `packages` feed | Active but slower; primarily maintained by one developer |

For our home-user persona, Apple-roaming reliability is the dealbreaker. Family households almost certainly have at least one iPhone or MacBook; if those clients flap between APs we will get support tickets in week 1. `dawn`'s defaults work; `usteer`'s don't (for our hardware profile).

The dawn package + a default `/etc/config/dawn` go into both the main-router and extender overlays. The orchestrator does NOT manage dawn beyond enabling the service on first boot; the daemon's own multicast coordination handles ongoing decisions. Per-AP toggle is exposed only as an "Advanced" knob — defaults stay on.

**Rejected alternatives:**

- *Roll our own hostapd-event scraper:* the steering logic is non-trivial (signal-strength hysteresis, capability negotiation, anti-flap timers). Reimplementing this is a multi-quarter effort with no product win.
- *Skip band-steering in v1:* clients then sticky to the AP they first associated with. For a single-story house this is OK; for an extender-enabled deployment (the whole reason this ADR exists) it makes the extender pointless.

## Information architecture

The dashboard surfaces extender APs on the existing `/network` page under a new **Coverage Extenders** panel (above the Devices grid, below the WiFi summary card). One-tap "Add extender" launches a wizard that:

1. Polls `/api/aps/discovered` (which returns rows in `AWAITING_APPROVAL`),
2. Shows a card per discovered unit with its mDNS-reported model + MAC,
3. Approve → POST `/api/aps/:mac/approve` with the SSID it should join (defaulted to the main router's SSID),
4. Polls `/api/aps/:mac/status` until terminal (`ONLINE` or `FAILED`).

The orchestrator pushes the approved AP through these states:

```
DISCOVERED        ← mDNS poller sees a new _droplet-ap._tcp announce
   ↓ (operator hits Approve in dashboard, RBAC: owner+admin)
AWAITING_APPROVAL ← persisted, dashboard renders an Approve button
   ↓
PROVISIONING     ← orchestrator pushes wireless + dawn uci to the AP via routing
   ↓
ONLINE           ← AP responds to the post-apply ubus health probe
   ↓ (operator hits Decommission)
DECOMMISSIONED   ← peer uci entry removed, row kept for audit
```

Failures (router unreachable, ubus rejected the apply, post-apply probe times out) transition to `FAILED` with a non-null `failureReason`. ADR-002's safe_apply rollback discipline applies — every uci push uses the existing `safe_apply` context manager with a 60 s timeout; if the AP loses contact with the orchestrator during apply, OpenWrt itself rolls back to the previous config.

## State machine — why an enum, not a derived flag

Per the CLAUDE.md no-guessing rule, `ApDevice.status` is a Prisma enum (`ApDeviceStatus`) with the six values above. Reasons:

- Queries like "show me all extenders awaiting approval" become `WHERE status = 'AWAITING_APPROVAL'` — direct, indexable.
- "Has this extender ever been online" is `WHERE status IN ('ONLINE', 'DECOMMISSIONED')` — no joins, no compound nullable predicates.
- The decommission audit story works because `DECOMMISSIONED` is a real terminal state, not "row deleted" or "approvedAt IS NULL".

Mirrors the `BrainMemoryItemStatus` pattern from WARP-218 — same shape, different domain.

## RBAC

Per ADR-004 §3:

| Verb / path | Allowed roles |
|---|---|
| GET `/api/aps` | `owner`, `admin`, `family`, `guest`, `service` |
| GET `/api/aps/discovered` | `owner`, `admin`, `family`, `guest`, `service` |
| GET `/api/aps/:mac/status` | `owner`, `admin`, `family`, `guest`, `service` |
| POST `/api/aps/:mac/approve` | `owner`, `admin` |
| POST `/api/aps/:mac/decommission` | `owner`, `admin` |
| GET `/api/aps/:mac/wireless` (WARP-1712) | `owner`, `admin` |
| GET `/api/network/wifi/ap` (WARP-1712) | `owner`, `admin` |
| PUT `/api/network/wifi/ap` (WARP-1712) | `owner`, `admin` |

Reads are open to every authenticated principal (including the `service` role) because the LLM agent loop's `list_ap_devices` tool needs to surface AP state in voice and dashboard chat. Writes are admin-tier — approving a new AP changes the household's wireless surface and is consistent with the existing rule that SSID/PSK changes require `owner`+`admin`.

The three WARP-1712 rows are the deliberate exception to "reads are open": their bodies carry the AP's **live Wi-Fi passphrase**, so they follow the `GET /api/network/wifi/guest` posture (which carries the guest PSK for the join QR) rather than the open band-steering read. `PUT /api/network/wifi/ap` is additionally tiered by payload — a name-only change classifies as `set_ap_wifi_ssid` (Tier 1, matching the router's `set_ssid`), and any change carrying a passphrase classifies as `set_ap_wifi_password` (Tier 2, confirm first, matching the router's `set_wifi_password`).

## The AP owns its own radios (WARP-1712)

The orchestrator keeps **no cached copy** of an approved AP's SSID or passphrase. Every read dials the AP over its rpcd and reports what its uci actually says, so the Network tab's Wi-Fi form, the Coverage Extenders card and the hardware cannot drift apart. `ApDevice.approvedSsid` remains an **approval-time audit column** and is never read for display.

Writes obey the AP image's band-steering applier (`/etc/init.d/droplet-band-steer`, droplet-edge-router PR #5), which derives the 5 GHz interface from the 2.4 GHz one on every reload:

| `droplet.wifi.band_steering` | `wireless.default_radio1.ssid` becomes |
|---|---|
| `1` | `<ssid>` (bands unified) |
| `0` | `<ssid>-5g` (bands split) |

So the routing service authors **only** `wireless.default_radio0` (resolved by the radio it is attached to, not by section name) and lets `uci apply` fire the applier. Authoring `default_radio1` here would race a value the applier recomputes and would put the household's network name in two places. The one exception is a pre-substrate image with no applier, where every `wifi-iface` is written directly — the same shape the approval push already uses.

An approved Droplet-image AP is also **excluded from `GET /api/network/devices`**: it takes a DHCP lease like any client, but it is infrastructure and the Coverage Extenders panel owns it. The exclusion is scoped to `backend = DROPLET_IMAGE`; third-party (UniFi / EasyMesh) APs stay visible as network devices because a household may legitimately want to see, group or block them.

## Environment variables — `DROPLET_AP_*` only, never `MATTER_*`

Per the explicit CLAUDE.md rule, new env vars use the `DROPLET_AP_*` prefix:

| Variable | Default | Purpose |
|---|---|---|
| `DROPLET_AP_DISCOVERY_INTERVAL` | `10` | mDNS scan cadence in seconds |
| `DROPLET_AP_APPROVAL_TIMEOUT` | `60` | safe_apply timeout for the wireless push (matches existing convention) |
| `DROPLET_AP_DEFAULT_TXPOWER` | `20` | dBm cap on extender radios — keeps household-floor cells small enough for clean roaming |
| `DROPLET_AP_DAWN_ENABLED` | `1` | Master switch to disable dawn on every AP. Default on. |

No `MATTER_*` prefix. matter.js would auto-import every `MATTER_AP_*` into its `VariableService` and the controller-init `UnsupportedCastError` story would repeat itself.

## Scheduling

Per CLAUDE.md, neither `while True` nor a hand-rolled scheduler is allowed for periodic work:

- **Python side (routing service):** the band-steering subsystem in the routing service is event-driven (UDP multicast from dawn) and does NOT need a poller; no scheduler change.
- **Orchestrator (TypeScript):** the mDNS discovery poller uses `createCronRuntime(...).scheduleInterval(...)` from the existing `cron-runtime.service.ts`. Same pattern reminders-poller and schedule-ticker already use.

## Operation tracking

Per ADR-002 §"Phase 0.5" item 5: every uci push from the orchestrator surfaces an `X-Operation-Id` header from the routing service. The dashboard's Add Extender wizard polls `GET /api/network/operations/:id` (existing) until terminal. The state machine's `PROVISIONING → ONLINE / FAILED` transition is driven by the operation outcome, not by polling the AP directly.

## OpenWrt overlay changes

- `openwrt/build.sh` adds `dawn` to the package list. (Lint-only — operator flashes images.)
- `openwrt/files/etc/uci-defaults/99-droplet-setup` adds the umdns `_droplet-ap._tcp` advertisement block and the dawn enable. Idempotent (grep-guarded) — re-running on a converged AP is a no-op. Honors the existing single-image pattern: the same uci-defaults script runs on both the main router and any extender; the `role` field in the mDNS TXT distinguishes them, and the orchestrator side keys onboarding off the `role=extender` filter.
- `openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json` grants `umdns: ["browse"]` so the orchestrator can read the discovered services without root.

## Consequences

**Easier:** Adding an extender becomes "plug it in, hit Approve in the dashboard". Coverage extension is no longer an installer-only feature. Apple roaming is solved out of the box. The state machine has a single source of truth that supports audit and reporting without join-and-derive queries.

**Harder:** We now have two-or-more OpenWrt boxes per household, and a discovery surface that has to stay quiet under attack — a malicious LAN device CAN spoof the mDNS announce, which means the worst-case attack is "DoS the dashboard's discovered-list with garbage entries". We mitigate by capping the discovered-list to 25 entries (LRU) and surfacing the cap to the operator. Real exploitation requires LAN presence, which is already game-over per ADR-002's threat model.

**Revisit:** When we ship the analytics dashboard (M3.5 roadmap, separate repo), the AP topology becomes a first-class entity for "client X spent 70 % of yesterday on AP-2"-style queries. The `ApDevice` row becomes the FK target. Schema is forward-compatible.

## Action items

1. [ ] Prisma migration adding `ApDevice` model + `ApDeviceStatus` enum (this branch, first commit after this ADR)
2. [ ] Routing service: `ApApi` SDK class + `/aps/*` FastAPI endpoints + pytest coverage + mock-router fixtures
3. [ ] Orchestrator: `ap-onboard.service.ts` + `routes/aps.ts` + RBAC guards + vitest coverage
4. [ ] tools-core: `list_ap_devices`, `approve_ap`, `decommission_ap` handlers
5. [ ] OpenWrt overlay: dawn in `build.sh`, umdns + dawn enable in `99-droplet-setup`, ACL update
6. [ ] Dashboard: Coverage Extenders panel under `/network`, Add Extender wizard, operation polling
7. [ ] Integration test: full state machine via mock router fixture (DISCOVERED → AWAITING_APPROVAL → PROVISIONING → ONLINE → DECOMMISSIONED)
8. [ ] Update `docs/ROADMAP.md` M2.5 to link this ADR (Manager will handle in PR body)
