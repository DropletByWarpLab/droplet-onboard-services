# Onboarding — WebAuthn / passkeys (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

FIDO2/WebAuthn passkeys as a phishing-resistant sign-in, surfaced by the Aurora
login's "Use a security key or passkey" button (`flags.ts:passkey`).

## Backend contract

- `POST /auth/webauthn/register/options` · `/register/verify` — enroll a
  credential (platform or roaming authenticator).
- `POST /auth/webauthn/assert/options` · `/auth/webauthn/assert` — login
  assertion. On success, issue the normal cookie session and set `lastMfaAt`.
- Bind RP ID to the LAN host (`droplet.local`); support the air-gap path.

## Data model (Prisma)

```prisma
model WebauthnCredential {
  id            String   @id @default(uuid())
  userId        String
  credentialId  String   @unique   // base64url
  publicKey     Bytes
  signCount     Int      @default(0)
  transports    String?
  createdAt     DateTime @default(now())
  lastUsedAt    DateTime?
}
```

## Architecture rules

- Verify attestation + origin; enforce monotonic `signCount` (clone detection).
- Use a maintained library (e.g. `@simplewebauthn/server`); no hand-rolled crypto.
- RP ID / origin must work on the LAN with WAN down.

## Dependencies

Built-in directory (ADR-012) for the user record. Complements TOTP (either factor).

## Acceptance criteria

- Register + assert round-trip on a platform authenticator.
- `signCount` regression rejected; unknown credential rejected.
- Flips `ONB_AUTH_FLAGS.passkey` true.

## References

`onboarding-handoff/src/OnbAuth.jsx` (passkey button); `middleware/auth.ts`;
`FEATURES.md §10`.
