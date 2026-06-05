"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { setupAdmin, loginUser } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { translateError } from "@/lib/friendly-errors";
import { validatePassword, isValidEmail, PASSWORD_MIN } from "@droplet/auth-policy";

/**
 * Create-owner step. ADR-013: the directory login key is the work email;
 * the username is derived server-side, so this form collects email +
 * display name + password only. A live PasswordRulesChecklist mirrors the
 * orchestrator's policy, and the CTA stays disabled until every rule passes.
 */
export function AccountStep({
  onComplete,
}: {
  onComplete: (displayName: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const emailOk = isValidEmail(email);
  const pwOk = validatePassword(password).ok;
  const matchOk = password.length > 0 && password === confirmPassword;
  const canSubmit = emailOk && pwOk && matchOk && !isSubmitting;

  // Spell out the first thing still blocking submission so the disabled CTA is
  // never an unexplained dead end. A 10-char password clears the character-class
  // rule but not the 12-char minimum — the exact stuck state from the field
  // report (a disabled button + no error). The live checklist flags the
  // password/match rules; this also covers the email (which isn't in the
  // checklist) and ties the gate to the button. Only shown once the user has
  // started filling the form in.
  const engaged =
    email.length > 0 || password.length > 0 || confirmPassword.length > 0;
  const blockerHint =
    !engaged || canSubmit
      ? null
      : !emailOk
        ? email.length > 0
          ? "That work email doesn't look right yet."
          : "Add your work email to continue."
        : !pwOk
          ? "Your password doesn't meet all the requirements yet."
          : !matchOk
            ? "Re-enter the same password to confirm it."
            : null;

  async function handleCreateAccount() {
    setError(null);
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await setupAdmin(email, password, displayName || undefined);
      await loginUser(email, password); // auto-login for authed discovery steps
      onComplete(displayName);
    } catch (err: unknown) {
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <StepShell
      current="account"
      title="Create your account"
      subtitle="This will be the administrator account for your Droplet."
      primary={{
        label: "Create Account",
        loadingLabel: "Creating account...",
        onClick: handleCreateAccount,
        isLoading: isSubmitting,
        disabled: !canSubmit,
      }}
    >
      <div className="space-y-4">
        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Work email
          </label>
          <div className="relative">
            <Mail
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="username"
              className="dp-input pl-10"
              autoFocus
            />
          </div>
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name (optional)"
            className="dp-input"
          />
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1">
            Password
          </label>
          {/* WARP-668 — state the requirement up front, before the user types,
              derived from the policy so it can't drift. The live checklist
              below tracks progress against it. */}
          <p
            id="account-password-hint"
            className="type-caption-1 text-label-secondary mb-1.5"
          >
            Use at least {PASSWORD_MIN} characters with a mix of letters,
            numbers, and symbols.
          </p>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a password"
              autoComplete="new-password"
              aria-describedby="account-password-hint"
              className="dp-input pl-10 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Confirm Password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              autoComplete="new-password"
              className="dp-input pl-10"
              onKeyDown={(e) => e.key === "Enter" && handleCreateAccount()}
            />
          </div>
        </div>

        <PasswordRulesChecklist password={password} confirm={confirmPassword} />

        {/* Polite live region: screen-reader users hear *why* the disabled CTA
            is unavailable (a disabled button is otherwise silent). Kept mounted
            — empty when there's nothing to say — so the region is registered
            before its text changes and the hint's appearance causes no layout
            shift. */}
        <p
          role="status"
          aria-live="polite"
          className="type-footnote text-label-secondary"
        >
          {blockerHint}
        </p>

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </StepShell>
  );
}
