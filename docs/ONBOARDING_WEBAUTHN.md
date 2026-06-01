# Onboarding — WebAuthn / passkeys

> Implemented in PR #377, stacked on the built-in argon2id directory (ADR-013).

## Purpose

FIDO2/WebAuthn passkeys as a phishing-resistant, **passwordless** sign-in
alongside the ADR-013 argon2id login. Surfaced by a "Sign in with a passkey"
action on the login page and an opt-in "Add a passkey" section in Settings.

## Backend contract

All routes are under the `/api` mount (the orchestrator registers them as
`/auth/webauthn/...`):

- `POST /api/auth/webauthn/register/options` · `/register/verify` — enrol a
  credential for the **signed-in** user (platform or roaming authenticator).
  Protected routes (mounted after `authMiddleware`).
- `POST /api/auth/webauthn/authenticate/options` · `/authenticate/verify` —
  passwordless login assertion. On success, issue the normal cookie session
  (access + refresh), byte-identical to `POST /auth/login`. Public routes
  (mounted before `authMiddleware`).
- rpID / origin are derived from the request (`webauthn-config.ts`), reusing
  the `getRedirectUri` / `buildInviteUrl` posture — no hardcoded host, no new
  env var. Works on the LAN with the WAN down.

> **Naming note:** the original scaffold sketched the login endpoints as
> `/assert/options` + `/assert`. The shipped routes use `/authenticate/options`
> + `/authenticate/verify` to mirror the register pair and the ticket AC.

> **Passwordless vs. 2nd-factor (flagged):** implemented as a passwordless
> *primary* credential — a successful assertion alone issues the session.
> Passkeys are an alternative to the password, not a mandatory second factor.
> WebAuthn with user-verification is itself multi-factor (authenticator +
> PIN/biometric). Stamping `lastMfaAt` for step-up flows is owned by WARP-238
> (JWT-claim plumbing) and is intentionally NOT expanded here.

## Data model (Prisma)

```prisma
model WebAuthnCredential {
  id           String   @id @default(uuid())
  userId       String                       // FK -> User.id (cascade)
  credentialId String   @unique             // base64url
  publicKey    Bytes                         // COSE public key
  counter      Int      @default(0)          // monotonic; clone detection
  transports   String?                       // CSV
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime?
}

model WebAuthnChallenge {
  id        String                @id @default(uuid())
  challenge String                @unique     // base64url, handed to the browser
  type      WebAuthnChallengeType             // REGISTRATION | AUTHENTICATION
  userId    String?                            // set for register, null for authenticate
  expiresAt DateTime                           // time-bound
  createdAt DateTime              @default(now())
}
```

## Architecture rules

- Verify attestation + origin + rpID; enforce monotonic `counter` (clone
  detection — a regression is rejected and the stored counter is not advanced).
- Challenges are server-side, single-use (consume-by-delete) and time-bound
  (`expiresAt`); a register challenge can never satisfy an authenticate verify.
- Use a maintained library — `@simplewebauthn/server@13.3.1` (orchestrator) and
  `@simplewebauthn/browser@13.3.0` (dashboard); no hand-rolled crypto.
- RP ID / origin must work on the LAN with WAN down (derived from the request).
- Never log public keys, credential ids, or challenges.

## Dependencies

Built-in directory (ADR-013) for the user record. Complements TOTP — either
factor can authenticate.

## Acceptance criteria

- Register + assert round-trip on a platform authenticator.
- `counter` regression rejected; unknown credential rejected.

## Scope / follow-ups

- This PR ships register + passwordless sign-in. Listing and revoking enrolled
  passkeys (a credential-management surface) is a follow-up — it needs GET +
  DELETE credential endpoints not built here.
- `lastMfaAt` stamping on a passkey assertion is deferred to WARP-238.

## References

`apps/orchestrator/src/routes/auth.ts` (argon2id login); `middleware/auth.ts`;
`apps/web-dashboard/src/app/login/page.tsx`;
`apps/web-dashboard/src/components/settings/PasskeysSection.tsx`.
