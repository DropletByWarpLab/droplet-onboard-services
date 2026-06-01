"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, User } from "lucide-react";
import { setupAdmin, loginUser } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";

const RESERVED_USERNAMES = ["admin", "root"];

/**
 * Create-admin step.
 *
 * Owns its own form state (username / display name / password / confirm)
 * and the submit lifecycle. On success, calls `setupAdmin` + `loginUser`
 * (auto-login so later steps can hit authenticated endpoints), then bubbles
 * the chosen display name up via `onComplete` so the wizard's final `done`
 * step can personalise the WelcomeFlourish ("Welcome, Robin").
 *
 * PR #372: the appliance is NOT claimed here — that would mark setup
 * complete mid-wizard and break resumability (a refresh would route to the
 * dashboard before the owner finished). The "ready" transition is fired at
 * the wizard's terminal `done` step (DoneStep → completeSetup).
 *
 * Wraps `StepShell` for chrome (title / subtitle / primary CTA) so the
 * layout matches the rest of the wizard's typed steps. The form fields
 * + inline error live inside `children`; the "Create Account" button is
 * StepShell's `primary` action.
 *
 * Validation rules are identical to the pre-refactor inline version —
 * tests assert on the exact error strings and the placeholder copy
 * (`your-username`, `Min. 8 characters`, `Repeat password`).
 */
export function AccountStep({
  onComplete,
}: {
  onComplete: (displayName: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleCreateAccount() {
    setError(null);

    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (username.length < 2) {
      setError("Username must be at least 2 characters");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setError(
        "Username can only contain letters, numbers, dots, hyphens, and underscores",
      );
      return;
    }
    if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
      setError("This username is reserved and cannot be used");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);
    try {
      await setupAdmin(username, password, displayName || undefined);
      // Auto-login so we can call authenticated endpoints during discovery.
      await loginUser(username, password);
      onComplete(displayName);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Setup failed. Please try again.";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <StepShell
      title="Create your account"
      subtitle="This will be the administrator account for your Droplet."
      primary={{
        label: "Create Account",
        loadingLabel: "Creating account...",
        onClick: handleCreateAccount,
        isLoading: isSubmitting,
      }}
    >
      <div className="space-y-4">
        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Username
          </label>
          <div className="relative">
            <User
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="your-username"
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
              placeholder="Min. 8 characters"
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
          <p className="type-caption-1 text-label-quaternary mt-1.5">
            Must be at least 8 characters
          </p>
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

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </StepShell>
  );
}
