# Onboarding — first-run state machine (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Spec for a future
> session. Part of the Aurora login + onboarding initiative. Refs WARP-___.

## Purpose

Make first-run **resumable and explicit**. Today setup is stateless — derived
from Nextcloud's `installed` flag (`GET /api/auth/setup`) — so a refresh mid-
wizard loses place and there's no `unclaimed → ready` model. Replace with an
explicit server-side state.

## State

```
UNCLAIMED ──claim──▶ CLAIMING ──ok──▶ SETUP(step) ──finish──▶ READY
  any sign-in ▶ AUTHENTICATING ▶ (MFA?) ▶ session
  first sign-in, tour_completed=false ▶ TOUR ▶ dashboard
```

## Backend contract

- `GET /setup/state` → `{ appliance: "unclaimed"|"ready", setup_step, user_tour_completed }`.
- The web app routes: unclaimed → wizard@step; ready + tour pending → tour; else dashboard.
- `AuthGate` (`apps/web-dashboard/src/components/AuthGate.tsx`) consumes this instead of the boolean `setupRequired`.

## Data model (Prisma)

```prisma
enum SetupStep { welcome claim account org internet storage discovery cameras vpn ai team done }
model ApplianceSetup {
  id         String    @id @default(uuid())
  state      String    // "unclaimed" | "ready"  (explicit, never derived)
  setupStep  SetupStep @default(welcome)
  updatedAt  DateTime  @updatedAt
}
```

## Architecture rules (must hold)

- **State is an explicit column, never derived from absence** (no `IS NULL`)
  — canonical WARP-218 `BrainMemoryItemStatus` precedent.
- Persist on the encrypted NVMe (`FEATURES.md §10`).
- No `while True`; no new `MATTER_*` env vars.

## Dependencies

Unblocks every other onboarding workstream (claim, org, team route off this).

## Acceptance criteria

- Refresh mid-wizard returns to the same `setup_step`.
- `AuthGate` routes off `/setup/state`; existing setup tests updated.
- Migration + unit tests for the state transitions.

## References

`FEATURES.md §10`; `apps/orchestrator/src/routes/auth.ts` (`/auth/setup`);
`apps/web-dashboard/src/lib/auth.tsx`, `components/AuthGate.tsx`.
