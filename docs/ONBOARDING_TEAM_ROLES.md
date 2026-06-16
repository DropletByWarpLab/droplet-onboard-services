# Onboarding — Team invites + role model

> **Status: IMPLEMENTED (PR #381).** The LAST onboarding step. Refs WARP onb team.

## Purpose

Back the **Team** wizard step: invite teammates by email + role (extending the
existing invite flow) and reconcile the **role model** the whole product uses.

## Role-model decision (RESOLVED → household)

The scaffold flagged an OPEN fork:

- Shipped: **household** `owner / admin / family / guest` (+ `service`)
  (`Role` enum in `prisma/schema.prisma`, `middleware/auth.ts`).
- Handoff / dashboard CSS: **business** `owner / manager / member / viewer / guest`.

**Decision: household.** It is the live contract, not a candidate:

- the Prisma `Role` enum is `owner / admin / family / guest / service`;
- `UserInvite.role : Role` already persists it;
- the existing `POST /api/auth/invites` route already validates against exactly
  `["owner","admin","family","guest"]` (auth.ts `inviteRoleField`);
- the appliance is **home-first** (ADR-002).

So PR #381 re-uses the shipped enum rather than inventing a parallel vocabulary.
`service` is excluded from invites (a service principal is env-var-minted,
`SERVICE_TOKEN_*`, never invited). Switching to the business model later is a
`Role`-enum migration + a separate ticket, NOT a silent widening.

**Known token gap (flagged for UI/UX):** `globals.css` defines `--role-*` color
tokens for `owner / admin / manager / member / viewer / guest` — there is **no
`--role-family`**. The TeamStep role chip therefore uses the neutral
`dp-status-chip` treatment (role-agnostic) rather than borrow a business token
or hardcode a hex. A `--role-family` token (or an explicit household role-token
set) would let the chip carry a per-role color.

## Backend contract

- `POST /api/people/invite { email, role }` — owner+admin (same guard as the
  rest of `/api/people`). Normalizes the email to lowercase (#374 login-key
  contract), validates the role against the household model, derives a
  NOT-NULL `username` from the email local-part, creates the `UserInvite` row
  reusing the WARP-217 token generator, and emits an `auth` audit row
  (who invited whom — never the token). Service:
  `src/services/onboarding-team-invite.service.ts`.
- Directory sync (SSO) is surfaced in the UI as the bulk alternative; the
  actual OIDC/SCIM wiring is a separate workstream.

## #386 dependency (merge order)

Invite **accept** writes an argon2id `passwordHash` so an invited member can
sign in on the email-keyed login (ADR-012). That is **#386, a separate PR on
`main`** — NOT re-implemented here. PR #381 only CREATES the invite (the same
`UserInvite` row #386's accept path consumes), so the two are compatible.
**Merge order:** an invited member cannot complete sign-in until #386 lands;
#381 can merge first (invites are created + audited; accept-time hashing is
#386's job).

## Data model

Reuses `UserInvite` (token, username, email, role, expiresAt, acceptedAt,
revokedAt). No `Role`-enum migration needed — the household model already ships.
The only schema change is the additive `SetupStep` value `team`
(`20260601020000_warp_onb_team_step`, ordered after #380's org migration).

## Frontend

`TeamStep` (`apps/web-dashboard/src/components/setup/steps/TeamStep.tsx`), woven
into the wizard after `ai` (… → ai → team → done). Team **IS skippable**
("I'll invite people later"). Invite by email + role, inline error on a bad
email, pending-invitee list, directory-sync (SSO) note. All design tokens, no
hardcoded hex.

## Architecture rules

- Role changes are audited (HMAC-signed rows, `FEATURES.md §10`).
- Guests scope-pinned + time-boxed (`GuestExpiry` already exists in schema).
- No silent role widening; least privilege by default.

## Acceptance criteria (met)

- Invite create round-trip; role validated against the household model.
- Invalid email / invalid role rejected inline (no write).
- `SetupStep` enum migration is clean + idempotent; the `team` step is woven
  into `SETUP_STEPS` + the dashboard `STEPS` + `setup/page.tsx`, and is
  skippable.
- TDD: failing tests first across service / route / component / wiring.

## References

`apps/orchestrator/src/routes/people.ts` (`POST /people/invite`),
`src/services/onboarding-team-invite.service.ts`, `src/routes/auth.ts`
(`/auth/invites*`), `middleware/auth.ts`, `prisma/schema.prisma`
(`UserInvite`, `Role`, `SetupStep`, `GuestExpiry`); ADR-002, ADR-007, ADR-012;
`FEATURES.md §3,§6,§8,§10`; #371 handoff §4.
