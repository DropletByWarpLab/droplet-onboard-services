# Onboarding — Okta SSO + SCIM directory sync (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

Add **Okta** (SAML/OIDC) and **directory sync** so the Team wizard step can
"Sync your directory instead" — mirror Google Workspace / Entra / Okta into the
on-LAN directory, the same mirror the air-gap SSO path resolves against.

## Backend contract

- `POST /sso/directory/connect { provider, config }` → store an enabled connector.
- `POST /sso/directory/sync` → pull users/groups (SCIM 2.0 or provider directory
  API) into the local directory; idempotent, incremental.
- Roles map to the **3-tier safety contract** (`FEATURES.md §6`):
  owner/manager/member/viewer/guest → read/write/blocked policy.

## Data model (Prisma)

```prisma
model DirectoryConnector {
  id           String   @id @default(uuid())
  provider     String   // "google" | "entra" | "okta"
  mode         String   // "scim" | "pull"
  config       Json     // secret refs, not raw secrets
  enabled      Boolean  @default(false)
  lastSyncAt   DateTime?
  lastSyncState String  // explicit: "ok" | "failed" | "running"
}
```

## Architecture rules

- `lastSyncState` is an **explicit enum**, never derived from `lastSyncAt IS NULL`.
- Scheduler uses `cron-runtime.service.ts` / apscheduler — **no `while True`**.
- Mirror stays on the LAN; secrets via refs; least-privilege group→role mapping.
- Guests are scope-pinned + time-boxed (`FEATURES.md §3`).

## Dependencies

Built-in directory (ADR-012); shares mirror with `ONBOARDING_SSO_OIDC.md`;
role model with `ONBOARDING_TEAM_ROLES.md`.

## Acceptance criteria

- Connect + sync provisions users/groups; re-sync is incremental + idempotent.
- Okta SAML/OIDC login round-trips. Sync failure surfaces explicit state, retries.

## References

`FEATURES.md §3, §6, §8`; `services/cron-runtime.service.ts`; ADR-004, ADR-007.
