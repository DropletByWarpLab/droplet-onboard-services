# Onboarding — Team invites + role model (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

Back the **Team** wizard step: invite teammates by email + role (extending the
existing invite flow) and reconcile the **role model** the whole product uses.

## Role-model decision (must settle first)

- Shipped: **household** `owner / admin / family / guest` (`middleware/auth.ts`).
- Handoff / dashboard CSS: **business** `owner / manager / member / viewer / guest`.
- The dashboard already defines `--role-*` tokens for **both**; ADR-007 frames a
  **dual-workspace** product. Decide: one model, or workspace-typed mapping.
  Roles map to the 3-tier safety contract (`FEATURES.md §6`).

## Backend contract

- `POST /people/invite { email, role }` — extends existing `/api/auth/invites`
  (already supports create/list/revoke/accept). Email requires the Off-LAN
  "Outbound email" channel (ON by default, `FEATURES.md §8`).
- Directory sync alternative handled in `ONBOARDING_DIRECTORY_SYNC.md`.

## Data model

Reuse `UserInvite` (token, email, role, expiresAt, acceptedAt, revokedAt). Add
roles to the `Role` enum per the decision above; migrate existing rows.

## Architecture rules

- Role changes are audited (HMAC-signed rows, `FEATURES.md §10`).
- Guests scope-pinned + time-boxed (`GuestExpiry` already exists in schema).
- No silent role widening; least privilege by default.

## Dependencies

Built-in directory (ADR-012); role tokens already shipped; SSO/SCIM for bulk.

## Acceptance criteria

- Invite + accept round-trip; role enforced by `requireRole`.
- Role enum migration is clean; safety-tier mapping covered by tests.

## References

`apps/orchestrator/src/routes/auth.ts` (`/auth/invites*`), `middleware/auth.ts`,
`prisma/schema.prisma` (`UserInvite`,`GuestExpiry`); ADR-004, ADR-007; `FEATURES.md §3,§6`.
