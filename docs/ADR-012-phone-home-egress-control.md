# ADR-012: Phone-home egress control for IoT, camera & smart-home devices

- **Status:** Accepted — shipped (status corrected 2026-07-27; see Status audit below)
- **Date:** 2026-05-31
- **Authors:** Stefan Cruceru
- **Related tickets:** WARP-613
- **Related ADRs:** [ADR-002](ADR-002-network-page-home-user-supervision.md) (network page / home-user supervision — this extends its device-intelligence surface); WARP-92/93 schedule ticker (parental controls) which this composes with.

## Context

Home users increasingly want their IoT gadgets, IP cameras, and smart-home
devices to stop "phoning home" — streaming telemetry, analytics, and usage data
to manufacturer cloud servers — while still working on the local network. A
smart bulb should still switch via Matter; a camera should still record to
Frigate; neither needs to reach the vendor's cloud to do so. This is a privacy
and data-sovereignty feature, and it is squarely on-brand for an appliance whose
whole pitch is "your data stays on the box."

The backend is already most of the way there. `FirewallApi.block_device(mac)`
(`services/routing/droplet_openwrt_sdk.py`) already builds the exact rule we
want — `src=lan, dest=wan, src_mac=<mac>, target=REJECT` — i.e. a **WAN-egress**
block that leaves LAN traffic intact. The schedule ticker (WARP-93,
`apps/orchestrator/src/services/schedule-ticker.ts`) already reconciles a
*desired* per-device block state against an *applied* state
(`NetworkDevice.lastAppliedBlocked`) and dispatches to the router every 30 s.
Devices can be grouped (`DeviceGroup`), and cameras are already isolated on
VLAN 100 behind a `cameras` firewall zone whose only path to the internet is a
single `cameras_to_wan` forwarding.

What is missing is (a) a *class-level* framing — "block all my cameras / IoT /
smart devices" rather than one MAC at a time; (b) a block that is **softer than
a full block** — it must still allow NTP (so clocks and camera timestamps stay
correct) and local DNS; and (c) a single, obvious **toggle** on `/network`.

We are deciding now because ADR-002 set the home-user IA for `/network` and the
device-intelligence + scheduling backends have landed, so this is additive
surface work rather than new foundations — and because "block phone home" keeps
coming up in customer conversations as a headline privacy feature.

## Decision

Add a **"Block phone home"** control to `/network`: one master toggle plus a
per-scope selection — **Cameras** (the whole camera VLAN) and **each device
group** (the user tags IoT/smart devices into groups). When a scope is on and
the master is on, in-scope devices get a **WAN-egress block with an NTP +
local-DNS carve-out** — distinct from the existing full block.

The two scopes use two different, deliberately chosen mechanisms:

1. **Cameras → zone level.** Cameras are not individual `NetworkDevice` rows we
   track per-MAC; they live on the `cameras` zone. Blocking is a single
   operation: drop the `cameras_to_wan` forwarding and ensure an
   `Allow-Camera-NTP` rule (udp/123) exists (camera DNS to the router is already
   allowed by `Allow-Camera-DNS`). One setting → one router transaction.

2. **Device groups → per-MAC, via a new egress reconciler.** A new
   `egress-reconciler.ts` runs on the existing cron-runtime. For each device it
   computes a desired **egress policy** and dispatches a phone-home block/unblock
   built from **distinctly named** uci rules (`phonehome-<mac>`), so they never
   collide with the schedule ticker's `block-<mac>` rules. The reconciler
   **yields to a full block**: if a device is currently full-blocked (schedule,
   manual, or override), no phone-home rule is applied and any stray one is
   removed — the full block already denies all WAN, and leaving an NTP allow
   behind would be a leak.

State is explicit (handbook rule #3): a new enum
`DeviceEgressState { open, phone_home_blocked, full_blocked }` and a
`NetworkDevice.lastAppliedEgress` column record what the reconciler last pushed
to the router. The master + camera toggles persist as `WorkspaceSetting` keys in
the existing `hardware` section. The existing schedule ticker, `computeDesiredBlocked`,
and `lastAppliedBlocked` are **left untouched** — the egress reconciler is purely
additive, which keeps the blast radius and review surface small.

**Persona:** Home user (per ADR-002). **Auth:** owner/admin only, through the
existing network-safety Tier-2 confirmation evaluator. **Offline-first:** no
external services; everything is uci on the local OpenWrt.

## Consequences

### Positive

- One toggle expresses a high-value privacy outcome ("my cameras can't talk to
  the cloud") without the user touching zones, rules, or MACs.
- Devices keep working: LAN, NTP, and local DNS survive the block, so clocks and
  Matter/Frigate control are unaffected.
- Reuses the proven reconcile→diff→dispatch pattern and the safe-apply rollback,
  so a bad rule can't strand the network.
- The schedule ticker is untouched; the two systems compose by construction
  (separate rule names + explicit precedence), not by careful ordering.

### Negative

- Two enforcement paths (zone-level for cameras, per-MAC for groups) is more
  surface than a single path. Mitigated by both going through one routing-service
  API and one dashboard card.
- A second reconciler doing per-device diffs adds a small amount of recurring
  work per tick (bounded by device count, home-scale).
- "IoT/smart" classification is manual (the user assigns devices to groups). No
  auto-magic in v1 — see Alternatives + Open questions.

### Neutral

- `ScheduleEvent` is reused for the egress audit trail (transition + reason),
  so no new audit table.
- Adds two `WorkspaceSetting` keys to the `hardware` section; no new
  `SettingSection` value (keeps that enum stable per its schema comment).

## Alternatives considered

### Alternative 1: Extend the schedule ticker instead of adding a reconciler

Fold phone-home into `computeDesiredBlocked` by widening its return from a
boolean to a policy enum and teaching the one ticker to dispatch three states.

**Why rejected:** it changes the signature and state model of a load-bearing,
well-tested service (and `lastAppliedBlocked`, and every ticker test) for a
feature that is conceptually separate. Higher blast radius, harder review, and
it entangles parental-controls scheduling with privacy egress for no real gain.

### Alternative 2: DNS / domain blocklist of telemetry endpoints

Block known manufacturer-telemetry domains at the resolver instead of blocking
WAN egress.

**Why rejected:** it is not "block *all* phone home" — it is a curated, always-
stale list that needs maintenance and a network call to stay current, which
violates offline-first. A WAN-egress block is complete and self-contained. (A
domain blocklist could later complement this as a *lighter* mode — see Open
questions.)

### Alternative 3: Reuse `block_device` as-is for groups (full block)

Just call the existing full block for every device in a phone-home group.

**Why rejected:** a full block drops NTP, so camera/device clocks drift and
timestamps go wrong; "block phone home" should not break the device. We need the
NTP (+ local DNS) carve-out, which is a different rule set.

## How to apply

**Prisma** (`apps/orchestrator/prisma/schema.prisma` + a timestamped migration):

- `DeviceGroup.blockPhoneHome Boolean @default(false)`.
- `enum DeviceEgressState { open phone_home_blocked full_blocked }`.
- `NetworkDevice.lastAppliedEgress DeviceEgressState @default(open)`.

**Routing service** (`services/routing/`), mirroring `FirewallApi.block_device`'s
uci add → commit → reload shape and wrapping multi-step writes in `safe_apply`:

- `block_phone_home(mac, name=None)`: add `phonehome-<mac>` rule
  (`src=lan, dest=wan, src_mac, target=REJECT`) **after** an NTP allow
  (`src=lan, src_mac, dest=wan, proto=udp, dest_port=123, target=ACCEPT`) so the
  ACCEPT precedes the REJECT in fw4 evaluation order. (LAN DNS is already open
  via `Allow-DNS-LAN`.)
- `unblock_phone_home(mac)`: delete both `phonehome-*` rules for that MAC.
- `set_camera_phone_home(blocked)`: when blocking, delete the `cameras_to_wan`
  forwarding and ensure `Allow-Camera-NTP` (cameras→wan udp/123); when
  unblocking, restore the forwarding and drop the NTP rule. Idempotent.
- Endpoints `POST /firewall/phone-home/device {mac, blocked}` and
  `POST /firewall/phone-home/cameras {blocked}` (bearer-auth like the rest);
  `mock_router` logs no-ops; pytest covers rule add/remove, ordering, camera
  flip, and idempotence.

**Orchestrator** (`apps/orchestrator/`):

- `openwrt.client.ts`: `blockPhoneHome(mac)`, `unblockPhoneHome(mac)`,
  `setCameraPhoneHome(blocked)` (use `postJson` + `opFrom`).
- `network.service.ts`: thin service fns + group/setting persistence.
- `egress-reconciler.ts`: cron-runtime job (own advisory lock). A camera pass
  dispatches `setCameraPhoneHome(master ∧ cameras)` when it changes (single
  global bit, tracked in memory — one idempotent re-assert on restart is
  harmless). A per-device pass computes `desired = master ∧ device ∈ a
  blockPhoneHome group ? phone_home_blocked : open`; when the device's full-block
  state (`lastAppliedBlocked === true`) holds, desired is `full_blocked` so the
  phone-home rule is removed (full block wins). Diff `lastAppliedEgress`,
  dispatch, write a `ScheduleEvent` (transition + reason `"phone_home"`), update
  the column — atomically, like the schedule ticker.
- Routes: `GET /network/phone-home`, `PATCH /network/phone-home` (master +
  camera settings), `PATCH /network/groups/:id` (extends the existing group
  PATCH). Declarative — they write desired state and the reconciler enforces, so
  `requireRole("owner","admin")` is the only gate (no per-write Tier-2 token;
  the LLM tool carries `requiresConfirmation`). `PATCH` not `PUT` so the
  tools-core `HttpClient` can reach it.
- Settings: register the two `hardware` keys in the settings validator.

**tools-core** (`packages/tools-core/src/handlers/network/set-phone-home-blocking.ts`),
mirroring `block-network-device.ts`: `requiresWrite: true`,
`requiresConfirmation: true`; register in `registry.ts`.

**Dashboard** (`apps/web-dashboard/src/app/network/`): a "Block phone home" card
— master toggle, Cameras row, one row per `DeviceGroup`; Tier-2 confirm via
`useNetwork`; reflects applied state.

## Open questions

- **Auto-classification.** v1 is manual grouping. A later ticket could seed
  default groups and pre-tag obvious IoT/smart vendors from the offline IEEE OUI
  list (the device intelligence work already ships that CSV).
- **A lighter "telemetry-only" mode.** A future DNS-blocklist mode could block
  known cloud-telemetry domains while *allowing* other internet (e.g. for a TV
  that needs streaming but not analytics). Out of scope here.
- **Matter linkage.** Smart-home devices controlled via Matter aren't yet linked
  to their `NetworkDevice` MAC; until they are, the user tags them into a group
  by hand.

## Status audit — 2026-07-27

Flipped `Proposed` → `Accepted`. Evidence on `main`: the allowlist checker
`scripts/check-egress-allowlist.py` and the CI gate
`.github/workflows/egress-gate.yml` both exist, and `egress-gate` runs and
passes as a required check on every PR. A decision enforced by a blocking CI
gate is in force, not proposed.
