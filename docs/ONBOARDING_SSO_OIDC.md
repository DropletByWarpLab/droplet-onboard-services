# Onboarding — Google / Entra OIDC SSO (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

External-IdP sign-in via OIDC for **Google Workspace** and **Microsoft Entra**,
surfaced by the Aurora login SSO buttons (`flags.ts:sso`). Distinct from today's
"OAuth2" which is **Nextcloud's own** — this is real third-party IdP federation.

## Backend contract

- `GET /auth/sso/:provider/start` → redirect to the IdP (PKCE + state in a CSRF
  cookie; `provider ∈ {google, entra}`).
- `GET /auth/sso/:provider/callback` → exchange code, verify ID token, resolve/
  provision the local `User` by **email**, issue the cookie session.
- **Air-gap / LAN-first**: on a fresh appliance, resolve against the **on-LAN
  directory mirror** (see `ONBOARDING_DIRECTORY_SYNC.md`), not the public IdP, so
  sign-in works with WAN down.

## Data model (Prisma)

```prisma
model SsoConnection {
  id           String  @id @default(uuid())
  provider     String  // "google" | "entra"
  issuer       String
  clientId     String
  clientSecret String  // encrypted at rest / secret ref, never tracked
  enabled      Boolean @default(false)
}
model SsoIdentity {
  id        String @id @default(uuid())
  userId    String
  provider  String
  subject   String  // IdP 'sub'
  @@unique([provider, subject])
}
```

## Architecture rules

- PKCE + state + nonce; verify `iss`/`aud`/`exp`/signature.
- Secrets via env/secret-ref, **never** committed.
- Map IdP claims → role (see role-model ADR); default to least privilege.

## Dependencies

Built-in directory (ADR-012). Shares directory-mirror infra with the SCIM PR.

## Acceptance criteria

- Google + Entra round-trip provisions/links a user and signs in.
- LAN-mirror path works WAN-down. Flips `ONB_AUTH_FLAGS.sso` true (with Okta).

## References

`apps/orchestrator/src/routes/auth.ts` (`/auth/authorize`,`/auth/callback`
legacy NC OAuth2 to generalize); `FEATURES.md §3, §10`; ADR-004.
