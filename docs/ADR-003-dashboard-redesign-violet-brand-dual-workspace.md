# ADR-003: Dashboard Redesign — Violet Brand + Dual Workspace (Home/Business)

**Status:** Accepted
**Date:** 2026-05-18
**Deciders:** Stefan Cruceru
**Supersedes (in part):** ADR-002 (still authoritative for the **Home**
workspace persona; the **Business** workspace introduces a separate IA)
**Tracking branch:** `feat/dashboard-redesign` (off `origin/main`)

## Context

The on-prem dashboard at `apps/web-dashboard/` was built around the
**home-user persona** documented in ADR-002 — indigo brand, single-user,
progressive disclosure for installer concepts. The Droplet GTM has since
expanded to cover SMB customers (photo studios, dealerships, RE
remodelers, small lenders) with 5–25 person teams, leases, multi-role
RBAC, and audit demands. The home persona alone no longer covers the
buyers we have under pilot.

In parallel, the **Droplet Design System** package (`Downloads/Droplet
Design System/`) shipped by the design team in May 2026 proposes a
visual + IA overhaul:

- Violet accent (`#7c3aed` default, with `#6d28d9` and `#bc13fe` listed
  as ramp options) replacing the indigo `#6366f1` brand
- Grouped sidebar (Workspace / Operations / Admin) instead of the flat
  primary/secondary/admin lists
- Six business roles (owner / admin / manager / member / viewer / guest)
  with a roles-permission matrix surface, plus Groups, Sessions, Billing
  pages that don't currently exist
- Three Home variants (A chat-first / B ops-first / C admin-first) so the
  landing screen matches the role's default
- iOS native companion app mockups (existing native plans are Android
  Compose — see `feedback_shared_brain_scope_check.md`)

These conflict with shared_brain canon on several axes:

| Axis | shared_brain canon (pre-2026-05-18) | Design System redesign |
|---|---|---|
| Accent | indigo `#6366f1` | violet `#7c3aed` / `#6d28d9` / `#bc13fe` |
| Display font | Inter + Instrument Serif (hero) | All-sans Inter |
| Aurora gradient | Signature AI surface | Replaced with flat linear |
| Persona | Home user (ADR-002) | Business multi-role |
| Nav IA | Flat primary/secondary | Grouped Workspace/Ops/Admin |
| Companion app | Android Compose (per memory) | iOS-styled mockups |

The HARD RULE (`feedback_align_with_shared_brain.md`) forbids me from
sidestepping shared_brain for convenience. I asked Stefan before
touching any code.

## Decision

1. **Accent: violet `#6d28d9`** (the middle option). It's Tailwind
   violet-700; balances saturation against the louder `#bc13fe`. The
   `droplet:*` Tailwind ramp re-points to violet 50–900 in the same
   commit that lands this ADR.

2. **Dual workspace.** At first-run setup the user picks **Home** or
   **Business**. The choice gates which IA the dashboard renders:

   | Surface | Home | Business |
   |---|---|---|
   | Sidebar caption groups | Workspace / Operations / Admin | Same |
   | Roles & permissions matrix | hidden (everyone = owner) | visible |
   | Groups & teams | hidden | visible |
   | Sessions & devices | hidden | visible |
   | People (full table) | simpler "Family / household" list | full table |
   | Plan & billing | visible (lease, storage upgrade, payments) | visible |
   | Activity log | gated to owner | gated to owner/admin |
   | Home variant default | B (ops-first) | role-driven (Owner→C, Member→A) |

   The choice is stored in `localStorage["droplet-workspace-type"]`
   during Phase 1–3. Phase 4 of the rehaul promotes it to a Prisma
   `workspace_type` column on `setup_progress` with a `/api/setup/workspace`
   endpoint; the hook hydrates from the endpoint and falls back to
   localStorage during the transition.

3. **Aurora stays — re-tinted violet.** The signature gradient survives
   in violet 200 → purple 100 → rose 200 form. The Instrument Serif
   display face stays — it's the brand voice on the AI hero and the
   redesign's all-sans choice was a designer preference, not a brand
   directive Stefan endorsed.

4. **Branch:** `feat/dashboard-redesign` off `origin/main`. Setup wizard
   work (`feat/setup-wizard-walkthrough`) rebases on top once Phase 1
   merges; POC (`poc/single-box`) is not touched — production-direction
   only.

5. **Companion app: iOS native SwiftUI**, separate body of work in
   Phase 5. Existing Android Compose work (`feat/native-mobile-clients`,
   WARP-341) remains where it is; not re-platforming.

## Persona policy

ADR-002 remains the authoritative persona doc **for Home installs**. No
language, copy, or progressive-disclosure rule from ADR-002 is being
weakened — Home dashboards still hide installer concepts (zones, VLANs,
MAC-as-primary-identity) behind an Advanced toggle, still use "named not
MAC'd" device cards, still bind WiFi config to a Tier 2 confirm.

For **Business installs** the persona is the SMB owner/admin who *does*
need to see roles, audit, lease, BYOK key rotation, sessions, billing.
Where the surface is per-workspace different, the Home view always
defaults to the simpler IA.

## Token + structural changes (Phase 1)

- `apps/web-dashboard/src/app/globals.css`:
  - `--color-accent` indigo → violet `#6d28d9`
  - `--color-accent-hover` → `#5b21b6`
  - Aurora ramp shifted to violet-200 / purple-100 / rose-200
  - New `--role-{owner|admin|manager|member|viewer|guest}` tokens
  - New density tokens `--row-h`, `--pad-card`, `--pad-x`, `--gap-tile`
    driven by `[data-density="dense|balanced|roomy"]`
- `apps/web-dashboard/tailwind.config.ts`:
  - `droplet:50..900` re-pointed from indigo to violet
  - New `surface.raised` semantic color
  - New `role.*` Tailwind color group
- `apps/web-dashboard/src/app/layout.tsx`:
  - `themeColor` indigo → violet
  - `WorkspaceProvider` mounted inside `AuthProvider`
- New `src/lib/workspace.tsx`:
  - `useWorkspace()` hook (workspaceType / setWorkspaceType / isHome /
    isBusiness / homeVariant)
  - `getHomeVariant(workspace, role)` pure mapper
- `src/components/Sidebar.tsx` rebuilt: grouped Workspace / Operations
  / Admin, workspace-aware visibility, hairline separators between
  drawer groups, "Home" / "Business" pill in the chrome
- New `src/components/Topbar.tsx` primitive (opt-in by pages — Phase 2
  retrofits Cameras / Files / Network / Devices / Settings)

## Action items (multi-phase)

| Phase | Scope | Branch | Status |
|---|---|---|---|
| 1 | Tokens + Workspace hook + Sidebar + Topbar primitive + this ADR | `feat/dashboard-redesign` | in progress |
| 2 | Rehaul existing pages (Chat / Files / Cameras / Network / Devices / Settings / Calendar / Knowledge / Remote-access) to match the Design System | `feat/dashboard-redesign` | pending |
| 3 | New backends + pages for Business workspace: Roles matrix, Groups, Sessions, full People, Plan/Billing | `feat/dashboard-redesign` | pending |
| 4 | Setup wizard step: pick Home/Business; persist to Prisma; migrate from localStorage hook | `feat/setup-wizard-walkthrough` rebased on `feat/dashboard-redesign` | pending |
| 5 | iOS native SwiftUI companion app reflecting the same design tokens | `feat/native-ios-app` (new) | pending |

## Future-agent notice

**Do not revert the violet accent to indigo without re-reading this ADR.**
The violet pivot was reviewed and signed off by Stefan on 2026-05-18.
If a future redesign wants a different accent, supersede this ADR
explicitly — don't quietly swap the tokens.

Likewise, **do not collapse Home + Business into a single workspace**
without an ADR successor. The dual IA is the product decision; the dashboard
is allowed to behave differently per workspace.
