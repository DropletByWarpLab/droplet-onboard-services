import { type ReactNode } from "react";
import { Lock, Mail, Eye, EyeOff, KeyRound, ArrowRight } from "lucide-react";
import { ONB_AUTH_FLAGS } from "./flags";

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

const SSO_PROVIDERS = [
  { id: "google", label: "Continue with Google", glyph: <GoogleGlyph /> },
  { id: "microsoft", label: "Continue with Microsoft", glyph: <MicrosoftGlyph /> },
  { id: "okta", label: "Continue with Okta", glyph: <OktaGlyph /> },
] as const;

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
}: SignInFormProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* SSO — gated until the OIDC/SAML backends land */}
      <div className="flex flex-col gap-2">
        {SSO_PROVIDERS.map((p) =>
          ONB_AUTH_FLAGS.sso ? null : (
            <ComingSoon key={p.id}>
              {p.glyph}
              {p.label}
            </ComingSoon>
          ),
        )}
      </div>

      <div className="flex items-center gap-3 my-1">
        <span className="flex-1 h-px bg-separator" />
        <span className="type-caption-2 text-label-tertiary font-medium">
          OR USE YOUR DIRECTORY ACCOUNT
        </span>
        <span className="flex-1 h-px bg-separator" />
      </div>

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
            <span
              title="Coming soon"
              aria-disabled="true"
              className="type-caption-1 font-semibold text-label-tertiary cursor-not-allowed select-none"
            >
              Forgot?
            </span>
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

      {/* Passkey — gated until WebAuthn lands */}
      {!ONB_AUTH_FLAGS.passkey && (
        <ComingSoon className="!min-h-[40px]">
          <KeyRound size={14} aria-hidden="true" />
          Use a security key or passkey
        </ComingSoon>
      )}
    </div>
  );
}
