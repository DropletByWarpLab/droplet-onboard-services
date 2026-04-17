# Spec — Device Intelligence (Phase 1)

**Date:** 2026-04-16
**Status:** Draft for review
**Parent:** `docs/ADR-002-network-page-home-user-supervision.md` (Phase 1)
**Supersedes:** ADR-002 §Phase 1 (which is a rough sketch; this is the authoritative plan)

---

## 1. Context

Phase 0.5 landed 10 PRs of router-surface hardening: bearer auth, retry/timeout policy, typed `RouterError`, operation-id rollback tracking, rolled-up `/orchestrator/health`, firewall-payload typing, Docker-secret credentials, ROUTING_MODE with a fixture-driven mock, and a pytest harness with CI. The router surface is now authed, retrying, typed, rollback-aware, introspectable, and dev-laptop-friendly.

Phase 1 turns that foundation into the first **home-user-facing** feature on `/network`: the Devices tab. Instead of raw DHCP leases and MAC addresses, the user sees named, iconed, grouped devices they can block, rename, and track over 30 days.

This spec replaces the Phase 1 sketch in ADR-002 §Phase 1 with a fully-resolved plan: data model, API surface, UI design, build pipeline, testing strategy, ticket decomposition, and an agent-driven execution harness.

## 2. Goals

- Every observed MAC becomes a `NetworkDevice` row with persistent metadata (display name, icon, group, notes, vendor, first/last seen).
- The `/network` Devices tab renders a 3-column card grid sectioned by room-based groups.
- Home users rename a device, add/remove groups, change icons, add notes, and block/unblock — all with ≤2 clicks from the list.
- Every device card shows a 30-day presence sparkline fed by a daily rollup table.
- Vendor is resolved offline from a bundled IEEE OUI registry; refreshed quarterly via scheduled CI.
- Phase 0.5 invariants are preserved: every network call still flows through `routingFetch` (retry/auth/typed errors), writes still get Operation-Id tracking, `ROUTING_MODE=mock` renders the full UI without a real OpenWrt, `ROUTING_MODE=disabled` shows the existing disabled banner.

## 3. Non-goals

- **QoS / parental controls.** Tempting once we have groups, but out of scope — belongs to a future phase.
- **Time-of-day scheduling.** Same reason.
- **Intra-day presence timing.** The sparkline is per-day only. A sub-day presence log is explicitly deferred; the daily rollup covers the UX without the storage cost.
- **Multi-radio wireless attribution.** If a device hops between radios we track the last-seen radio, not a history.
- **Device-to-user binding.** A device isn't owned by a dashboard user account. All users see all devices.

## 4. Scope and ticket decomposition

Nine capabilities split into seven implementation tickets + one CI ticket + one harness ticket. All in Sprint 1, assigned to the project lead.

```
WARP-46  Data model (NetworkDevice, DeviceGroup, _DeviceToGroup, DevicePresenceDay)
   |        + Prisma migration + seeded rooms
   v
WARP-47  Reconciler service + OUI vendor lookup
   |        (observes DHCP/wireless, upserts devices, resolves vendor,
   |         writes daily presence rollup, cascades firewall block state)
   |
   +-----+-----+-----+-----+-----+
   v     v     v     v     v     v
WARP-48 WARP-49 WARP-50 WARP-51 WARP-52 WARP-53
API     List    Detail  Group   Block/  CI: OUI
layer   grid    panel   manager unblock refresh
                                wiring

WARP-54 Agent harness documentation + dry-run
```

| Ticket | Summary | Depends on | Rough size |
|---|---|---|---|
| **WARP-54** | Agent harness doc + first dry-run of the pipeline | — | S |
| **WARP-46** | Prisma data model + migration + group seeds | — | S |
| **WARP-47** | Reconciler + `oui-lookup.service` + bundled CSV + daily rollup job | WARP-46 | M |
| **WARP-48** | Orchestrator API — `/network/devices/*` + `/network/groups/*` | WARP-46, WARP-47 | S |
| **WARP-49** | Dashboard card grid list view, sectioned by group | WARP-48 | M |
| **WARP-50** | Detail panel — rename, icon picker, notes, sparkline | WARP-49 | L |
| **WARP-51** | Group manager dialog + chip-edit UX on cards | WARP-49 | M |
| **WARP-52** | Block/unblock wired from card to existing firewall endpoints | WARP-49 | S |
| **WARP-53** | `.github/workflows/refresh-oui.yml` + `scripts/fetch-oui.sh` | WARP-47 | S |

**Execution order:** WARP-54 first (harness dry-runs on WARP-46 before any code ships). Then WARP-46 → WARP-47 sequentially. After that, **WARP-48–WARP-53 run in parallel** under the agent harness.

## 5. Data model

### 5.1 Prisma additions

Added to `apps/orchestrator/prisma/schema.prisma`:

```prisma
model NetworkDevice {
  mac           String    @id                    // normalized "AA:BB:CC:DD:EE:FF"
  displayName   String?
  icon          String?                          // Lucide icon name (e.g. "tv")
  notes         String?
  vendor        String?                          // resolved from OUI lookup
  hostname      String?                          // last-known DHCP hostname
  lastIp        String?
  firstSeen     DateTime  @default(now())
  lastSeen      DateTime  @default(now())
  isBlocked     Boolean   @default(false)
  groups        DeviceGroup[]       @relation("DeviceGroups")
  presenceDays  DevicePresenceDay[]
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([lastSeen])
  @@index([vendor])
}

model DeviceGroup {
  id            String    @id @default(cuid())
  name          String    @unique
  color         String?                          // optional hex
  icon          String?                          // optional Lucide icon
  devices       NetworkDevice[]     @relation("DeviceGroups")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}

model DevicePresenceDay {
  mac           String
  date          DateTime  @db.Date
  seenMinutes   Int       @default(0)            // 0-1440
  device        NetworkDevice       @relation(fields: [mac], references: [mac], onDelete: Cascade)

  @@id([mac, date])
  @@index([date])
}
```

### 5.2 Migration seed

Migration `20260416_device_intelligence` creates the three tables and inserts five default groups: `Living Room`, `Bedroom`, `Office`, `Kitchen`, `Garage`. Seed is idempotent (`ON CONFLICT DO NOTHING`) so re-running the migration on an existing install never destroys user-added groups.

### 5.3 MAC normalization

All MACs stored uppercase, colon-separated, six octets. A single helper `normalizeMac(raw: string): string` in `apps/orchestrator/src/lib/mac.ts` handles variants from the routing service (both `AA:BB:...` and `aa-bb-...` formats appear in wild UCI dumps). MACs pass through `normalizeMac()` at three boundaries: reconciler ingesting routing-service responses, API handlers parsing request params (`req.params.mac`), and any service-layer DB lookup by MAC. Invalid MACs rejected with `DeviceRegistryError({ code: "INVALID_MAC" })`.

### 5.4 Retention

- `DevicePresenceDay` rows older than 30 days deleted by a daily cron at 03:00 local, implemented via `device-registry.service.ts::purgePresenceRows()`.
- `NetworkDevice` rows never auto-expire. Manual "Forget device" action deletes the row (presence rows cascade).

## 6. Service layer

### 6.1 `oui-lookup.service.ts`

- Loads `apps/orchestrator/data/oui.csv` once at startup into `Map<string, string>` keyed by the 6-hex-char prefix (uppercase, no separator).
- Single public method: `lookup(mac: string): string | null`.
- Size: ~35K entries, ~4 MB on disk, ~1-2 MB in memory.
- Missing CSV file fails closed — logs a warning, returns `null` for every lookup. Orchestrator still boots.

### 6.2 `device-registry.service.ts`

- `reconcile(leases: DhcpLease[], wirelessClients: WirelessClient[], firewallState: FirewallRules)` — runs at the existing DHCP poll cadence (10s):
  - Upserts observed MACs into `NetworkDevice` (sets `lastSeen = now()`, updates `lastIp`, `hostname`).
  - On first sight: resolves `vendor` via `oui-lookup`.
  - Cross-references firewall rules: if a device's MAC has an active REJECT rule (from `block-device`), `isBlocked = true`; else `false`. If the firewall fetch fails (typed `RouterError`), `isBlocked` stays at its last-persisted value — we never silently clear the flag.
  - Increments `DevicePresenceDay.seenMinutes` for today's row by the poll-interval delta (default 10 s → 0.17 min per tick, rounded to whole minutes at day boundary).
- `purgePresenceRows()` — cron at 03:00, deletes rows where `date < today - 30d`.
- `forgetDevice(mac)` — deletes the `NetworkDevice` row; presence rows cascade.

### 6.3 `network-device.service.ts`

- `listDevices(opts?: { onlineOnly?: boolean; groupId?: string })` — joins `NetworkDevice` with live snapshots from `openwrt.client` (wireless signal, lease expire), enriches with vendor fallback. Classifies `online = lastSeen > now() - 2min`.
- `getDevice(mac)` — single device + last 30 `DevicePresenceDay` rows.
- `updateDevice(mac, patch: { displayName?, icon?, notes? })` — field updates. Icon validated against the Lucide device-icon allowlist; invalid → `DeviceRegistryError({ code: "INVALID_ICON" })`.
- `assignDeviceGroups(mac, groupIds: string[])` — replaces the device's group set.
- `listGroups()`, `createGroup(name, color?, icon?)`, `renameGroup(id, patch)`, `deleteGroup(id)` — standard CRUD. `deleteGroup` cascades on the join table (devices stay, just become ungrouped).
- Duplicate group name (case-insensitive) → `DeviceRegistryError({ code: "DUPLICATE_GROUP_NAME" })`.

### 6.4 Error surface

New typed error alongside the existing `RouterError` (WARP-39):

```ts
// apps/orchestrator/src/types/device-registry-error.ts
export type DeviceRegistryErrorCode =
  | "NOT_FOUND"
  | "GROUP_IN_USE"
  | "INVALID_ICON"
  | "INVALID_MAC"
  | "DUPLICATE_GROUP_NAME";

export class DeviceRegistryError extends Error {
  readonly code: DeviceRegistryErrorCode;
  // ...toJSON(), factories, same shape as RouterError
}
```

Routes return 400 with `{ error: DeviceRegistryError.toJSON() }`. Dashboard renders per-code toasts with rollback of optimistic updates.

## 7. API surface

Extends the existing `apps/orchestrator/src/routes/network.ts` router.

| Method | Path | Body / Params | Returns |
|---|---|---|---|
| GET | `/api/network/devices` | `?onlineOnly=1&groupId=xxx` | `{ devices: EnrichedNetworkDevice[] }` |
| GET | `/api/network/devices/:mac` | — | `{ device, presence: DevicePresenceDay[] }` |
| PATCH | `/api/network/devices/:mac` | `{ displayName?, icon?, notes? }` | updated device |
| POST | `/api/network/devices/:mac/groups` | `{ groupIds: string[] }` | updated device with group list |
| DELETE | `/api/network/devices/:mac` | — | 204 (forget device) |
| GET | `/api/network/groups` | — | `{ groups: DeviceGroupWithCount[] }` |
| POST | `/api/network/groups` | `{ name, color?, icon? }` | created group |
| PATCH | `/api/network/groups/:id` | `{ name?, color?, icon? }` | updated |
| DELETE | `/api/network/groups/:id` | — | 204 |

**Block/unblock is unchanged** — dashboard calls the existing `/api/network/firewall/block` + `/unblock`. The reconciler updates `NetworkDevice.isBlocked` after the firewall state changes.

**Legacy compat:** the old `GET /api/network/devices` response shape (raw DHCP lease list) is retained when `?legacy=1` is set, for one release. Dashboard migrates to the new shape immediately.

**Caching:** `network:devices:list` and `network:groups:list` Redis keys, 10 s TTL, invalidated on any write. Single-device GET is not cached.

## 8. Dashboard UI

### 8.1 Page structure

`/network` Devices tab replaces the current table with a sectioned card grid:

- **Header row:** search input, "online only" toggle, sort dropdown (Name / Last seen / Vendor), "Manage groups" button.
- **Sections:** one per `DeviceGroup` with at least one member, ordered alphabetically. Final section is `Ungrouped` for devices with no group assignments. Each section is collapsible (state persisted in `localStorage.droplet.network.sections`).
- **Responsive grid:** 3-col ≥1024 px, 2-col ≥640 px, 1-col below.
- **Sort within section:** online first, then by the active sort column.

### 8.2 Card

- Header: 48 px Lucide icon avatar + device `displayName` (fallback: `hostname → vendor → "Device"` in that order).
- Meta row: status dot + vendor + IP. Offline devices dimmed to 70 % with "last seen Xh ago".
- Chip row: one chip per assigned group (background = group color or default gray).
- Mini sparkline under chips (30 daily bars; height ∝ `seenMinutes/1440`).
- Hover reveals action row: `Block` / `Unblock` button.
- Click anywhere on the card opens the detail panel.

### 8.3 Detail panel (right-anchored slide-over, 440 px)

Opens over the grid without hiding it. Sections:

1. **Header:** editable `displayName` (save debounced 500 ms + immediate on blur/Enter) + "Change icon" button (opens Lucide icon grid).
2. **Groups:** chip row with × on each + typeahead input for "Add to group" (autocompletes existing groups; "Create <name>" appears when no match).
3. **Notes:** multiline textarea, save debounced 500 ms after last keystroke + immediate save on blur.
4. **30-day activity:** larger sparkline + "Seen X/30 days" summary.
5. **Advanced (collapsed by default):** MAC, vendor, first-seen, last-seen — read-only.
6. **Footer:** `Block` / `Unblock` button + `Forget device` (confirms).

All mutations optimistic with rollback on error toast.

### 8.4 Group manager

Modal from the "Manage groups" header button:

- List of groups with inline rename, color swatch picker, member count.
- Delete button per row — confirms "N devices will become ungrouped".
- "Add group" text field at bottom + create button.

### 8.5 Icon picker

Lucide grid of ~20 device-relevant icons: `Tv`, `Smartphone`, `Laptop`, `Tablet`, `Router`, `Speaker`, `Camera`, `Lightbulb`, `Gamepad`, `Monitor`, `Printer`, `Watch`, `Thermometer`, `Lock`, `Headphones`, `Mouse`, `Keyboard`, `Radio`, `Disc`, `HelpCircle` (as the generic fallback). Current selection ringed; click to pick, auto-closes on select.

### 8.6 Error + loading states

- Router disabled / unreachable — existing WARP-39 banners unchanged.
- Empty devices list — "Your router hasn't seen any devices yet" + Retry button.
- Mutation failure — toast with the `DeviceRegistryError.code` translated to user copy (`DUPLICATE_GROUP_NAME` → "A group with that name already exists"). Optimistic update rolls back.

### 8.7 SWR keys

| Key | Refresh | Invalidated on |
|---|---|---|
| `/api/network/devices` | 10 s | any device / group mutation |
| `/api/network/groups` | 30 s | any group mutation |
| `/api/network/devices/:mac` | 10 s when panel open, paused when closed | that device's PATCH |

## 9. OUI refresh pipeline

### 9.1 Initial checked-in CSV

`apps/orchestrator/data/oui.csv` — normalized form of IEEE's public OUI registry. ~4 MB, ~35 K rows. One-time fetch in WARP-47 via `scripts/fetch-oui.sh`.

### 9.2 Dockerfile

`apps/orchestrator/Dockerfile` gains one `COPY data/oui.csv ./data/oui.csv` step. Orchestrator startup loads the file. If missing, `oui-lookup.service` logs a warning and returns `null` for every lookup (graceful degradation).

### 9.3 Quarterly refresh

`.github/workflows/refresh-oui.yml`:

- Trigger: cron `0 12 1 */3 *` (12:00 UTC, 1st of Jan/Apr/Jul/Oct) + `workflow_dispatch`.
- Steps: checkout → run `scripts/fetch-oui.sh` → diff-check → `peter-evans/create-pull-request@v6` opens PR if changed.
- Never auto-merges — human reviews the vendor diff.

### 9.4 `scripts/fetch-oui.sh`

- Fetches `https://standards-oui.ieee.org/oui/oui.csv` (official URL).
- Normalizes: uppercase MAC prefix, strips whitespace, sorts alphabetically by prefix.
- Writes to `apps/orchestrator/data/oui.csv`.
- Verifies file is reasonable size (> 2 MB, < 10 MB) else exits non-zero.

## 10. Testing strategy

Every PR runs the full cross-cutting suite. Green everywhere is a merge precondition.

### 10.1 New coverage

| Layer | Tool | Target |
|---|---|---|
| Prisma migration | `prisma migrate diff` in CI | migration creates tables + seeds groups correctly |
| OUI lookup | vitest | load, hit, miss, malformed CSV, missing file graceful |
| Reconciler | vitest | upsert new, update existing, block-state cascade, presence increment, first-seen preservation |
| Network-device service | vitest | list, filter, patch validation, group assign, duplicate name, forget |
| API routes | supertest + vitest | happy path + each typed error code + auth gate |
| OUI fetch script | shellcheck + integration test | downloads, normalizes, size-validates |
| Dashboard components | vitest + testing-library | DeviceCard, DetailPanel, GroupManager, IconPicker, sparkline render |
| Dashboard hooks | vitest | `useNetworkDevices`, optimistic update + rollback |

### 10.2 Regression baselines

Every PR must keep:

- `apps/orchestrator` — 257+ vitest tests passing, `tsc --noEmit` clean
- `apps/web-dashboard` — existing tests passing, `tsc --noEmit` clean
- `services/routing` — 73 pytest tests passing
- `setup-e2e`, `docker-build`, `security-tests` workflows green

### 10.3 Device-side acceptance

Recorded but run manually on the next hardware run for each ticket (not blocking):

- Reconciler upserts real DHCP leases correctly on a live router.
- OUI vendor resolves correctly for Apple / Samsung / Ring / Philips devices.
- Blocking a device from the card removes it from LAN within < 5 s.
- 30-day sparkline reflects reality after a week of real use (soft check — delayed by definition).

## 11. Agent harness

### 11.1 Role matrix

Each ticket flows through four agent roles in sequence (UI/UX skipped for non-dashboard tickets).

| Role | Agent type | Spawned when | Input | Output |
|---|---|---|---|---|
| **Dev** | `general-purpose` | Ticket moves to In Progress | Spec section + AC + code-style guide + existing-code links | Branch with local tests passing + self-assessment |
| **QA** | `general-purpose` (QA prompt) | Dev branch pushed | Branch diff + test plan + regression suite list | Pass/fail + specific failing cases + coverage gaps |
| **UI/UX** | `general-purpose` (UI/UX prompt) | Dashboard tickets only (49, 50, 51, 52) | Branch diff + mockup link + home-user heuristics + design-system paths | UX review: hierarchy, copy, a11y, responsive issues, consistency |
| **Manager** | `general-purpose` (PM prompt) | After QA + UI/UX return | Ticket AC + commits + QA report + UX review | Scope-fit verdict, release-note draft, PR body |
| **Code reviewer** | `superpowers:code-reviewer` | After PR opened and CI green | PR diff + spec + ticket | Final review comment on the PR |

### 11.2 Promotion gate per ticket

1. Dev delivers branch; local unit + integration tests green.
2. QA reviews branch — runs regression; returns report.
3. UI/UX reviews (dashboard tickets only) — returns report.
4. Manager synthesizes QA + UI/UX; produces PR body.
5. PR opens; CI runs all seven workflows.
6. Code reviewer agent comments on the PR.
7. Human approves merge.

### 11.3 Ralph-loop entry (stuck CI only)

Reserved for CI that has failed twice after heuristic fixes. Trigger template:

```
/loop 5m check PR #XX CI status via `gh pr checks XX`. If green, stop.
If setup-e2e or docker-build failed with space / network / cache
errors, re-run via `gh run rerun <id> --failed`. If the failure is
source-code or test-code defect, produce a one-screen diagnostic and
stop — don't attempt autonomous code changes.
```

Auto-stops on green or on architectural failure.

### 11.4 Main-conversation handoff points

Main conversation pauses for the project lead only when:

- An agent flags product ambiguity (icon semantics, delete-group behavior, etc.).
- CI has a systemic failure that ralph-loop can't resolve.
- A ticket's AC materially changes mid-execution.
- Before merging any PR (human is the final gate).

## 12. Acceptance criteria per ticket

**WARP-46 — Data model**
- Migration creates three tables, seeds five default groups idempotently.
- `normalizeMac()` helper + unit tests.
- `tsc --noEmit` + Prisma validate clean.

**WARP-47 — Reconciler + OUI**
- On DHCP poll, observed MACs appear in `NetworkDevice` with vendor resolved.
- Daily rollup `seenMinutes` increments correctly; purge cron runs at 03:00.
- Block-state cascade verified — blocking a device via firewall updates `isBlocked`.
- OUI lookup: 35K+ entries loaded; missing-file path returns null gracefully.

**WARP-48 — Orchestrator API**
- All 9 endpoints return typed responses + typed errors.
- Caching invalidates on writes (verified by integration test).
- Auth gate: unauthenticated calls rejected (uses existing middleware).

**WARP-49 — Card grid list**
- Grid renders 3/2/1 column responsively.
- Sections-by-group collapsible, state persisted.
- Online-first + alphabetical sort within section.
- Empty state rendered when no devices.

**WARP-50 — Detail panel**
- Slide-over opens over grid, grid stays visible.
- Inline rename saves on blur, debounced.
- Icon picker grid of ~20 Lucide options.
- Sparkline renders 30 daily bars; "seen X/30 days" copy correct.
- "Forget device" confirms + deletes row.

**WARP-51 — Group manager**
- Create, rename, color-pick, delete flows work.
- Duplicate-name validation shows typed error.
- Deleting group confirms count of affected devices.
- Typeahead on card chip-edit works with existing groups + "Create new".

**WARP-52 — Block / unblock wiring**
- Card button triggers existing firewall endpoint.
- Reconciler picks up state change, card reflects it within 10 s.
- Tier 2 confirmation flow (WARP-41) preserved.

**WARP-53 — CI refresh**
- `refresh-oui.yml` runs on schedule + manual dispatch.
- Opens PR with vendor diff when CSV changed; no-op otherwise.
- `fetch-oui.sh` validates download size + format.

**WARP-54 — Harness**
- Role prompts written + checked into `.superpowers/agents/`.
- Dry-run against WARP-46 produces a valid branch, QA report, manager PR body.
- Ralph-loop template documented.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reconciler race with firewall changes | Firewall block-state sync happens after firewall write confirms (Operation-Id terminal). |
| OUI CSV drift between releases | Quarterly refresh PR + graceful-degradation on missing file. |
| Too many groups slow the query | `@@index([lastSeen])` + `GroupMember.count` denormalized in the list endpoint. |
| Sparkline rendering 30+ bars × 40 devices is slow | Pre-aggregated `seenMinutes` means the list endpoint joins only 30 rows per device; rendering is <200 ms for a typical home. |
| Dashboard regression on existing Devices tab | Legacy shape preserved for one release via `?legacy=1`; tests cover both paths. |

## 14. Open questions (none blocking)

None as of 2026-04-16. All design decisions captured in §1–§11.

## 15. Success metric

A home user opens `/network`, sees their named devices sectioned by room, edits a name in place, and blocks a device — all without touching a MAC address, IP, or zone.
