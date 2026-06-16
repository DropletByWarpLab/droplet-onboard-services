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
 *
 * WARP-629: SSO is NOT gated here. Which IdP buttons the login shows is decided
 * at RUNTIME from what the appliance has actually configured — the login page
 * fetches GET /api/sso/oidc/providers (via `getEnabledSsoProviders`, lib/api.ts)
 * and renders only those. There is no per-provider build-time flag anymore (the
 * old `ONB_SSO_PROVIDERS_LIVE` constant is gone); a box with no `DROPLET_SSO_*`
 * env shows a password-only login. See docs/ONBOARDING_SSO_RUNTIME_DISCOVERY.md.
 */
export const ONB_AUTH_FLAGS = {
  // Kept for any consumer that only needs "is SSO available at all". The
  // actual per-provider visibility is runtime-discovered (WARP-629), so this
  // no longer gates the login buttons.
  sso: true,
  // Flipped by PR #377 — the WebAuthn backend (register + passwordless
  // authenticate) ships in this PR, so the passkey affordance goes live.
  passkey: true,
  totp: false,
  forgotPassword: false,
} as const;

export type OnbAuthFlag = keyof typeof ONB_AUTH_FLAGS;
