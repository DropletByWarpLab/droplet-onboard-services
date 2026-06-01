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
 * ADR-013: SSO is wired PER PROVIDER, not as one boolean. The orchestrator's
 * /api/sso/oidc/authorize endpoint shipped Google + Entra in PR #378 and Okta
 * in PR #379 (this branch — Okta is plain OIDC, reusing the same RP path).
 * `ssoProviders` below marks which providers are LIVE so a provider whose
 * backend hasn't shipped keeps rendering the disabled "Soon" pill (no dead
 * button). The legacy `sso` boolean is kept (true once any provider is live)
 * for any consumer that only needs "is SSO available at all".
 */
export const ONB_AUTH_FLAGS = {
  // ADR-013 (PR #378): SSO is live — see ONB_SSO_PROVIDERS_LIVE for which
  // providers have shipped a backend (Google + Entra).
  sso: true,
  // Flipped by PR #377 — the WebAuthn backend (register + passwordless
  // authenticate) ships in this PR, so the passkey affordance goes live.
  passkey: true,
  totp: false,
  forgotPassword: false,
} as const;

export type OnbAuthFlag = keyof typeof ONB_AUTH_FLAGS;

/**
 * Which SSO providers have a live backend on /api/sso/oidc/authorize. The
 * key is the dashboard's wire id (the value sent as the `provider` form
 * field, which must match the orchestrator's SsoProvider union). Flip a
 * provider to `true` in the same PR that ships its backend.
 */
export const ONB_SSO_PROVIDERS_LIVE = {
  google: true,
  entra: true,
  okta: true,
} as const;

export type OnbSsoProviderId = keyof typeof ONB_SSO_PROVIDERS_LIVE;
