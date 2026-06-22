import { type ReactNode } from "react";

/**
 * Single source of truth for the SSO/OIDC identity providers Droplet knows how
 * to render (WARP-629). BOTH surfaces that touch directory SSO import from here
 * so they can never drift:
 *   - the Aurora login (`SignInForm`) renders one live "Continue with …" button
 *     per discovered provider, in this catalog's canonical order; and
 *   - the onboarding Team step (`TeamStep`) reflects which directory is synced
 *     using the same provider set + friendly names.
 *
 * Previously each surface kept its own map and they diverged — the login page
 * recognised only `google`/`entra`/`okta`, while TeamStep also mapped the
 * `azuread`/`microsoft` aliases to Microsoft Entra. A box that reported
 * `azuread` would therefore render no login button at all. The alias coverage
 * now lives ONCE, in `SSO_PROVIDER_ALIASES` + `normalizeSsoProviderId`, applied
 * by both surfaces so they always agree.
 */

/* ── Brand glyphs (mock marks, not official logos) ───────────────── */
function GoogleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45 24c0-1.5-.1-2.9-.4-4.3H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1C42.7 36.5 45 30.8 45 24z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.5 46 24 46z" />
      <path fill="#FBBC05" d="M11.8 28.3c-.4-1.3-.7-2.7-.7-4.3s.2-2.9.7-4.3v-5.7H4.5C3 17.1 2 20.4 2 24s1 6.9 2.5 10l7.3-5.7z" />
      <path fill="#EA4335" d="M24 11.4c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.8 29.9 3 24 3 15.5 3 8.1 7.9 4.5 14l7.3 5.7c1.7-5.2 6.5-8.3 12.2-8.3z" />
    </svg>
  );
}
function MicrosoftGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#F25022" d="M0 0h11v11H0z" />
      <path fill="#7FBA00" d="M12 0h11v11H12z" />
      <path fill="#00A4EF" d="M0 12h11v11H0z" />
      <path fill="#FFB900" d="M12 12h11v11H12z" />
    </svg>
  );
}
function OktaGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="none" stroke="#007DC1" strokeWidth="5" />
    </svg>
  );
}

/** One catalog entry. `providerId` is the canonical wire value sent to
 *  /api/sso/oidc/authorize and MUST match the orchestrator's SsoProvider union.
 *  `name` is the human directory name (Team step); `loginLabel` is the login
 *  button label ("Continue with Microsoft" → the `entra` provider id). */
export interface SsoProvider {
  providerId: string;
  name: string;
  loginLabel: string;
  glyph: ReactNode;
}

/**
 * The CANONICAL catalog and render order. The login renders a subset of these —
 * exactly the providers runtime discovery reports as configured (WARP-629) — by
 * filtering this list, so order is always google → entra → okta regardless of
 * the discovery response order. Note "Continue with Microsoft" maps to the
 * `entra` provider id (Microsoft Entra is the IdP).
 */
export const SSO_PROVIDER_CATALOG: readonly SsoProvider[] = [
  { providerId: "google", name: "Google Workspace", loginLabel: "Continue with Google", glyph: <GoogleGlyph /> },
  { providerId: "entra", name: "Microsoft Entra", loginLabel: "Continue with Microsoft", glyph: <MicrosoftGlyph /> },
  { providerId: "okta", name: "Okta", loginLabel: "Continue with Okta", glyph: <OktaGlyph /> },
] as const;

/**
 * Alias map: alternate wire ids the orchestrator (or an admin's config) might
 * report for a canonical provider. Lives here ONCE so both the login page and
 * the Team step resolve them identically — e.g. a box reporting `azuread` or
 * `microsoft` renders the Entra button/label on BOTH surfaces.
 */
const SSO_PROVIDER_ALIASES: Record<string, string> = {
  azuread: "entra",
  microsoft: "entra",
};

/** Resolve any wire id (lower-cased, alias-folded) to a canonical provider id.
 *  Unknown ids pass through lower-cased so callers can still display a fallback
 *  and the login filter simply finds no catalog entry for them. */
export function normalizeSsoProviderId(id: string): string {
  const lower = id.toLowerCase();
  return SSO_PROVIDER_ALIASES[lower] ?? lower;
}

const CATALOG_BY_ID: Record<string, SsoProvider> = Object.fromEntries(
  SSO_PROVIDER_CATALOG.map((p) => [p.providerId, p]),
);

/** Look up a canonical catalog entry for a wire id (alias-aware). */
export function findSsoProvider(id: string): SsoProvider | undefined {
  return CATALOG_BY_ID[normalizeSsoProviderId(id)];
}

/** Friendly directory name for a wire id (alias-aware). Unknown ids fall back
 *  to a capitalized id so the Team step never renders an empty label. */
export function ssoProviderName(id: string): string {
  const known = findSsoProvider(id);
  if (known) return known.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
