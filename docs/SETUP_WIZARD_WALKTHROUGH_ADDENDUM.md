# Setup wizard walkthrough — addendum after reading the shared brain

> Read [`SETUP_WIZARD_WALKTHROUGH.md`](SETUP_WIZARD_WALKTHROUGH.md) first. This
> document patches it after a deep recon of `shared_brain` (Stefan's
> team knowledge base). The original design is **not wrong**, but some
> conventions and one architectural gap need to be reflected before code
> lands.

## What this work is, on the company's terms

- **Jira ticket: [WARP-174](https://warp-lab.atlassian.net/browse/WARP-174)**
  — *"M2.5 Guided setup wizard — WiFi + NAS shares + cameras steps"*
  (To Do, Stefan, size-xl). All commits in this branch reference it.
  Internet / Storage / Cameras are inside the original WARP-174 scope;
  VPN-walkthrough + AI-walkthrough + Help/Manual extend it per Stefan's
  brief in this session — Stefan can split into subtickets later if needed.

- **Maps to GTM milestone M2.5** (`docs/ROADMAP.md`): "Guided first-run
  setup — wizard-style UI for initial configuration: WiFi, NAS shares,
  camera setup." Currently `[~] Partial — admin-account portion done;
  network/storage/camera portions not started.` Landing this branch
  closes that gap.

- **Adjacent milestones already done:** M2.6 WireGuard remote access
  (`[x]` done — full backend + `/remote-access` page + the Cloudflare
  Tunnel relay/named-address model, ADR-025A in `droplet-fleet-hq`); my wizard's VPN step is the
  *first-run wrapper* over an already-shipped feature, not a new feature.
  Similarly Frigate parity is **complete**
  per `docs/FRIGATE_PARITY.md` (April 2026) — my Cameras step surfaces
  the existing capability set, doesn't reinvent it.

## Conventions to enforce (from `auto-claude/`)

### Persona — home user (ADR-002)

The dashboard's authoritative persona is the **home user**, not a
network admin or installer. ADR-002 codifies the three-tier progressive
disclosure: Primary visible, Secondary collapsed, Advanced hidden behind
a toggle. The wizard inherits this:

- **Wizard copy stays plain-language.** No "VLAN", "zone", "firewall
  rule", "static lease", "ONVIF" in primary surface text. Technical
  details belong in the wizard's "Learn more" callout, which is
  collapsible.
- **Named, not MAC'd / Iconed, not typed.** Each discovered device
  shows a friendly display name and an icon; the IP / MAC / RTSP URL
  live in expandable detail or are never shown.
- **Offline-first language.** **Never** "connect to cloud", "sync
  account", "paired device", "cloud backup". Everything is local. Even
  the AI step says "your conversations stay on this box" rather than
  "private mode" or "local-first mode" — the framing is "this is yours,
  full stop."
- **Tier 2 confirmation modals** for any destructive or
  infrastructure-altering action (e.g., enabling camera VLAN isolation).
  Use the existing pattern, not a freelance confirm.

### Design tokens — no freelancing

UI-UX agent role doc enforces this hard:

- Allowed: `dp-btn-primary`, `dp-btn-secondary`, `dp-card`, `dp-input`,
  `dp-row`, `dp-tile`, `dp-status-chip`, `dp-material`.
- Allowed: `type-large-title`, `type-title-1`, `type-title-2`,
  `type-headline`, `type-body`, `type-subheadline`, `type-footnote`,
  `type-caption-1`, `type-caption-2`.
- Allowed: `text-label-{primary,secondary,tertiary,quaternary}`,
  `bg-surface-{primary,secondary,tertiary,elevated}`,
  `bg-accent[/N]`, `bg-separator`, `bg-system-{red,orange,yellow,green,blue}`.
- **Disallowed:** any hardcoded hex / rgb / `font-size: Npx` outside
  the design tokens. UI-UX review fails the commit.

### Test conventions

- Vitest + `@testing-library/react`, fake timers via `vi.useFakeTimers()`.
- Mocks at module-resolution level: `vi.mock("@/lib/api", () => …)`,
  `vi.mock("@/lib/auth", () => …)`.
- File naming: `__tests__/setup.<step>.test.tsx`, matching the existing
  `setup.flow.test.tsx` and `setup.discovery-bounds.test.tsx`.
- Always assert on **DOM-visible** strings (`getByPlaceholderText`,
  `getByRole("button", { name: /create/i })`) — never on internal
  state. Refactor-resilient.

### Commit + branch conventions

- Branch `feat/<topic>` (or `feat/<topic>-<sub>`). Current branch
  `feat/setup-wizard-walkthrough` fits.
- Commit message subject ≤ 72 chars, **prefix with the topic**:
  `setup-wizard: extract per-step components...`. Existing repo uses
  this shape; the refactor commit already follows it.
- Reference `WARP-174` somewhere in the body — keeps the brain's Jira
  mirror correlatable with code.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context)
  <noreply@anthropic.com>` (matches Stefan's prior commits in this
  branch).

## Naming-level corrections to the original design doc

### Prisma model: `Drive`, not `DriveLabel`

The original doc proposed a `DriveLabel` model. Looking at the wider
schema (per ADR-002 §"Phase 1 — Device intelligence"), the convention
is `<Noun>` with a `displayName: string` field:

```prisma
model NetworkDevice {
  mac         String   @id
  displayName String
  icon        String?
  group       String?
  // …
}
```

Mirroring that for storage:

```prisma
model Drive {
  uuid        String   @id          // filesystem UUID, stable across reboots
  displayName String                // "Wedding Photos" etc.
  icon        String?               // optional lucide-icon name
  notes       String?               // free-text, "old SATA, replace 2027"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

`GET /api/storage/drives` gets a left-join to attach `displayName` /
`icon` / `notes` to each entry returned by the device-bridge.
`PATCH /api/storage/drives/:uuid` is the write endpoint, matching the
`PATCH /network/devices/:mac` shape from ADR-002 Phase 1.

This is a smaller renaming than it sounds — the original doc had
`DriveLabel`, this swaps to `Drive` to align with the network-side
naming pattern. The migration filename becomes
`<date>_add_drive_displayname` instead of `<date>_drive_label`.

### Wizard field labels follow existing copy

| Concept | Field label in wizard | Existing precedent |
|---|---|---|
| User's name | "Display Name" (already in AccountStep) | `User.displayName` (Nextcloud OCS) |
| Device peer name | "Device name" (was "Device Label" in /remote-access) | `VpnPeer.deviceLabel` — *might rename in a separate pass; for this wizard step, match what's already on screen so users see consistent language* |
| Drive friendly name | "Name" | `Drive.displayName` (new) |
| Camera friendly name | "Name" | `Camera.displayName` (existing per FRIGATE_PARITY) |
| Smart-home device | "Name" | `MatterDevice.name` (existing) |

When in doubt: **"Name"** for the input label, with placeholder text
giving a concrete example (`"Wedding Photos"`, `"Stefan's iPhone"`,
`"Front door"`).

## Endpoint host: provisioned, not derived at runtime

The earlier draft of this addendum flagged a gap around auto-deriving
`WIREGUARD_ENDPOINT_HOST` from dynamic-DNS state inside `vpn.ts`. That
gap no longer exists: remote access moved to the box's provisioned named
address (`<name>.droplet-us.com`) served over the Cloudflare Tunnel relay
(ADR-025A, `droplet-fleet-hq`) with a per-device publicly-trusted cert (ADR-023). The endpoint
host is set from that named address at provisioning time, so
`GET /api/vpn/status` reports `endpointConfigured: true` without the
Internet step having to configure any dynamic DNS — the VPN step's
"Create your first device" button is enabled from first boot.

## Inheriting from existing pages

I should not invent UI patterns where the dashboard already has them:

| Wizard step | Lift from |
|---|---|
| Internet (Home Wi-Fi) | `/network/page.tsx` Wi-Fi SSID + password inputs (existing). Same input shapes; same validation rules. |
| Storage | None — `Drive` is new. But mirror the visual shape of `NetworkDevice` cards from `/network` (icon + name + secondary). |
| Cameras | `/cameras/page.tsx` discovery banner + camera card components. Reuse, don't re-render. |
| VPN | `/remote-access/page.tsx` "Add device" dialog (QR + .conf + private-key-shown-once warning). Reuse via shared component if possible. |
| AI | `/chat/page.tsx` model picker + initial assistant message. Sample-prompt list is new content. |

Anywhere I add a new component, it must be reusable from the
post-setup dashboard too. The wizard isn't a one-off render; it's the
**first contact** with components the customer will see later.

## Updated decision-tree for the open questions

The original doc had 4 open questions; Stefan answered all 4 already.
Reaffirming them with brain context:

1. **Drive labels persistence** → New `Drive` Prisma model + `PATCH
   /api/storage/drives/:uuid`. ✓ Aligned with `NetworkDevice` shape
   per ADR-002 Phase 1.
2. **AI walkthrough depth** → Medium. ✓ Picker + sample chat +
   streaming; deep tutorial lives in /help.
3. **Help/Manual scope** → in this branch. ✓ Phase N folded in (now
   commit 8).
4. **Review style** → stacked commits, one per step. ✓ Commit 1
   (refactor) already shipped clean; pattern continues.

## What I'm *not* doing (anti-scope)

To prevent scope creep, this branch explicitly does NOT touch:

- `/devices` and `/files/devices` split (Romain's plan
  `2026-04-11-adr-separate-smart-home-file-sync.md` — separate work).
- The file-indexer / Nextcloud external storage label round-trip — the
  wizard's Storage step writes `Drive.displayName` to Prisma; surfacing
  it inside Nextcloud's Files app is a separate follow-up.
- RBAC / role enum (M2.2 — not started, scoped to its own ADR).
- OTA updates (M3.4), community marketplace (M3.6).
- Hardware-side anything (the v2.6 PCB work — Stefan's day-job, off-limits).

## Reading-order checklist for the next Claude session that picks this up

1. `docs/SETUP_WIZARD_WALKTHROUGH.md` — the original design doc.
2. This file — what changed after reading the brain.
3. `apps/web-dashboard/src/app/setup/page.tsx` — the (now-refactored)
   wizard shell.
4. `apps/web-dashboard/src/components/setup/steps/*.tsx` — existing
   step components.
5. `docs/ADR-002-network-page-home-user-supervision.md` (sibling repo
   in the brain — note that the brain mirrors source, so the
   authoritative copy is *in this repo*: see `docs/ADR-002-...`).
6. `auto-claude/agents/ui-ux.md` in the brain — the UI/UX role spec
   used for review.
