# Onboarding — Okta SSO + SCIM directory sync

> **Status: IMPLEMENTED (PR #379).** Refs ADR-013. Stacks on #378 (OIDC RP).

## Purpose

Add **Okta** sign-in and **directory sync** so an org's Okta directory drives
the box's local directory:

1. **Okta SSO** — Okta is a plain OIDC provider, so it reuses #378's
   relying-party path (`sso-oidc.service.ts`, `routes/sso.ts`, `SsoIdentity`,
   `SsoLoginState`). No new auth flow — one more env-var group.
2. **SCIM 2.0 server** — Okta **pushes** users/groups to the box at
   `/scim/v2/*` (the box is the SCIM *service provider*). This is the net-new
   surface in this PR.

### Divergence from the original scaffold

The scaffold sketched a **pull** connector (`POST /sso/directory/connect` +
`/sync`, a `DirectoryConnector` model with `lastSyncState`). The PR AC
overrides that with a **SCIM 2.0 push server** (Okta provisions TO us) +
Okta-as-OIDC-provider. So there is **no `DirectoryConnector` table** and no
poller — provisioning is request-driven by Okta, and the SCIM identity link
reuses the existing `SsoIdentity` table (provider `okta`). The role model is
the EXISTING `Role` enum (`owner|admin|family|guest|service`), not the
`owner/manager/member/viewer/guest` the scaffold guessed.

## Okta SSO (reuses #378)

`DROPLET_SSO_OKTA_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}` in `config.ts`.
All four set → the Okta button shows on the Aurora login; otherwise it is not
rendered at all (no dead button, no "Soon" pill). Which buttons appear is
decided at runtime from what the box has configured — the login reads
`GET /api/sso/oidc/providers` (WARP-629,
[`ONBOARDING_SSO_RUNTIME_DISCOVERY.md`](ONBOARDING_SSO_RUNTIME_DISCOVERY.md)),
not a build-time flag. Account-link by normalized email, preserving `User.id`
(identical policy to Google/Entra). Issuer-derived — no host hardcoded.

## SCIM 2.0 server (`/scim/v2/*`)

Mounted on the PUBLIC router (Okta has no human session) behind a DEDICATED
provisioning-bearer guard.

| Method + path | Behavior |
|---|---|
| `POST /scim/v2/Users` | Create. Idempotent — a retry of an existing user updates in place (200), `User.id` + identity link preserved. New rows: least-privilege `family`, `isLocal`, **no `passwordHash`** (SSO-only). |
| `GET /scim/v2/Users?filter=userName eq "…"` | The existence probe Okta runs before a create. Returns a SCIM `ListResponse`; a miss is `totalResults:0` (NOT 404, so Okta reconciliation doesn't wedge). |
| `GET /scim/v2/Users/:id` | One user, or 404. |
| `PUT /scim/v2/Users/:id` | Replace (displayName + active). |
| `PATCH /scim/v2/Users/:id` | Okta's (de)activation op — `active:false` → soft-DEACTIVATE, `active:true` → re-activate. |
| `DELETE /scim/v2/Users/:id` | De-provision = **soft-deactivate** (204), never a row delete. Idempotent. |
| `POST /scim/v2/Groups` | Upsert the group + apply its mapped role to listed members. |

### Auth — dedicated SCIM bearer

`DROPLET_SCIM_BEARER_TOKEN` (config/env). Validated **constant-time** on every
SCIM request by `middleware/scim-auth.ts`; **fail closed** when unset (every
`/scim/v2/*` 401s); **never logged**. This is a SEPARATE trust boundary from
the human session AND from the `SERVICE_TOKEN_*` `service`-role principals.

### Deactivation = soft

`User.directoryStatus` is an explicit `DirectoryUserStatus` enum
(`ACTIVE | DEACTIVATED`), never derived from a NULL/row-delete. SCIM
`active:false` / DELETE sets `DEACTIVATED`; the row + hash are retained for
audit + re-activate. Both `/auth/login` AND the SSO callback **fail closed**
for a `DEACTIVATED` user (wire-indistinguishable from unknown-email at login).

> **Deactivation runs the role-mutation rails (WARP-2016) — a SCIM push can
> now be REFUSED.** PUT, PATCH and DELETE all funnel through
> `scim.service.ts` (`setUserActive`/`deactivateUser`), which runs the same
> disable rails as `POST /auth/users/:username/disable` inside one
> `SERIALIZABLE` transaction, then the disable post-effects (session
> revocation + the mandatory `User disabled` audit row). Okta previously
> could deactivate the sole owner — or the last `ACTIVE` admin — and strand
> the box with zero operators able to sign in. Refusals render as the SCIM
> Error envelope with the rail's stable machine-readable code in `scimType`:
>
> | Refusal | HTTP | Meaning |
> |---|---|---|
> | `OWNER_IMMUTABLE` | 403 | The target is the owner; no directory push may touch the owner's row. |
> | `LAST_OPERATOR_INVARIANT` | 409 | The target is the last `ACTIVE` owner/admin; deactivating them would leave zero operators. Give someone else an admin role first. |
> | `CONCURRENT_MUTATION` | 409 | Lost a write race; nothing was applied — the retry converges. |
>
> Both refusal statuses are terminal for Okta (no retry wedge); they are
> logged at warn with the code. Re-deactivating an already-`DEACTIVATED` row
> stays an idempotent 2xx, and **re-activation is deliberately rail-free** —
> the sole deactivated admin must always be able to come back.
>
> Known residual: `POST /scim/v2/Users` (`provisionUser`) still writes
> `directoryStatus` on an existing row without the rails when a create
> payload carries `active:false` for an already-provisioned email. Tracked
> separately; the three update verbs above are the surface WARP-2016 seals.

### Role mapping

`scim-role-mapping.service.ts` maps a SCIM group display name → local `Role`
(explicit keyword policy, least-privilege `family` default; `service` is NEVER
assignable). `POST /scim/v2/Groups` RAISES each member's role to at least the
group's mapped role (highest-privilege-wins floor; no demotion). The gated
Team-membership UI is **NOT** built here (AC).

> **Ceiling: `admin` (WARP-1568).** `owner` is **not** an Okta-assignable
> role. A group whose name says "owner" is clamped to `SCIM_ROLE_CEILING`
> (`admin`) — there is exactly one owner by design, ownership is the box's
> root of trust, and transferring it is a dedicated flow, not a group name.
> Every SCIM role write also runs through `role-mutation-guard.service.ts`
> (the same rails as `/api/people/*` and `/api/auth/users*`: rank cap,
> assignable-enum, owner-immutability, last-owner / last-operator, inside one
> `SERIALIZABLE` transaction) and emits the same `Role changed` audit row,
> attributed to the SCIM principal (`actor.type = system`, `refs.actor =
> scim:okta`). A refusal is per-member: it is logged, that member's role is
> left unchanged, and the rest of the group still converges.

> **Documented simplification:** without a persisted SCIM membership table,
> removing a user from a group does not auto-lower their role — elevation is
> sticky until an explicit People-surface change. In scope per the AC.

## Data model (Prisma)

```prisma
enum DirectoryUserStatus { ACTIVE DEACTIVATED }

model User {
  // … existing fields …
  directoryStatus DirectoryUserStatus @default(ACTIVE) // soft-deactivation
}

model ScimGroup {            // Okta group → mapped local Role (idempotent)
  id          String  @id @default(uuid())
  externalId  String? @unique
  displayName String  @unique
  mappedRole  Role    @default(family)
}
// SCIM identity link REUSES SsoIdentity (provider="okta", subject=externalId|User.id).
// SCIM provisioning bearer + Okta OIDC config live in env, NOT the DB.
```

Migration `20260531140000_adr_013_scim_directory_sync` is additive + idempotent
(DO-guarded `CREATE TYPE`, `ADD COLUMN IF NOT EXISTS` whose DEFAULT backfills
existing rows, `CREATE TABLE/INDEX IF NOT EXISTS`). Same greenfield posture as
the ADR-013 directory + SSO migrations.

## Security

- SCIM bearer: dedicated secret, constant-time check, fail-closed, never
  logged, never tracked. SCIM users: normalized email, no password-loginable
  rows, least-privilege default role. Idempotent provisioning (Okta retries).
- No new `MATTER_*` env vars. Secrets stay out of tracked files.

## References

`apps/orchestrator/src/routes/scim.ts`, `services/scim.service.ts`,
`services/scim-resource.ts`, `services/scim-role-mapping.service.ts`,
`middleware/scim-auth.ts`; `routes/sso.ts` + `services/sso-oidc.service.ts`
(the OIDC RP path Okta reuses); `ONBOARDING_SSO_OIDC.md`; ADR-013;
`FEATURES.md §3, §6, §8`.
