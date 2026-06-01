# ADR-013 — Built-in argon2id directory vs Nextcloud as credential store

> **Status: Accepted.** Decision set by Stefan: **replace Nextcloud as the
> identity source of truth with a built-in argon2id directory.** Implemented in
> PR #374 (branch `feat/onb-directory-argon2id`): `User.passwordHash` (argon2id)
> + email-as-login-key, local-verify `POST /auth/login`, Nextcloud demoted to a
> downstream-provisioned WebDAV account. **Migration is greenfield — no backfill**
> (see "Consequences / migration" below).

## Context

Today identity is **hard-coupled to Nextcloud**: `POST /api/auth/login`
validates credentials against Nextcloud OCS, users are keyed by
`nextcloudUsername`, "OAuth2" is Nextcloud's own, group membership maps to roles,
and Files/WebDAV depend on the per-user Nextcloud app-password
(`nextcloud-session.service.ts`). There is **no local password store**.

The onboarding handoff assumes a **built-in directory** (argon2id), email as the
stable key, and external IdP SSO — a different identity model.

## Decision

Make a **built-in argon2id directory the source of truth**. Nextcloud becomes a
**downstream provisioned account** (so Files/WebDAV keep working) rather than the
authenticator.

## Consequences / migration (the hard part)

- Add `User.passwordHash` (argon2id, tuned params) + email-as-key. Email becomes
  the login identifier (the Aurora login already labels the field "Work email").
- `POST /auth/login` validates locally; on success, ensure/refresh the downstream
  Nextcloud session for WebDAV (provisioning, not authentication).
- **Migration — GREENFIELD, no backfill (decided by Stefan).** There is NO
  migration path for existing Nextcloud-keyed users. The single live box is
  wiped + reflashed (nothing on it is important) and new appliances onboard
  fresh, so there are no legacy credentials to carry over. The built-in
  directory is THE source of truth from first boot: `/auth/setup` and
  invite-accept write the argon2id `passwordHash` directly, and everything
  authenticates against it. No capture-on-login, no force-reset machinery, no
  one-time re-hash. The Prisma migration is therefore additive-only
  (`ADD COLUMN IF NOT EXISTS "passwordHash"` + a unique index on `email`) with
  zero `UPDATE` of existing rows. The box wipe/reflash is a separate
  human-gated deploy action, not part of this PR.
- Preserve WARP-485 local `User.id` UUID as the canonical key in JWTs/Redis.
- Map the role model here too (see `ONBOARDING_TEAM_ROLES.md` / ADR-007).

## Security

- **argon2id only** (no bcrypt). Implemented via the `argon2` npm package
  (a native binding over the reference Argon2 C implementation, the PHC winner
  and OWASP's first choice). Tuned at the OWASP Password Storage floor for
  argon2id — `m=19456` KiB (19 MiB), `t=2`, `p=1` — introspectable as
  `PASSWORD_HASH_PARAMS` in `src/services/password.service.ts`. The params
  travel inside the PHC string, so the floor can be raised later and old rows
  keep verifying. Verification uses the library's constant-time comparison; a
  malformed/foreign stored hash reads as auth-failure, never a 500.
- **Anti-enumeration.** `POST /auth/login` returns an identical 401 + body for
  unknown-email, no-password-set, and wrong-password, and spends a comparable
  argon2id verify on the miss branches (`verifyDummyPassword`) so timing can't
  distinguish registered emails.
- Never log hashes or passwords; secrets stay out of tracked files.
- Keep the cookie-session model (`droplet_session` 15m + `droplet_refresh` 7d).

## Alternatives considered

- **Layer factors on Nextcloud** (keep it as the store) — lower risk, rejected per
  the chosen direction. Documented here for the record.
- **Migrate existing Nextcloud-keyed users** via force-reset-on-first-login or
  capture-on-login re-hash — rejected. The single live box carries nothing worth
  preserving, so a wipe + reflash is cheaper and avoids shipping migration
  machinery that would exist only to be deleted. See "Consequences / migration".

## References

`apps/orchestrator/src/routes/auth.ts`, `services/nextcloud.client.ts`,
`nextcloud-session.service.ts`, `prisma/schema.prisma` (`User`), `middleware/auth.ts`;
ADR-004 (RBAC), ADR-007 (dual-workspace); `FEATURES.md §3, §10`.
