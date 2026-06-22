import { type ReactNode } from "react";
import { Lock, Mail, Eye, EyeOff, KeyRound, ArrowRight } from "lucide-react";
import { ONB_AUTH_FLAGS } from "./flags";
import {
  SSO_PROVIDER_CATALOG,
  normalizeSsoProviderId,
} from "@/lib/sso-providers";

/** A method whose backend hasn't shipped yet: visible, disabled, no-op. */
function ComingSoon({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title="Coming soon"
      className={`dp-btn-secondary w-full justify-center gap-2.5 !bg-surface-secondary !text-label-secondary border border-separator opacity-60 cursor-not-allowed ${className}`}
    >
      {children}
      <span className="ml-1 type-caption-2 font-semibold uppercase tracking-wide text-label-tertiary">
        Soon
      </span>
    </button>
  );
}

/**
 * A LIVE SSO provider. Rendered as a full-page form POST because the
 * response is a 302 to a cross-origin IdP (Google / Microsoft) — a `fetch`
 * can't follow that, so we let the browser navigate. The orchestrator mints
 * + persists the single-use state/nonce server-side; we only send the
 * provider (and an optional same-origin returnTo).
 *
 * Visual parity with the disabled pill (same surface-secondary tint,
 * separator border, full width) so the live and not-yet-live providers read
 * as one set — but enabled, with a restrained hover/active affordance from
 * the dp-btn-secondary token plus a subtle border-emphasis on hover.
 */
function SsoProviderButton({
  providerId,
  label,
  glyph,
  returnTo,
}: {
  providerId: string;
  label: string;
  glyph: ReactNode;
  returnTo?: string;
}) {
  return (
    <form action="/api/sso/oidc/authorize" method="POST" className="contents">
      <input type="hidden" name="provider" value={providerId} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <button
        type="submit"
        className="dp-btn-secondary w-full justify-center gap-2.5 !bg-surface-secondary !text-label-primary border border-separator hover:!bg-fill-secondary hover:border-label-tertiary/40"
      >
        {glyph}
        {label}
      </button>
    </form>
  );
}

export type SignInFormProps = {
  email: string;
  password: string;
  showPassword: boolean;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onTogglePassword: () => void;
  onSubmit: () => void;
  error: string | null;
  submitting: boolean;
  /**
   * WARP-629 — the SSO provider IDs this appliance has configured, discovered
   * at runtime (GET /api/sso/oidc/providers) and passed down by the login page.
   * The form renders one live button per ID that maps to a known provider, in
   * canonical order, and nothing for the rest. Empty/absent → no SSO section
   * and no directory divider (local-first, password-only).
   */
  ssoProviders?: readonly string[];
  /** Same-origin path to land on after a successful SSO sign-in (the login
   *  page's `?next=`). Omitted → the orchestrator defaults to "/". */
  returnTo?: string;
  /**
   * Start the passwordless passkey ceremony. Wired by the login page once the
   * WebAuthn backend shipped (PR #377). When omitted, the passkey affordance
   * falls back to the disabled "Soon" placeholder.
   */
  onPasskey?: () => void;
  /** True while the passkey ceremony is in flight (drives the busy label). */
  passkeyBusy?: boolean;
};

export function SignInForm({
  email,
  password,
  showPassword,
  onEmailChange,
  onPasswordChange,
  onTogglePassword,
  onSubmit,
  error,
  submitting,
  ssoProviders = [],
  returnTo,
  onPasskey,
  passkeyBusy = false,
}: SignInFormProps) {
  // WARP-629: render exactly the configured providers, in canonical order, by
  // filtering the catalog against the runtime-discovered set. Filtering the
  // catalog (not mapping the wire list) gives canonical order for free and
  // drops any unknown id the wire might carry. Discovered ids are normalized
  // through the shared alias map so a box reporting `azuread`/`microsoft` still
  // matches the canonical `entra` entry (single source of truth — same as the
  // Team step).
  const discovered = new Set(ssoProviders.map(normalizeSsoProviderId));
  const visibleProviders = SSO_PROVIDER_CATALOG.filter((p) =>
    discovered.has(p.providerId),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* SSO — local-first / SSO-optional (WARP-629). The login shows ONLY the
          identity providers this appliance has actually configured, discovered
          at runtime. No configured providers → no SSO section and no directory
          divider; the password path stands alone. There is no disabled "Soon"
          pill and no button that can POST to an unconfigured provider. */}
      {visibleProviders.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {visibleProviders.map((p) => (
              <SsoProviderButton
                key={p.providerId}
                providerId={p.providerId}
                label={p.loginLabel}
                glyph={p.glyph}
                returnTo={returnTo}
              />
            ))}
          </div>

          <div className="flex items-center gap-3 my-1">
            <span className="flex-1 h-px bg-separator" />
            <span className="type-caption-2 text-label-tertiary font-medium">
              OR USE YOUR DIRECTORY ACCOUNT
            </span>
            <span className="flex-1 h-px bg-separator" />
          </div>
        </>
      )}

      {/* Work email */}
      <div>
        <label
          htmlFor="login-email"
          className="type-footnote font-semibold text-label-secondary block mb-1.5"
        >
          Work email
        </label>
        <div className="relative">
          <Mail
            size={16}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
          />
          <input
            id="login-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="you@company.com"
            autoComplete="username"
            className="dp-input pl-10"
            autoFocus
          />
        </div>
      </div>

      {/* Password */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="login-password"
            className="type-footnote font-semibold text-label-secondary"
          >
            Password
          </label>
          {!ONB_AUTH_FLAGS.forgotPassword && (
            <button
              type="button"
              disabled
              title="Coming soon"
              className="type-caption-1 font-semibold text-label-tertiary cursor-not-allowed select-none"
            >
              Forgot?
            </button>
          )}
        </div>
        <div className="relative">
          <Lock
            size={16}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
          />
          <input
            id="login-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            className="dp-input pl-10 pr-10"
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary"
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="dp-btn-primary w-full mt-0.5 disabled:opacity-70"
      >
        {submitting ? "Signing in…" : "Sign in"}
        {!submitting && <ArrowRight size={15} aria-hidden="true" />}
      </button>

      {/* Passkey. Three states:
          - flag on + onPasskey wired (browser supports WebAuthn) → live button
          - flag on but no handler (browser can't do WebAuthn) → render nothing
          - flag off (backend not shipped) → disabled "Soon" placeholder */}
      {!ONB_AUTH_FLAGS.passkey ? (
        <ComingSoon className="!min-h-[40px]">
          <KeyRound size={14} aria-hidden="true" />
          Use a security key or passkey
        </ComingSoon>
      ) : onPasskey ? (
        <button
          type="button"
          onClick={onPasskey}
          disabled={passkeyBusy}
          className="dp-btn-secondary w-full justify-center gap-2.5 disabled:opacity-70"
        >
          <KeyRound size={14} aria-hidden="true" />
          {passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
        </button>
      ) : null}
    </div>
  );
}
