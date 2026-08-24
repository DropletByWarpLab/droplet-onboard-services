# Email-as-identity auth consistency + surfaced credential rules

- **Date:** 2026-06-01
- **Status:** Approved (pending spec review)
- **Tracking:** [WARP-635](https://warp-lab.atlassian.net/browse/WARP-635) — email-identity auth consistency
- **Related:** ADR-013 (directory auth, email is login key), PR #370/#374 (Aurora login,
  email-required setup), PR #384 (Aurora setup wizard re-skin)

## Problem

ADR-013 migrated authentication to **email-as-identity** (the orchestrator resolves
login by `User.email`, Nextcloud demoted to downstream WebDAV). The **sign-in** UI was
updated for this (`SignInForm.tsx` collects a "Work email"). The **account-creation**
surfaces were not. The result is a broken, inconsistent flow:

1. **Setup is hard-broken from the UI.** `AccountStep.tsx` collects *username + display
   name + password* and `setupAdmin()` POSTs exactly those — **no `email`**. But
   `setupSchema` (`apps/orchestrator/src/routes/auth.ts`) makes `email` **required**. Every
   submit 400s before Nextcloud is ever contacted. (Confirmed on the live appliance:
   `POST /api/auth/setup` → 400 × 21, with zero 5xx — i.e. Zod rejection, not a Nextcloud
   error.)
2. **Login identity is name-mismatched.** `loginUser(username, password)` sends a
   `username` field; the login route resolves only by `email`, treating the field's *value*
   as the email. Works only if the user types an email into a box labeled otherwise.
3. **Username is vestigial.** Collected at setup, stored, but never the login key.
4. **No rules are surfaced.** Email rules: none shown. Password rules: only a static
   "Must be at least 8 characters"; the real bound (8–128) is never fully stated.

## Goals

- Make **setup and sign-in consistent**: one identity field (Work email), identical
  validation and presentation.
- **Drop username from every UI.** Derive a Nextcloud-safe userid server-side from email.
- **Surface credential rules** with a live inline checklist on every password-creation
  surface, and clear email validation.
- **Strengthen the password policy** to length 12–128 + at least 3 of 4 character classes.
- **Propagate consistently** across all account-credential surfaces (no drift), backed by a
  single shared policy module.
- **Verify end-to-end** that setup works from a clean state.

## Non-goals

- Changing the login *resolution* logic (already email-based — correct).
- Re-hashing or invalidating existing passwords. The new policy gates only **new or
  changed** passwords; existing accounts keep signing in.
- SSO / passkey / forgot-password flows (separate, flagged features).
- Adding a breached-password / HaveIBeenPwned check (rejected: outbound call doesn't fit an
  offline/air-gapped appliance).

## Target identity model

- **Email is the sole user-facing identifier** on setup, sign-in, invite-accept, and admin
  add-user. Sign-in (`SignInForm.tsx`) is the reference implementation; creation surfaces
  are aligned to it.
- `User.username` (`NOT NULL @unique`) and `User.nextcloudUsername` (`@unique`, nullable)
  are **server-derived and never shown**.
- **Consistency contract (explicit):** setup and sign-in use an identical identifier field —
  label "Work email", `Mail` icon, `type=email`, same email-format validation. Setup
  additionally renders the password-creation checklist; sign-in does not (authenticating is
  not creating). The identifier field is the same component on both.

## Username derivation — `deriveUserId(email, isTaken)`

Pure, deterministic-with-collision-fallback function in the shared policy module.

1. Take the email local-part (before `@`), lowercase.
2. Keep only `[a-z0-9._-]`; drop `@`, `+`, and any other character; collapse consecutive
   separators.
3. Enforce length: min 2 (if shorter or empty after stripping, fall back to `user`), max 64.
4. If the candidate is reserved (`admin`, `root`), treat as taken.
5. Collision handling: if `isTaken(candidate)` (checked against **both** `username` and
   `nextcloudUsername` uniqueness), append `-2`, `-3`, … until free.
6. The same final value is written to `username` and `nextcloudUsername`.

The conservative charset is a strict subset of what Nextcloud's OCS provisioning API
accepts, so a derived id can never be rejected downstream — this permanently closes the
orchestrator↔Nextcloud charset-mismatch risk.

## Password policy — single source of truth

Rules (rule ids drive both checklist rendering and failure reporting):

- `length`: 12 ≤ len ≤ 128
- `classes`: at least 3 of 4 of {lowercase, uppercase, digit, symbol}

The shared module exports:

- `PASSWORD_RULES`: ordered list of `{ id, label, test(pw): boolean }` for UI rendering.
- `validatePassword(pw): { ok: boolean; failed: RuleId[] }`.
- `passwordZod`: a Zod schema/refinement built from the same rules (used by every backend
  schema). On failure the route maps to error code `WEAK_PASSWORD`.

(Confirm-password "match" is a UI-only checklist item; it is not a backend rule.)

## Architecture — Approach A (shared workspace package)

New tiny workspace package **`@droplet/auth-policy`** (TypeScript), consumed by both the
orchestrator and the web-dashboard:

- Exports: `PASSWORD_RULES`, `validatePassword`, `passwordZod`, `deriveUserId`,
  `normalizeEmail` (trim + lowercase), and shared constants (`RESERVED_USERNAMES`,
  length bounds).
- Web-dashboard consumes it via Next `transpilePackages` (mirrors how `@droplet/tools-core`
  is shared with the orchestrator/mcp-server). Fallback if Next import proves fussy:
  Approach B — keep the policy canonical in the orchestrator and re-declare the rule list in
  the dashboard with a contract test asserting the two match. (Behavior-identical; decided
  at plan time only if A hits a wall.)

This makes the checklist, the Zod schema, and the error copy share one definition — the
drift that caused this bug becomes unrepresentable.

## Surface-by-surface changes

### Backend — `apps/orchestrator/src/routes/auth.ts` + `@droplet/auth-policy`

- `setupSchema`: remove `username`; `email` required (normalized), `password` → `passwordZod`,
  `displayName` optional. Derive userid (`deriveUserId`) before the `prisma.user.upsert` and
  write it to `username` + `nextcloudUsername`.
- `createUserSchema` (admin add-user): `email` required, derive userid.
- `createInviteSchema`: `email` **required** (was optional); remove admin-chosen `username`
  (derive at accept time from the invite email). `acceptInviteSchema`: `password` →
  `passwordZod`.
- Replace generic `{ error: "Invalid request", details }` 400s on these routes with **typed
  codes**: `WEAK_PASSWORD` and `INVALID_EMAIL` (message + `code`), so the dashboard's
  `friendly-errors` can translate them. Preserve existing `OWNER_EXISTS` (409) and
  `NextcloudUserExistsError` (409) behavior.
- Login route: accept `email` as the canonical field; continue tolerating a legacy
  `username` field carrying the same value for one release window. Resolution logic
  unchanged (already email-keyed).

### Frontend — `apps/web-dashboard`

- `src/lib/api.ts`: `setupAdmin(email, password, displayName?)`, `loginUser(email, password)`,
  `createUser(email, password, displayName?)` send `{ email, ... }`.
- New shared component `src/components/auth/PasswordRulesChecklist.tsx`: renders
  `PASSWORD_RULES` and ticks each green live as `validatePassword` passes it, plus a
  "passwords match" row. Reused by all creation surfaces.
- `src/components/setup/steps/AccountStep.tsx`: replace the username field with a "Work
  email" field (mirror `SignInForm` label/icon/`type=email`), add the checklist, delete the
  username state + validation. CTA disabled until email valid + all password rules pass +
  confirm matches.
- `src/app/invite/[token]/page.tsx`: add the checklist + new policy; show the invite's email
  read-only for context.
- `src/app/settings/page.tsx` (password change) and `src/app/users/page.tsx` (add user) plus
  the setup `TeamStep.tsx` invite form: apply the checklist/policy; creation/invite forms
  collect **email**, not username.
- `src/lib/friendly-errors.ts`: add `WEAK_PASSWORD` and `INVALID_EMAIL` copy to the `auth`
  and `invite` domains.

## Error handling

- **Client:** live checklist; submit CTA gated until email valid + password rules satisfied +
  confirm matches. Server errors translated via `friendly-errors` (never raw `err.message`).
- **Server:** authoritative re-validation via `passwordZod` + email normalization; typed 400
  codes (`WEAK_PASSWORD`, `INVALID_EMAIL`). Username-derivation collisions resolved silently
  by suffixing — never surfaced to the user.

## Testing strategy

- **Unit (`@droplet/auth-policy`):** `validatePassword` boundaries (11 vs 12; each 3-of-4
  class combination; 128 vs 129); `deriveUserId` (slug, collision suffixing, reserved-name
  handling, charset stripping, unicode/`+` email, empty local-part fallback);
  `normalizeEmail`.
- **Backend route tests:** setup happy path → 200, creates an `owner` row with a unique
  derived `username`/`nextcloudUsername`, calls Nextcloud create with the derived id; weak
  password → 400 `WEAK_PASSWORD`; missing/invalid email → 400 `INVALID_EMAIL`; second setup →
  409 `OWNER_EXISTS`; login by email → 200; invite create requires email; invite accept
  enforces the policy.
- **Frontend component tests:** AccountStep renders the email field + checklist, ticks and
  CTA-gating update with input, `setupAdmin` called with the email. **Update existing tests**
  that assert old username copy/placeholders: `setup.flow`, `login.aurora`, `users.invite`,
  `setup.e2e`, and any asserting `your-username` / `Min. 8 characters`.
- **E2E:** repo suites (`npm run test:orchestrator`, dashboard tests incl.
  `setup.e2e.test.tsx`). A **live** full-wizard pass on `192.168.1.87` requires
  `./scripts/factory-reset.sh` first (the appliance already has an owner, so setup now 409s);
  destructive, run only with explicit approval.

## Migration / rollout notes

- No data migration. Existing rows keep their `username`/`email`; policy gates only new or
  changed passwords.
- The 21 failed setups left no rows (400 before any write). The live appliance already has an
  owner row, so setup correctly 409s there going forward.
- `User.username` is `NOT NULL` — `deriveUserId` must always return a non-empty value (the
  `user` fallback guarantees this).
- **Operational flag for Romain:** the habitual test password `TestPass11!` is 11 chars and
  fails the new min-12 rule; use e.g. `TestPass123!` (12 chars, 4 classes) for new accounts.
  The seeded admin default in personal prefs should be bumped to match.

## Open questions

None at design time. Approach A confirmed; fall back to B only if the Next workspace import
is impractical (decided during implementation, behavior-identical either way).
