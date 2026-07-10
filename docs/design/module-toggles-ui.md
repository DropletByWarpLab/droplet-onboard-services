# Module toggles per business type — UI design brief

**For:** design (dashboard UX) · **Backend:** shipped in this PR (`/api/modules`, `/api/business-types`) · **Spec:** `docs/superpowers/specs/2026-07-07-module-toggles-design.md` · **Surface:** `apps/web-dashboard`

## Goal

Let an operator pick a **business type** at setup (or later) and get a sensible default set of
**modules** turned on — then toggle any individual module. Modules that aren't deployed on this
box show as unavailable (can't be turned on). Disabling a module removes it from the nav and
from the AI's available tools, and its API is refused server-side.

Design two things:
1. A **Settings → Modules** page (business-type preset picker + per-module toggles).
2. **Nav behavior** — the sidebar hides modules that aren't effective.
(Optionally a **setup-wizard step** for first-run business-type selection — mark as phase 2 if out of scope.)

## Vocabulary (three states per module — get these visually distinct)

| State | Meaning | Toggle | Visual |
|---|---|---|---|
| **On** (effective) | available on this box **and** enabled | shows ON, interactive | normal, active |
| **Off** | available but the operator turned it off | shows OFF, interactive | normal, muted |
| **Unavailable** | not deployed on this box (`available:false`) | **disabled control**, cannot turn on | greyed + helper text "Not deployed on this box" |
| **Core** (`core:true`, only `chat`) | always on when available | **locked ON**, not interactive | lock affordance + tooltip "Always on" |

Note the subtlety: a module can be `enabled:true` but `available:false` (it was in the chosen
preset but its backend isn't installed) → render as **Unavailable** with a hint that it will turn
on automatically once deployed. `effective = available && enabled` is the single source of truth
for "is it actually on."

## API contract (already built — design to this)

`GET /api/modules` (any signed-in user):
```json
{
  "businessType": "clinic" | "professional_office" | "home" | "retail" | "hospitality" | "custom" | null,
  "modules": [
    { "id": "cameras", "label": "Cameras", "description": "Camera streams, events, and object detection (Frigate).",
      "category": "workspace" | "operations", "available": true, "enabled": true, "effective": true, "core": false }
  ]
}
```

`GET /api/business-types` (any signed-in user):
```json
{ "businessTypes": [
  { "id": "clinic", "label": "Clinic / practice", "description": "A practice — documents, scheduling, projects, cameras.",
    "modules": ["knowledge","files","docs","calendar","projects","cameras","network"] }
] }
```

`PATCH /api/admin/modules/:id` (owner/admin) — body `{ "enabled": true|false }` → returns the updated module state.
Errors: `409 core_module`, `409 module_unavailable`, `400 unknown_module`, `403 admin_required`.

`POST /api/admin/business-type` (owner/admin) — body `{ "type": "clinic" }` → returns the full modules view after applying the preset.
Error: `400 invalid_business_type`, `403 admin_required`.

**Write access:** only `owner`/`admin` roles see the interactive controls; `family`/`guest` see a
read-only view (or the page isn't in their nav at all — match how other admin/settings pages gate).

## Screen 1 — Settings → Modules

Fits the existing Settings section pattern (same chrome/typography as the other Settings pages;
see `apps/web-dashboard/src/app/globals.css` tokens and any existing Settings page for spacing).

**Layout, top to bottom:**

1. **Business type card** (the preset picker).
   - Shows the current `businessType` (or "Not set — using defaults" when `null`).
   - A selector of the 6 presets (`GET /api/business-types`) — card/radio group, each with its
     `label` + `description` + a small summary of what it turns on (e.g. "7 modules"). `custom` is
     the "I'll choose myself" option.
   - Selecting a preset (other than the current) → **confirm dialog**: "Apply the Clinic preset?
     This turns modules on/off to match — you can still change individual modules after." →
     `POST /api/admin/business-type`. This is destructive-ish (flips many toggles), so confirm.
   - After apply, the toggle list below reflects the new state; show a subtle "Applied" toast.

2. **Modules list**, grouped by `category` into two sections — **Workspace** and **Operations**
   (match the sidebar's group labels). Each row:
   - `label` (bold) + `description` (muted, one line).
   - A toggle on the right reflecting `enabled`.
   - The three-state treatment from the table above (On / Off / Unavailable / Core-locked).
   - Toggling → `PATCH /api/admin/modules/:id`. Optimistic update is fine; on error revert + toast
     the message (e.g. the 409 for trying to enable an unavailable one — though we should *prevent*
     that by disabling the control, the toast is the backstop).
   - When a preset is set and the operator flips an individual module away from it, that's expected
     — no need to auto-switch `businessType` to `custom`, but you MAY show a small "customized"
     hint on the business-type card.

**Empty/hint copy:** if every non-core module in a category is Unavailable, show a one-liner like
"These modules aren't installed on this box." Don't hide the category.

## Screen 2 — sidebar nav behavior

`Sidebar.tsx` already filters entries by `roles` and `requiresCapability`. Extend the SAME chain
with module effectiveness:
- Each nav entry that belongs to a module gets an optional `module: ModuleId`.
- Fetch `GET /api/modules` via a `useModules()` hook (mirror the existing `useCapabilities()` hook —
  30s cache, same shape).
- An entry with a `module` that isn't `effective` is **hidden** (same treatment as a failed
  `requiresCapability`).
- The **Settings → Modules** entry itself is always visible to owner/admin (it's how you turn things
  back on), and `chat` (core) is never hidden.

Module → nav mapping (from the registry `navHrefs`):
`files`→/files · `knowledge`→/knowledge · `email`→/email · `calendar`→/calendar · `projects`→/projects ·
`cameras`→/cameras,/events · `smart_home`→/devices · `network`→/network,/remote-access · `voice`→/voice.

## Screen 3 (phase 2, optional) — setup-wizard business-type step

If in scope: a first-run wizard step after the org step that presents the same preset picker
(`GET /api/business-types`) and calls `POST /api/admin/business-type`. It refines, and may be
prefilled from, the existing free-form `industry` onboarding hint. Otherwise the operator sets it
later from Settings → Modules.

## States to design (don't skip)

- **Loading** the modules list (skeleton rows).
- **Error** loading (`/api/modules` fails) — inline retry, don't blank the page.
- **Read-only** (family/guest, if the page is shown to them at all) — toggles rendered but disabled.
- **Toggle in-flight** (spinner on the control), **toggle error** (revert + toast).
- **Preset apply in-flight / applied / failed.**
- **Unavailable** module (disabled toggle + "Not deployed on this box").
- **Core** module (locked ON with a tooltip).

## Non-goals (v1)

- No per-*role* module enablement (roles gate *visibility* separately, unchanged).
- No container start/stop — disabling is runtime gating only (the container idles).
- Admin-only surfaces (Activity, RAG-eval) are NOT in this list — they keep their existing
  `/api/admin/capabilities` gating.

## Deliverables from design

- Hi-fi for Settings → Modules (all states above).
- The three-state toggle component spec (On/Off/Unavailable/Core) + tokens.
- Confirm-dialog copy for applying a preset.
- Nav-hiding behavior confirmation (it's a filter, no new component).
- (Phase 2) wizard business-type step, if pulled in.
