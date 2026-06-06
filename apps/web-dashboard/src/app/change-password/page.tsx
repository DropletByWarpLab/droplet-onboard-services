"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { validatePassword } from "@droplet/auth-policy";
import { DropletMark } from "@/components/DropletMark";
import { AuroraPanel } from "@/components/auth/AuroraPanel";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { translateError } from "@/lib/friendly-errors";
import { changePassword } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * WARP-824 — forced password-change screen.
 *
 * An admin-created user signs in with a temporary password and is pinned here
 * by AuthGate (and by the orchestrator's server-side gate) until they replace
 * it. Reuses the login Aurora split + the shared PasswordRulesChecklist so it
 * reads as part of the same auth flow.
 *
 * The same screen serves any user who wants to rotate their own password; the
 * forced-change copy is the default because that's the entry point AuthGate
 * routes to.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, markPasswordChanged } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Client-side mirror of the server policy so we never fire a guaranteed-400:
  // the new password must satisfy the shared policy, match its confirmation,
  // and the current password must be present. The orchestrator re-checks all
  // of this — this is a UX gate, not the enforcement.
  const newPasswordOk = useMemo(() => validatePassword(newPassword).ok, [newPassword]);
  const confirmOk = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit =
    currentPassword.length > 0 && newPasswordOk && confirmOk && !submitting;

  async function handleSubmit() {
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      // The server cleared the persisted flag; flip the in-memory flag so
      // AuthGate releases us, then land on the dashboard.
      markPasswordChanged();
      router.push("/");
    } catch (err) {
      // Never echo the raw orchestrator string — map the code to home-user copy.
      setError(translateError(err, "auth"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-surface-primary">
      <AuroraPanel className="hidden lg:flex" />

      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-[380px]">
          {/* Compact wordmark — stands in for the brand panel on small screens */}
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <DropletMark size={24} className="text-accent" />
            <span className="type-headline text-label-primary">Droplet</span>
          </div>

          <div className="flex items-center justify-center w-11 h-11 rounded-full bg-accent/10 text-accent mb-4">
            <KeyRound size={20} aria-hidden="true" />
          </div>

          <h1 className="type-title-1 text-label-primary">Set a new password</h1>
          <p className="type-subheadline text-label-secondary mt-1.5 mb-6">
            {user?.displayName ? `Welcome, ${user.displayName}. ` : ""}
            Your account was set up with a temporary password. Choose your own to
            continue.
          </p>

          {error && (
            <div
              role="alert"
              className="mb-5 p-3 bg-system-red/10 border border-system-red/20 rounded-lg type-footnote text-system-red"
            >
              {error}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="current-password" className="type-footnote text-label-secondary block mb-1.5">
                Temporary password
              </label>
              <input
                id="current-password"
                data-testid="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="The password you were given"
                className="dp-input w-full"
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="new-password" className="type-footnote text-label-secondary block mb-1.5">
                New password
              </label>
              <div className="relative">
                <input
                  id="new-password"
                  data-testid="new-password"
                  type={showNew ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Create a password"
                  className="dp-input w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((s) => !s)}
                  aria-label={showNew ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary transition-colors"
                >
                  {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirm-password" className="type-footnote text-label-secondary block mb-1.5">
                Confirm new password
              </label>
              <input
                id="confirm-password"
                data-testid="confirm-password"
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter the new password"
                className="dp-input w-full"
              />
            </div>

            <PasswordRulesChecklist password={newPassword} confirm={confirmPassword} />

            <button
              type="submit"
              disabled={!canSubmit}
              className="dp-btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {submitting ? "Setting password…" : "Set new password"}
            </button>
          </form>

          <p className="type-caption-1 text-label-tertiary text-center mt-6 leading-relaxed">
            This happens on your local network — nothing leaves the box.
          </p>
        </div>
      </div>
    </div>
  );
}
