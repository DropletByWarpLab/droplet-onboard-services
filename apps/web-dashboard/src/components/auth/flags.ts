/**
 * Onboarding auth-method flags.
 *
 * The Aurora sign-in surfaces every method the design calls for — SSO,
 * passkeys, TOTP, password reset — but only username/password is wired to a
 * live backend today (`POST /api/auth/login`). Each remaining method is
 * delivered by its own follow-up PR; until that lands the affordance renders
 * **disabled with a "Soon" hint** and fires no network call (no dead buttons
 * that 404).
 *
 * Flip a flag to `true` in the same PR that ships its backend:
 *   - sso            → docs/ONBOARDING_SSO_OIDC.md / ONBOARDING_DIRECTORY_SYNC.md
 *   - passkey        → docs/ONBOARDING_WEBAUTHN.md
 *   - totp           → docs/ONBOARDING_TOTP.md
 *   - forgotPassword → docs/ADR-012-builtin-directory-vs-nextcloud.md
 *
 * This is a build-time constant, not runtime config — the dashboard has no
 * env-flag mechanism and these gate UI affordances, not security decisions.
 */
export const ONB_AUTH_FLAGS = {
  sso: false,
  passkey: false,
  totp: false,
  forgotPassword: false,
} as const;

export type OnbAuthFlag = keyof typeof ONB_AUTH_FLAGS;
