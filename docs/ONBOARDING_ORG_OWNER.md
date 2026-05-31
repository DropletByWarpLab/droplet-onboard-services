# Onboarding — Org + Owner setup (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

Back the new **Organization** wizard step and the **owner-account** creation:
name the workspace, reserve its `droplet.local/<slug>`, and create the first
(owner) user. See `ONBOARDING_CLAIM_ORG_TEAM_HANDOFF.md` for the UI.

## Backend contract

- `POST /setup/org { name, slug, tz, industry, size, logo }` → persist workspace
  on encrypted NVMe. Validate slug `[a-z0-9-]` + uniqueness; reserve
  `droplet.local/<slug>` (mDNS host `Droplet.local`).
- `POST /setup/owner { name, email, password }` → create the owner (argon2id;
  role=`owner`). Folds into the built-in directory (ADR-012).
- Industry/size pick **local smart defaults only** (folders, example tools,
  camera policy) — **never sent off the box**.

## Data model (Prisma)

```prisma
model Workspace {
  id        String  @id @default(uuid())
  name      String
  slug      String  @unique
  tz        String
  industry  String?
  size      String?
  logoPath  String?
  createdAt DateTime @default(now())
}
```

## Architecture rules

- Slug uniqueness enforced at the DB; reserved-word list.
- Owner creation is one-shot + idempotent on re-run (state machine guards step).
- Smart-defaults computed locally; no outbound calls.

## Dependencies

Blocked by setup state machine + built-in directory. Precedes Team.

## Acceptance criteria

- Org persists; slug collision rejected inline; mDNS host reflects slug.
- Owner created with argon2id hash + `owner` role.

## References

`FEATURES.md §3`; `onboarding-handoff/src/OnbWizard.jsx` (`WizOrg`,`WizAccount`);
`apps/orchestrator/src/routes/auth.ts` (`/auth/setup` to generalize).
