# Onboarding — Org + Owner setup

> **Status: ORG step IMPLEMENTED (PR #380). Owner-account creation is the
> existing `account` step (PR #373 / WARP-216) and is NOT re-implemented here.**

## Purpose

Back the **Organization** wizard step: name the single workspace (the "company
brain"), reserve its `droplet.local/<slug>`, and record LOCAL-only smart-default
hints (industry / size). The owner account is created at the separate `account`
step earlier in the wizard — see `ONBOARDING_STATE_MACHINE.md` for the step
order.

## Wizard placement

Org slots **after account**: `welcome → claim → account → org → internet → …`
(the #380 spec). The order lives in `SETUP_STEPS` (orchestrator
`setup.service.ts`) and the dashboard `STEPS` array; the `SetupStep` Prisma enum
is an unordered membership set. Org is **NOT skippable** — it gates the
workspace identity everything after hangs off.

## Backend contract

- `POST /api/setup/org { name, slug, tz, industry?, size?, logo? }` → persist
  the workspace + reserve `droplet.local/<slug>`, then advance the resumable
  wizard to `internet`. Responses:
  - `200 { ok, slug, reserved_host, next_step:"internet" }`
  - `400 { code:"ORG_FIELDS_REQUIRED" }` — missing name/slug/tz.
  - `400 { code:"ORG_SLUG_INVALID" }` — slug fails `[a-z0-9-]` / reserved word.
  - `409 { code:"ORG_SLUG_TAKEN" }` — slug already reserved.
- Slug is validated `[a-z0-9-]` (no leading/trailing/double hyphen, not a
  reserved platform word) and is UNIQUE. Validation REJECTS a bad slug rather
  than coercing it.
- Industry / size pick **LOCAL smart defaults only** (folders, example tools,
  camera policy) and are **NEVER sent off the box** (FEATURES.md §10). The
  service does no outbound I/O.
- The endpoint is allow-listed in `middleware/auth.ts` (exact path) so a refresh
  mid-org can persist under the wizard's public posture.

## Data model (Prisma)

The workspace is the **existing `Workspace` singleton** (`id = 1`, the same row
`/api/settings/workspace` flips Home↔Business on). Everyone the owner invites
joins this ONE workspace, so PR #380 EXTENDS that row rather than adding a second
table (one source of truth for "what is this workspace called"):

```prisma
model Workspace {
  id            Int           @id @default(1)
  type          WorkspaceType @default(HOME)
  displayName   String?       // workspace name (set by the org step)
  slug          String?       @unique   // reserves droplet.local/<slug>
  tz            String?
  industry      String?       // LOCAL smart-default hint — never off-box
  size          String?       // LOCAL smart-default hint — never off-box
  logoPath      String?
  orgConfigured Boolean       @default(false)  // EXPLICIT completion flag
  // …setBy/setAt/createdAt/updatedAt as before
}
```

`orgConfigured` is an EXPLICIT column — org-completed-ness is read from it,
NEVER inferred from `slug IS NULL` (CLAUDE.md no-guessing rule; WARP-218 /
ClaimCodeState precedent).

Migration `20260601010000_warp_onb_org_step` (ordered after #373's
`20260601000000`): guarded `ALTER TYPE … ADD VALUE 'org'` + `ADD COLUMN IF NOT
EXISTS` for the six fields + a guarded slug unique index. Re-runnable; seeds no
rows (the singleton is materialized lazily). Verified idempotent.

## Owner account (OUT OF SCOPE for #380)

Owner creation (`POST /auth/setup`, argon2id, `owner` role) already ships in the
`account` step (PR #373 / WARP-216, folding into the built-in directory per
ADR-012). It is intentionally NOT touched by the org PR — the scaffold's earlier
`POST /setup/owner` sketch is superseded by that existing endpoint.

## Acceptance criteria (ORG)

- Org persists onto the singleton; slug normalized (trim+lowercase) and reserved
  as `droplet.local/<slug>`; collision rejected inline (409); malformed slug
  rejected inline (400).
- `orgConfigured` flips true; the wizard advances to `internet`.
- Industry/size recorded locally; no outbound call.

## References

`FEATURES.md §10`; `onboarding-handoff/src/OnbWizard.jsx` (`WizOrg`);
`apps/orchestrator/src/services/setup-org.service.ts`;
`apps/orchestrator/src/routes/setup.ts` (`POST /setup/org`);
`apps/web-dashboard/src/components/setup/steps/OrgStep.tsx`.
