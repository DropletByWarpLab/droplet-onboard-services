import { type ReactNode } from "react";
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  KeyRound,
  ArrowRight,
  ShieldCheck,
  CircleAlert,
} from "lucide-react";
import { ONB_AUTH_FLAGS } from "./flags";
import {
  SSO_PROVIDER_CATALOG,
  normalizeSsoProviderId,
} from "@/lib/sso-providers";

/* ─── Control styles — WARP-2973 ────────────────────────────────────
   The login landing design (docs/design/login-landing.dc.html) sizes every
   control in this column at 48px with an 8px radius, which is `h-12` +
   `rounded-sm` (the dashboard's `sm` radius IS 8px — see
   tailwind.config.ts, it is not Tailwind's default 2px).

   These are local constants rather than new `dp-*` globals on purpose:
   `dp-input` / `dp-btn-*` ship on ~70 call sites across the dashboard at
   44px, and the auth surface is a deliberately separate visual identity
   (WARP-1078). Resizing the shared token to suit one screen would move
   every form in the product.

   Unlike the hero, this column is TOKENS ONLY — it follows the theme. */
const FIELD =
  "w-full h-12 rounded-sm border border-separator bg-surface-secondary " +
  "text-[16px] text-label-primary placeholder:text-label-tertiary " +
  "outline-none transition-colors duration-200 ease-smooth " +
  "hover:border-label-quaternary focus:border-accent focus:ring-2 focus:ring-accent";

const BTN_PRIMARY =
  "w-full h-12 inline-flex items-center justify-center gap-2 rounded-sm " +
  // `bg-accent-fill`, not `bg-accent`: this is the same white-on-vivid-accent
  // pair as `.dp-btn-primary`, which measures 4.47:1 in light mode (under AA).
  // Hover moves to opacity, matching `.dp-btn-primary` — in light the new fill
  // IS `--color-accent-hover` (both indigo-600), so `hover:bg-accent-hover`
  // would have left this button with no visible press feedback.
  "bg-accent-fill text-accent-foreground text-[16px] font-semibold " +
  "transition-all duration-200 ease-smooth hover:opacity-85 " +
  "active:scale-[0.97] disabled:opacity-60 disabled:pointer-events-none";

const BTN_SECONDARY =
  "w-full h-12 inline-flex items-center justify-center gap-2.5 rounded-sm " +
  "border border-separator bg-surface-secondary text-label-primary " +
  "text-[15px] font-medium transition-colors duration-200 ease-smooth " +
  "hover:bg-surface-tertiary hover:border-label-quaternary active:scale-[0.97]";

const LABEL = "type-footnote font-semibold text-label-primary";

/** Leading glyph inside a 48px field. */
const GLYPH =
  "absolute left-3.5 top-1/2 -translate-y-1/2 text-label-tertiary pointer-events-none";

/** A thin uppercase rule. Only ever rendered when something follows it. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 h-px bg-separator" />
      <span className="type-caption-2 font-medium uppercase tracking-[0.14em] text-label-tertiary">
        {label}
      </span>
      <span className="flex-1 h-px bg-separator" />
    </div>
  );
}

/**
 * The form's error surface.
 *
 * The tint is a `color-mix`, not `bg-system-red/10`: every colour in
 * tailwind.config.ts is a bare `var(--color-…)` with no `<alpha-value>`
 * placeholder, so Tailwind drops EVERY `/NN` alpha utility built on one —
 * silently, which is how the old alert shipped with no fill at all. Same
 * failure mode the `accent-alpha` guard in check-dashboard-classes.sh
 * exists for; it only polices the accent.
 */
function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-sm px-3.5 py-3 border border-system-red
                 bg-[color-mix(in_srgb,var(--color-system-red)_12%,transparent)]
                 type-footnote leading-snug text-system-red"
    >
      <CircleAlert
        size={16}
        aria-hidden="true"
        className="flex-none mt-px"
      />
      <span>{message}</span>
    </div>
  );
}

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
      className={`${BTN_SECONDARY} !text-label-secondary opacity-60 cursor-not-allowed ${className}`}
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
        className={BTN_SECONDARY}
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
              className={`${LABEL} block mb-2`}
            >
              Recovery code
            </label>
            <div className="relative">
              <KeyRound size={16} aria-hidden="true" className={GLYPH} />
              <input
                id="login-recovery-code"
                type="text"
                autoComplete="one-time-code"
                aria-describedby="login-mfa-help"
                value={recoveryCode}
                onChange={(e) => onRecoveryCodeChange?.(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSubmit()}
                placeholder="xxxx-xxxx"
                className={`${FIELD} pl-11 pr-3.5 font-mono`}
                autoFocus
              />
            </div>
          </div>
        ) : (
          <div>
            <label htmlFor="login-totp-code" className={`${LABEL} block mb-2`}>
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
              className={`${FIELD} px-3.5 text-center tracking-[0.5em] font-mono`}
              autoFocus
            />
          </div>
        )}

        {error && <ErrorAlert message={error} />}

        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className={BTN_PRIMARY}
        >
          {submitting ? "Verifying" : "Verify"}
          {!submitting && <ArrowRight size={16} aria-hidden="true" />}
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
    <div className="flex flex-col gap-4">
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

          <Divider label="Or use your directory account" />
        </>
      )}

      {/* Work email */}
      <div>
        <label htmlFor="login-email" className={`${LABEL} block mb-2`}>
          Work email
        </label>
        <div className="relative">
          <Mail size={16} aria-hidden="true" className={GLYPH} />
          <input
            id="login-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="you@company.com"
            autoComplete="username"
            className={`${FIELD} pl-11 pr-3.5`}
            autoFocus
          />
        </div>
      </div>

      {/* Password */}
      <div>
        <div className="flex items-center justify-between mb-2 min-h-[18px]">
          <label htmlFor="login-password" className={LABEL}>
            Password
          </label>
          {/* Password reset isn't wired yet (see flags.ts). Until it is we
              render NOTHING rather than a permanently-disabled "Forgot?" —
              a greyed-out control that never becomes usable reads as a
              broken screen, not as a promise. The affordance comes back
              with the backend that makes it work. */}
        </div>
        <div className="relative">
          <Lock size={16} aria-hidden="true" className={GLYPH} />
          <input
            id="login-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            className={`${FIELD} pl-11 pr-12`}
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-sm text-label-tertiary transition-colors hover:bg-surface-tertiary hover:text-label-primary"
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      {error && <ErrorAlert message={error} />}

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className={BTN_PRIMARY}
      >
        {submitting ? "Signing in" : "Sign in"}
        {!submitting && <ArrowRight size={16} aria-hidden="true" />}
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
      {ONB_AUTH_FLAGS.passkey && !onPasskey ? null : <Divider label="or" />}
      {!ONB_AUTH_FLAGS.passkey ? (
        <ComingSoon>
          <KeyRound size={16} aria-hidden="true" className="text-accent" />
          Use a security key or passkey
        </ComingSoon>
      ) : onPasskey ? (
        <button type="button" onClick={onPasskey} className={BTN_SECONDARY}>
          <KeyRound size={16} aria-hidden="true" className="text-accent" />
          Sign in with a passkey
        </button>
      ) : null}
    </div>
  );
}
