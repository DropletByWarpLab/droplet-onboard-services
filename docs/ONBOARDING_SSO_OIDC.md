# Onboarding — Google / Entra OIDC SSO

> **Status: IMPLEMENTED (PR #378).** Refs ADR-013. The directory-mirror /
> air-gap path and Okta remain follow-ups (see "Deferred" below).

## Purpose

External-IdP sign-in via OIDC for **Google Workspace** and **Microsoft
Entra**, surfaced by the Aurora login SSO buttons (`flags.ts`). Distinct from
the legacy "OAuth2" path (which is **Nextcloud's own** `/auth/authorize`) —
this is real third-party IdP federation, with the orchestrator acting as the
OIDC **relying party**.

## Backend contract (as shipped)

Mounted on the PUBLIC router (before `authMiddleware`), under `/api`:

- **`POST /api/sso/oidc/authorize`** — body `{ provider, returnTo? }` with
  `provider ∈ {google, entra}`. Mints a single-use `state` (CSRF) + `nonce`
  (ID-token replay) + PKCE `code_verifier`, persists them server-side
  (`SsoLoginState`, time-bound ~10 min), sets an httpOnly cookie carrying the
  opaque `state`, and **302-redirects** to the IdP authorize URL.
- **`GET /api/sso/oidc/callback`** — `?code&state`. Enforces CSRF (cookie
  `state` === query `state`), **atomically consumes** the server-side state
  (rejects unknown / replayed / expired), exchanges the code, **validates the
  ID token** (signature via JWKS, `iss`, `aud`, `exp`, `nonce`, `state`, PKCE
  — all delegated to `openid-client`), resolves/links the local `User` by
  normalized email, issues the SAME session cookies as `/auth/login`, and
  redirects to the same-origin `returnTo`.

### Endpoint-shape note (divergence from the original scaffold)

The scaffold sketched `GET /auth/sso/:provider/start` + `…/callback`. The
implemented contract follows the PR AC: `POST /sso/oidc/authorize` (provider
in the body) + `GET /sso/oidc/callback`. The behaviour (PKCE + state + nonce,
verify `iss`/`aud`/`exp`/signature) is unchanged; only the route shape and the
provider-passing mechanism differ.

## Account-linking policy

On a fully-validated callback, in order:

1. **Resolve by `(provider, sub)`** via `SsoIdentity` → sign in that user.
   The IdP `sub` is the stable identity key (emails can be reassigned at the
   IdP, `sub` cannot). Preserves the existing `User.id` (WARP-485).
2. **Else resolve the local `User` by NORMALIZED email** (#374 trim+lowercase
   — the same canonical form `/auth/login` uses):
   - **found → LINK**: create an `SsoIdentity` pointing at that user. An owner
     who set up with a password keeps the same row and can now also SSO in.
   - **none → CREATE**: mint a local `User` (role `family` / least privilege,
     `isLocal`, **no `passwordHash`** — SSO-only) and link.
3. **No usable email in the token → reject** (401). We never create a
   login-unable row.

## Data model (Prisma)

Per-provider **config lives in env** (`config.ts` `DROPLET_SSO_*`), NOT a DB
table — so there is deliberately **no `SsoConnection` model** (the scaffold
sketched one; the AC overrides it with "reuse existing config/env").

```prisma
model SsoIdentity {
  id        String   @id @default(uuid())
  userId    String   // FK → User.id (UUID preserved; ON DELETE CASCADE)
  provider  String   // "google" | "entra"
  subject   String   // IdP 'sub'
  email     String?  // normalized, audit-only
  @@unique([provider, subject])
}

model SsoLoginState {
  id           String    @id @default(uuid())
  state        String    @unique  // CSRF
  nonce        String              // ID-token replay
  codeVerifier String              // PKCE
  provider     String
  returnTo     String    @default("/")
  consumedAt   DateTime?           // single-use (UserInvite.acceptedAt idiom)
  expiresAt    DateTime            // time-bound
}
```

The migration is additive + idempotent (`CREATE TABLE/INDEX IF NOT EXISTS` +
a `pg_constraint`-guarded FK) — greenfield, same posture as the ADR-013
directory migration.

## Configuration (env, per provider)

`config.ts` `DROPLET_SSO_{GOOGLE,ENTRA}_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}`.
**All four** of a provider's vars must be set for that provider's button to go
live (`getOidcProviderConfig` fails closed otherwise). The login shows that
button **only** when the provider is fully configured: the page reads the live
set at runtime from `GET /api/sso/oidc/providers` (WARP-629,
[`ONBOARDING_SSO_RUNTIME_DISCOVERY.md`](ONBOARDING_SSO_RUNTIME_DISCOVERY.md)),
so an unconfigured provider is simply **not rendered** — there is no disabled
"Soon" pill and no button that could POST to an unconfigured provider. (A box
with no `DROPLET_SSO_*` env shows a password-only login.) Issuer is the
discovery base (`openid-client` derives every endpoint + the JWKS from it —
**no host is hardcoded in code**):

- Google: `https://accounts.google.com`
- Entra: `https://login.microsoftonline.com/<tenant>/v2.0`

**Secrets** (`*_CLIENT_SECRET`) are real provider secrets — they live ONLY in
`.env` (operator / setup.sh; never tracked), exactly like `OAUTH2_CLIENT_SECRET`.
They are read, never logged. The callback
never logs the code, tokens, or claims.

## Architecture rules

- PKCE + state + nonce; verify `iss`/`aud`/`exp`/signature (via JWKS).
- Secrets via env/secret-ref, **never** committed.
- New user defaults to least privilege (`family`); claim→role elevation is a
  separate concern (role-model ADR), out of scope here.
- Library: `openid-client@6` (ESM, the vetted OIDC RP lib). Wrapped behind
  `services/sso-oidc.service.ts` (the single boundary the route mocks).

## Dependencies

Built-in directory (ADR-013) for the `User` row + normalized-email login key.

## Deferred (follow-ups, NOT in this PR)

- **Okta** — ✅ SHIPPED in `feat/onb-sso-okta-scim` (PR #379): Okta added as a
  third OIDC provider reusing this exact RP path, plus a SCIM 2.0 server for
  directory provisioning. The Okta button shows on the login whenever the box
  has Okta's four `DROPLET_SSO_OKTA_*` vars set (surfaced by runtime discovery,
  WARP-629 — no build-time flag). See `ONBOARDING_DIRECTORY_SYNC.md`.
- **Air-gap / LAN-mirror** — resolving against an on-LAN directory mirror so
  sign-in works WAN-down (`ONBOARDING_DIRECTORY_SYNC.md`) is a separate PR.
  This PR resolves against the live IdP.
- **`email_verified` claim gate** — gating the email link/create branch on
  `email_verified === true` is planned with the Okta PR
  (`feat/onb-sso-okta-scim`), where unverified-email handling matters most.
  It is intentionally NOT added here: Google's ID token always carries
  `email_verified`, but Microsoft Entra frequently omits the claim, so a naive
  `=== true` gate would reject legitimate Entra sign-ins (a regression). Doing
  it correctly needs a per-provider policy (and a decision on whether an
  already-linked `(provider, sub)` re-auth is exempt), which is its own
  RED→GREEN cycle — out of scope for these two merge-blockers.

## References

`apps/orchestrator/src/routes/sso.ts`, `services/sso-oidc.service.ts`,
`services/sso-login-state.service.ts`, `routes/auth.ts` (the ADR-013 directory
login whose session-cookie issuance this mirrors); `FEATURES.md §3, §10`;
ADR-004; ADR-013.
