import { type ReactNode } from "react";
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  KeyRound,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
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
      {returnTo ? (
        <input type="hidden" name="returnTo" value={returnTo} />
      ) : null}
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
   * Handle a click on the passkey affordance. Wired by the login page once the
   * WebAuthn backend shipped (PR #377); as of WARP-1054 it NAVIGATES to the
   * dedicated `/login/passkey` approval page (which runs the ceremony) rather
   * than running it inline — so the click is instant and there's no busy state
   * to render here. When omitted, the affordance falls back to the disabled
   * "Soon" placeholder.
   */
  onPasskey?: () => void;
  /**
   * PR #375 — two-factor challenge. When true the form swaps the
   * email/password/SSO block for the code-entry panel: the password was already
   * accepted by the orchestrator, which now requires a second factor before it
   * issues a session. Default false → the form renders exactly as before, so
   * existing callers/tests are unaffected.
   */
  mfaRequired?: boolean;
  /** Which second factor the challenge panel is collecting. */
  mfaMode?: "totp" | "recovery";
  /** The 6-digit authenticator code (controlled). */
  totpCode?: string;
  onTotpCodeChange?: (v: string) => void;
  /** A single-use recovery code (controlled). */
  recoveryCode?: string;
  onRecoveryCodeChange?: (v: string) => void;
  /** Toggle between the authenticator-code and recovery-code inputs. */
  onToggleMfaMode?: () => void;
  /** Abandon the challenge and return to the email/password step. */
  onCancelMfa?: () => void;
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
  mfaRequired = false,
  mfaMode = "totp",
  totpCode = "",
  onTotpCodeChange,
  recoveryCode = "",
  onRecoveryCodeChange,
  onToggleMfaMode,
  onCancelMfa,
}: SignInFormProps) {
  // PR #375 — two-factor challenge. The orchestrator accepted the password and
  // is now holding the session behind a second factor. Swap the whole
  // email/password/SSO block for a focused code-entry panel: there is nothing
  // else to do on this screen until the code is entered, and showing the
  // (already-accepted) password fields again would only invite confusion.
  if (mfaRequired) {
    const isRecovery = mfaMode === "recovery";
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent/10">
            <ShieldCheck size={18} className="text-accent" aria-hidden="true" />
          </div>
          <div>
            <p className="type-subheadline font-semibold text-label-primary">
              Two-factor authentication
            </p>
            <p
              id="login-mfa-help"
              className="type-caption-1 text-label-secondary"
            >
              {isRecovery
                ? "Enter one of the recovery codes you saved during setup."
                : "Enter the 6-digit code from your authenticator app."}
            </p>
            {/* Separate live region announces mode changes to AT without
                double-reading the describedby text on focus. */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {isRecovery
                ? "Enter one of the recovery codes you saved during setup."
                : "Enter the 6-digit code from your authenticator app."}
            </span>
          </div>
        </div>

        {isRecovery ? (
          <div>
            <label
              htmlFor="login-recovery-code"
              className="type-footnote font-semibold text-label-secondary block mb-1.5"
            >
              Recovery code
            </label>
            <div className="relative">
              <KeyRound
                size={16}
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              />
              <input
                id="login-recovery-code"
                type="text"
                autoComplete="one-time-code"
                aria-describedby="login-mfa-help"
                value={recoveryCode}
                onChange={(e) => onRecoveryCodeChange?.(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSubmit()}
                placeholder="xxxx-xxxx"
                className="dp-input pl-10 font-mono"
                autoFocus
              />
            </div>
          </div>
        ) : (
          <div>
            <label
              htmlFor="login-totp-code"
              className="type-footnote font-semibold text-label-secondary block mb-1.5"
            >
              6-digit code
            </label>
            <input
              id="login-totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-describedby="login-mfa-help"
              maxLength={6}
              value={totpCode}
              onChange={(e) =>
                onTotpCodeChange?.(e.target.value.replace(/\D/g, ""))
              }
              onKeyDown={(e) => e.key === "Enter" && onSubmit()}
              placeholder="123456"
              className="dp-input text-center tracking-[0.5em] font-mono"
              autoFocus
            />
          </div>
        )}

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
          {submitting ? "Verifying…" : "Verify"}
          {!submitting && <ArrowRight size={15} aria-hidden="true" />}
        </button>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onToggleMfaMode}
            className="type-caption-1 font-semibold text-accent hover:underline"
          >
            {isRecovery
              ? "Use your authenticator app"
              : "Use a recovery code instead"}
          </button>
          <button
            type="button"
            onClick={onCancelMfa}
            className="type-caption-1 font-semibold text-label-tertiary hover:text-label-secondary"
          >
            Use a different account
          </button>
        </div>
      </div>
    );
  }

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
          {/* Password reset isn't wired yet (see flags.ts). Until it is we
              render NOTHING rather than a permanently-disabled "Forgot?" —
              a greyed-out control that never becomes usable reads as a
              broken screen, not as a promise. The affordance comes back
              with the backend that makes it work. */}
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

      {/* Passkey — an ALTERNATIVE to the primary action, not a second equal
          one. Before this it rendered at the same width, height, type size
          and weight as "Sign in", so the screen ended in two identically
          weighted stacked blocks with no hierarchy. The "or" rule separates
          the paths and the smaller label sets the alternative below the
          primary, while the 44px target is preserved for touch (we do NOT
          drop to the canon's 40px — that's below the tap-target floor the
          rest of the dashboard holds).

          Three states:
          - flag on + onPasskey wired (browser supports WebAuthn) → live button
          - flag on but no handler (browser can't do WebAuthn) → render nothing
          - flag off (backend not shipped) → disabled "Soon" placeholder */}
      {ONB_AUTH_FLAGS.passkey && !onPasskey ? null : (
        <div className="flex items-center gap-3 mt-1 mb-0.5">
          <span className="flex-1 h-px bg-separator" />
          <span className="type-caption-2 text-label-tertiary font-medium">
            OR
          </span>
          <span className="flex-1 h-px bg-separator" />
        </div>
      )}
      {!ONB_AUTH_FLAGS.passkey ? (
        <ComingSoon className="type-footnote">
          <KeyRound size={14} aria-hidden="true" />
          Use a security key or passkey
        </ComingSoon>
      ) : onPasskey ? (
        <button
          type="button"
          onClick={onPasskey}
          className="dp-btn-secondary type-footnote w-full justify-center gap-2.5"
        >
          <KeyRound size={14} aria-hidden="true" />
          Sign in with a passkey
        </button>
      ) : null}
    </div>
  );
}
