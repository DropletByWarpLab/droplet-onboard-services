# ADR-012 — Built-in argon2id directory vs Nextcloud as credential store

> **Status: DRAFT / Proposed — no implementation in this PR.** Decision
> direction set by Stefan: **replace Nextcloud as the identity source of truth
> with a built-in directory.** This ADR records the migration. Refs WARP-___.

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
- **Migration**: every existing Nextcloud-keyed `User` needs a credential path.
  Options — (a) force password reset on first new-login, (b) one-time capture-on-
  login re-hash. Spell out before coding; this touches every existing user.
- Preserve WARP-485 local `User.id` UUID as the canonical key in JWTs/Redis.
- Map the role model here too (see `ONBOARDING_TEAM_ROLES.md` / ADR-007).

## Security

- argon2id only (no bcrypt); never log hashes; secrets stay out of tracked files.
- Keep the cookie-session model (`droplet_session` 15m + `droplet_refresh` 7d).

## Alternatives considered

- **Layer factors on Nextcloud** (keep it as the store) — lower risk, rejected per
  the chosen direction. Documented here for the record.

## References

`apps/orchestrator/src/routes/auth.ts`, `services/nextcloud.client.ts`,
`nextcloud-session.service.ts`, `prisma/schema.prisma` (`User`), `middleware/auth.ts`;
ADR-004 (RBAC), ADR-007 (dual-workspace); `FEATURES.md §3, §10`.
