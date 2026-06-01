# WARP-613 — Phone-home egress control: design spec

- **Date:** 2026-05-31
- **Ticket:** WARP-613
- **ADR:** [ADR-012](../../ADR-012-phone-home-egress-control.md)
- **Status:** Design

This spec gives the concrete contracts behind ADR-012. The ADR holds the
decision and rationale; this holds the wire shapes, the exact uci rules, the
reconciler algorithm, and the test matrix.

## 1. Concepts & precedence

A device's **egress policy** is one of:

| Policy | Meaning | Router rules |
|---|---|---|
| `open` | normal — full internet | none added by this feature |
| `phone_home_blocked` | WAN egress denied except NTP + local DNS | `phonehome-<mac>` ACCEPT(udp/123) **then** `phonehome-<mac>` REJECT(→wan) |
| `full_blocked` | all WAN denied (owned by the schedule ticker) | `block-<mac>` REJECT(→wan) |

**Precedence (highest first):** `full_blocked` > `phone_home_blocked` > `open`.
`full_blocked` is owned entirely by the existing schedule ticker (WARP-93). The
egress reconciler never sets `full_blocked`; it only decides `phone_home_blocked`
vs `open`, and **suppresses its own block** (forces `open` on the router) when the
device is already `full_blocked`, so no NTP carve-out leaks past a full block.

Cameras are not per-MAC: the whole `cameras` zone is either phone-home-blocked or
not, controlled by one setting.

## 2. Data model (Prisma)

```prisma
enum DeviceEgressState {
  open
  phone_home_blocked
  full_blocked
}

model NetworkDevice {
  // ...existing...
  lastAppliedEgress DeviceEgressState @default(open)
}

model DeviceGroup {
  // ...existing...
  blockPhoneHome Boolean @default(false)
}
```

Settings (existing `WorkspaceSetting`, section `hardware`, type `bool`):

- `network.block_phone_home_enabled` — master switch. Default `false`.
- `network.cameras_block_phone_home` — camera scope. Default `false`.

Audit: reuse `ScheduleEvent` with `transition ∈ {blocked, unblocked}` and
`reason = "phone_home"`.

## 3. Routing service (FastAPI + SDK)

### 3.1 SDK — `FirewallApi` (`services/routing/droplet_openwrt_sdk.py`)

```
block_phone_home(mac, name=None)   # idempotent: unblock first, then add
  add rule  name=phonehome-ntp-<mac>  src=lan src_mac=<mac> dest=wan proto=udp dest_port=123 target=ACCEPT enabled=1
  add rule  name=phonehome-<mac>      src=lan src_mac=<mac> dest=wan target=REJECT enabled=1
  commit + reload                    # ACCEPT added before REJECT → matches first in fw4

unblock_phone_home(mac)
  delete every firewall.rule whose name in {phonehome-<mac>, phonehome-ntp-<mac>}
  commit + reload

set_camera_phone_home(blocked)
  if blocked:  delete forwarding 'cameras_to_wan'; ensure rule 'Allow-Camera-NTP' (src=cameras dest=wan proto=udp dest_port=123 ACCEPT)
  else:        ensure forwarding 'cameras_to_wan' (src=cameras dest=wan); delete rule 'Allow-Camera-NTP'
  commit + reload
```

Multi-step writes run inside `router.safe_apply(timeout=60)` so a connectivity
loss rolls back. Mirror `block_device`'s commit/reload exactly. (camera DNS is
already permitted by the shipped `Allow-Camera-DNS` rule.)

### 3.2 Endpoints (`services/routing/main.py`, bearer-auth, `/health` exempt)

```
POST /firewall/phone-home/device   {mac, blocked: bool}  -> {status:"ok", mac, blocked}
POST /firewall/phone-home/cameras  {blocked: bool}       -> {status:"ok", scope:"cameras", blocked}
```

`mock_router._MockFirewall` logs and no-ops both.

## 4. Orchestrator

### 4.1 Client (`services/openwrt.client.ts`)

```
blockPhoneHome(mac): WriteResult        -> POST /firewall/phone-home/device {mac, blocked:true}
unblockPhoneHome(mac): WriteResult      -> POST /firewall/phone-home/device {mac, blocked:false}
setCameraPhoneHome(blocked): WriteResult-> POST /firewall/phone-home/cameras {blocked}
```

### 4.2 Egress reconciler (`services/egress-reconciler.ts`)

Pure decision fn + ticker, mirroring `schedule.service.ts` + `schedule-ticker.ts`:

```
computeDesiredEgress({ masterEnabled, device, groups, fullBlocked }):
  if !masterEnabled            -> open
  if fullBlocked               -> open      # suppress; full block wins
  if device in any group with blockPhoneHome -> phone_home_blocked
  else                         -> open
```

`tickOnce()`: load master setting + devices(include groups). For each device,
`fullBlocked = device.lastAppliedBlocked === true`. Diff desired vs
`lastAppliedEgress`; on change dispatch `blockPhoneHome`/`unblockPhoneHome`, then
in one `$transaction` write a `ScheduleEvent` and update `lastAppliedEgress`.
RouterError → warn + preserve state (same discipline as the schedule ticker).
Registered via `cron-runtime` `scheduleInterval` next to the schedule ticker.

### 4.3 Routes (`routes/network-phone-home.routes.ts`), owner/admin

Declarative desired-state, mirroring the schedule routes — they write
settings/flags and the egress reconciler enforces on the router. No immediate
router dispatch, so no per-write Tier-2 confirmation token (the settings write is
the user's confirmation; the LLM-facing `set_phone_home_blocking` tool carries
`requiresConfirmation`).

```
GET   /network/phone-home  -> { enabled, cameras, groups:[{id,name,blockPhoneHome}] }
PATCH /network/phone-home  { enabled?, cameras? }  # upserts the two hardware settings
PATCH /network/groups/:id  { blockPhoneHome }      # extends the existing group PATCH
```

`PATCH` (not `PUT`) so the tools-core `HttpClient` (get/post/patch/delete, no
put) can reach it. Both master and camera scopes are enforced by the reconciler,
so even a generic `PATCH /settings/hardware` write converges.

## 5. tools-core

`set_phone_home_blocking` — `{ scope: "master"|"cameras"|"group", enabled: bool, groupId?: string }`,
`requiresWrite:true`, `requiresConfirmation:true`. Handler POSTs the matching
orchestrator route; passes confirmation through (`isConfirmationResponse`).

## 6. Dashboard

`/network` "Block phone home" card: master `Switch`; below it a Cameras row and
one row per `DeviceGroup` with its own switch (disabled while master off). Uses
`useNetwork`/group hooks; Tier-2 confirm via the existing `confirm(token, op)`
flow; rows show applied state.

## 7. Test matrix

- **routing pytest:** `block_phone_home` adds NTP-ACCEPT before REJECT; `unblock`
  removes both; double-block is idempotent; `set_camera_phone_home(true)` drops
  forwarding + adds NTP, `(false)` restores; all under safe_apply.
- **orchestrator vitest:** `computeDesiredEgress` truth table incl. master-off,
  full-block suppression, group membership; reconciler diff/dispatch + state
  persist + RouterError preserve; route auth (403 non-admin) + Tier-2 202.
- **tools-core vitest:** tool advertises write+confirmation; handler maps scope→route;
  confirmation passthrough.
- **security:** `scripts/test-security.sh` (no new `MATTER_*`, no secrets).
