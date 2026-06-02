"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { setupAdmin, loginUser } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { translateError } from "@/lib/friendly-errors";
import { validatePassword, isValidEmail } from "@droplet/auth-policy";

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
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Password
          </label>
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

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </StepShell>
  );
}
