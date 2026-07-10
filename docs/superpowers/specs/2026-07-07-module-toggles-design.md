# Module toggles per business type — design spec

**Status:** proposed (2026-07-07) · **Author:** stefan-cruceru · **Repo:** droplet-onboard-services (`apps/orchestrator` + `apps/web-dashboard`)

## Problem

Every Droplet ships the same capability set, but a dental clinic, a retail store, and a
household want different subsets of it. Today module availability is **deploy-time only**:
`COMPOSE_PROFILES` picks which containers run and env flags gate individual capabilities
(`DOCS_ENABLED`, `NEXTCLOUD_URL`, `DROPLET_MATTER_SERVICE_URL`, …). There is **no runtime,
operator-facing way** to turn a module on/off, and no notion of a "business type" that
presets a sensible module set. The dashboard nav is static.

We want: **an admin picks a business type at setup → gets a sensible default set of modules →
can then toggle any individual module.** UI + backend.

## Design decisions (confirmed with product owner)

1. **Toggle semantics = runtime gating.** Disabling a module (a) hides its dashboard nav
   entries, (b) blocks its `/api/*` routes server-side (404), and (c) drops its agent tools
   from the LLM. The container keeps running idle — no compose orchestration in v1.
   (Container start/stop is a possible phase 2.)
2. **Business types = seed presets + per-module override.** Ship a small catalog of vertical
   presets that each map to a default module set; applying one sets every module's enablement;
   individual modules can then be toggled to diverge from the preset.

## Two orthogonal axes (do not conflate)

| Axis | Meaning | Source of truth | Existing? |
|---|---|---|---|
| **Availability** | Is the module's backend actually deployed on this box? | `config.ts` (service URL set, profile active, env flag) — the *existing* deploy-time signals | yes |
| **Enablement** | Has the operator turned this module ON for this install? | new `ModuleSetting` table (runtime, UI-driven) | **new** |

A module is **effective** iff `available && enabled`. You can never enable an unavailable
module (the toggle is disabled + labelled "not deployed on this box"). This is what keeps the
new layer from fighting `COMPOSE_PROFILES`: availability stays deploy-time; enablement is a
runtime layer *on top*.

## Components

### 1. Module registry (code — the single source of truth for the catalog)

`apps/orchestrator/src/modules/module-registry.ts`. Mirrors the `packages/tools-core` "one
canonical registry" discipline. Each entry:

```ts
interface ModuleDef {
  id: ModuleId;                 // Prisma enum value
  label: string;                // "Cameras"
  description: string;          // one line for the settings UI
  category: "workspace" | "operations";  // maps to the Sidebar nav group
  routePrefixes: string[];      // e.g. ["/api/cameras"] — what requireModuleEnabled guards
  navHrefs: string[];           // e.g. ["/cameras", "/events"] — what the nav hides
  toolDomains: string[];        // tools-core handler domains to drop when disabled
  core: boolean;                // true = always effective when available, not user-toggleable
  defaultEnabled: boolean;      // fallback when there's no ModuleSetting row and no preset applied
  available(cfg: Config): boolean;  // availability signal, reusing existing config reads
}
```

Catalog (v1, user-facing capability modules — the admin-only `activity` / `rag-eval` surfaces
keep their existing `GET /api/admin/capabilities` probe and are out of scope here):

| id | label | category | routePrefixes | availability signal |
|---|---|---|---|---|
| `chat` | Ask AI | workspace | `/api/llm` | `AI_GATEWAY_URL` set (**core**) |
| `knowledge` | Knowledge | workspace | `/api/files-knowledge` | `FILE_INDEXER_URL` set |
| `files` | Files | workspace | `/api/files` | `NEXTCLOUD_URL` set |
| `docs` | Documents | workspace | `/files/docs` | `DOCS_ENABLED` && `DOCS_INTERNAL_URL` |
| `email` | Email | workspace | `/api/email` | `SERVICE_TOKEN_EMAIL` set |
| `calendar` | Calendar | workspace | `/api/pm/events` | native (always available) |
| `projects` | Projects | workspace | `/api/pm/projects` | native (always available) |
| `voice` | Voice | operations | `/api/voice`, `/api/stt` | `SERVICE_TOKEN_VOICE` set |
| `cameras` | Cameras | operations | `/api/cameras` | `FRIGATE_URL` set |
| `smart_home` | Devices | operations | `/api/matter`, `/api/devices` | `DROPLET_MATTER_SERVICE_URL` set |
| `network` | Network | operations | `/api/network`, `/api/vpn` | `ROUTING_SERVICE_URL` set |
| `managed_switch` | Managed switch | operations | `/api/switch` | `SWITCH_SERVICE_URL` set |

`chat` is **core**: always effective when available, never user-toggleable (a Droplet with no
assistant isn't a Droplet). Every preset includes it.

### 2. Business-type presets (code)

`BUSINESS_TYPES` catalog + `BUSINESS_TYPE_PRESETS: Record<BusinessType, ModuleId[]>`:

| BusinessType | modules ON (subject to availability) |
|---|---|
| `home` | chat, knowledge, files, calendar, voice, cameras, smart_home, network |
| `professional_office` | chat, knowledge, files, docs, email, calendar, projects, network |
| `retail` | chat, knowledge, files, calendar, cameras, smart_home, network, managed_switch |
| `clinic` | chat, knowledge, files, docs, calendar, projects, cameras, network |
| `hospitality` | chat, knowledge, files, calendar, voice, cameras, smart_home, network, managed_switch |
| `custom` | (no preset — leaves current toggles as-is) |

Applying a preset writes an explicit `ModuleSetting` row for **every** non-core module
(`enabled = presetSet.has(id)`), so post-apply the DB is fully materialized (no inference).

### 3. Persistence (Prisma — explicit state, WARP-171 discipline)

```prisma
enum ModuleId { chat knowledge files docs email calendar projects voice cameras smart_home network managed_switch }

enum BusinessType { home professional_office retail clinic hospitality custom }

/// One row per module. Explicit `enabled` boolean — never derived from absence
/// (CLAUDE.md no-guessing rule, same discipline as UserInvite.role / BrainMemoryItemStatus).
/// A MISSING row means "operator hasn't decided" → fall back to the registry's
/// versioned `defaultEnabled`; it is NOT an inferred runtime state. Applying a
/// business type materializes a row for every non-core module.
model ModuleSetting {
  moduleId  ModuleId @id
  enabled   Boolean
  setBy     String?
  setAt     DateTime @default(now()) @updatedAt
}
```

Business type lives on the existing `Workspace` singleton (id = 1), co-located with the
home/business `type` it refines:

```prisma
model Workspace {
  // … existing: id, type (WorkspaceType), displayName, setBy, setAt …
  businessType       BusinessType?  // null until a preset is applied
  businessTypeSetBy  String?
  businessTypeSetAt  DateTime?
}
```

### 4. API (mirrors `settings-workspace.ts` / `admin-capabilities.ts` shapes)

- `GET /api/modules` — any authenticated user. Drives the nav + settings page.
  ```json
  { "businessType": "clinic" | null,
    "modules": [
      { "id": "cameras", "label": "Cameras", "description": "...", "category": "operations",
        "available": true, "enabled": true, "effective": true, "core": false }
    ] }
  ```
  `Cache-Control: private, max-age=30` (same as capabilities — flips rarely).
- `PATCH /api/admin/modules/:id` — owner/admin. Body `{ "enabled": boolean }`.
  409 if enabling an unavailable module; 400 if `:id` isn't a `ModuleId`; 409 if `core`.
- `GET /api/business-types` — any authenticated user. Returns the catalog `[{ id, label, description, modules }]`.
- `POST /api/admin/business-type` — owner/admin. Body `{ "type": BusinessType }`. Applies the
  preset (materializes all non-core `ModuleSetting` rows) + records it on `Workspace`.

RBAC per ADR-004: reads = any authenticated principal; writes = `owner`/`admin` via the same
inline check the other settings routes use. Writes to `business-type` follow the
`workspace_type` precedent (owner-preferred; admin allowed — TBD, see open questions).

### 5. Server-side guard

`apps/orchestrator/src/middleware/module-gate.ts`:

```ts
requireModuleEnabled(moduleId: ModuleId): RequestHandler
// 404 { error: "module_disabled", module } when !effective — a disabled module reads as
// ABSENT (404), not FORBIDDEN (403). Fail-closed: DB/registry read error → 404, logged.
```

Applied to each module's router mount in `app.ts` (e.g.
`app.use("/api/cameras", requireModuleEnabled("cameras"), camerasRouter)`), so a disabled
module can't be reached even by direct API call. v1 wires the guard for the toggleable modules
listed above; core (`chat`) is never guarded.

### 6. Agent-tool filtering

The agent's tool list (built where the orchestrator lists MCP tools for the LLM) filters out
any tool whose `tools-core` handler domain maps to a disabled module — so a disabled "cameras"
module also removes camera tools from what the LLM can call, keeping the assistant honest about
what's on. Registry `toolDomains` is the map; a small `enabledToolDomains()` helper feeds the
existing tool-listing path.

### 7. Dashboard (design MD ships separately for the design team)

- `useModules()` hook (extends the `useCapabilities()` pattern) fetches `GET /api/modules`.
- `Sidebar.tsx` `NAV_GROUPS` entries gain an optional `module?: ModuleId`; an entry with a
  `module` that isn't `effective` is hidden — same filter chain as the existing
  `requiresCapability`.
- New **Settings → Modules** page: business-type preset picker + per-module toggles grouped by
  category; unavailable modules shown disabled with "not deployed on this box"; core modules
  shown locked-on. Full UX in `docs/design/module-toggles-ui.md`.

## Rollout / migration

- One Prisma migration: add the two enums, `ModuleSetting`, and the `Workspace.businessType*`
  columns. No data backfill needed — absence falls back to registry defaults, so existing
  installs behave exactly as today until an admin picks a business type.
- Backward compatible: the deploy-time env/profile gating is untouched; this is purely additive.

## Testing

- `modules.service` unit: availability×enablement→effective matrix; preset application
  materializes rows; can't enable unavailable; core always effective.
- `modules.routes` integration (real DB, per CLAUDE.md — no mock DB): GET shape, PATCH
  owner/admin gate + 409s, business-type apply.
- `module-gate` middleware: 404 when disabled, pass-through when effective.
- ship-check + tsc clean before PR.

## Open questions (surface before merge)

1. **business-type write role:** owner-only (like `workspace_type`) or owner+admin? Proposing
   owner+admin for module toggles, owner-only for the business-type preset (strategic).
2. **Per-role module visibility** stays orthogonal (existing nav `roles` field) — a module can
   be enabled install-wide yet still hidden from `guest` by role. Confirm we don't want
   per-role enablement in v1 (adds a Role[] column; deferred).
3. **activity / rag-eval** admin surfaces: fold into this registry later, or keep on the
   existing capabilities probe? v1 keeps them separate.
