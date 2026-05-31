# Onboarding — TOTP 2FA + recovery codes (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

RFC 6238 TOTP as the LAN-first second factor, **required for owners**, with
one-time recovery codes. Enrolled inline in the Account wizard step and
challengeable at login (the Aurora `TwoFactor` screen + `flags.ts:totp`).

## Backend contract

- `POST /auth/totp/enroll` → `{ otpauth_uri, secret }` (QR rendered client-side).
- `POST /auth/totp/verify { code }` → confirms enrollment / passes a login
  challenge; on success **populate `lastMfaAt`** (the WARP-230 stub already gates
  reseal routes via `middleware/require-recent-mfa.ts`).
- `POST /auth/recovery { code }` → consume a one-time recovery code.
- Owners without TOTP are blocked from sensitive actions until enrolled.

## Data model (Prisma)

```prisma
model TotpCredential {
  id          String   @id @default(uuid())
  userId      String   @unique
  secretEnc   String   // encrypted at rest
  confirmedAt DateTime?
}
model RecoveryCode {
  id        String   @id @default(uuid())
  userId    String
  codeHash  String   // hashed; show plaintext once at generation
  usedAt    DateTime?
}
```

## Architecture rules

- Encrypt the TOTP secret at rest; hash recovery codes; constant-time verify.
- Explicit `confirmedAt`/`usedAt` columns, never `IS NULL` inference.
- Enforce a verification window + replay protection (reject reused codes).

## Dependencies

Pairs with the built-in directory (ADR-012) and the Account wizard step.
Flips `ONB_AUTH_FLAGS.totp` true in the same PR.

## Acceptance criteria

- Enroll → confirm → login challenge passes; `lastMfaAt` set.
- Recovery code works once then is dead; codes shown exactly once.
- Owner enforcement gate covered by tests.

## References

`middleware/require-recent-mfa.ts`, `middleware/auth.ts` (`lastMfaAt`);
`onboarding-handoff/src/OnbAuth.jsx` (`TwoFactor`), `OnbWizard.jsx` (`WizAccount`);
`FEATURES.md §10`.
