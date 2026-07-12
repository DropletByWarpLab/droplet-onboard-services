"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, Mail, UserCheck } from "lucide-react";
import {
  setupAdmin,
  loginUser,
  checkSetupRequired,
  checkClaimGateEnabled,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StepShell } from "@/components/setup/StepShell";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { translateError } from "@/lib/friendly-errors";
import { validatePassword, isValidEmail, PASSWORD_MIN } from "@droplet/auth-policy";

/**
 * Create-owner step. ADR-013: the directory login key is the work email;
 * the username is derived server-side, so this form collects email +
 * display name + password only. A live PasswordRulesChecklist mirrors the
 * orchestrator's policy, and the CTA stays disabled until every rule passes.
 *
 * WARP-867 — interrupted-run resume: once this step has succeeded once, the
 * owner row exists and POST /auth/setup refuses forever after with 409
 * OWNER_EXISTS (the PR #374 anti-takeover guard — correct, and kept). A
 * wizard that walks back here anyway (reboot mid-setup, claim re-entered,
 * back-navigation) used to dead-end: the only form on screen could never
 * succeed. The step now has a second mode — "sign in to continue" — entered
 * two ways:
 *   - proactively, when the mount-time `GET /api/auth/setup` probe answers
 *     an explicit `setupRequired: false` (tri-state; `unknown` NEVER flips
 *     the mode — fail toward the normal create flow);
 *   - reactively, when a create attempt comes back with code OWNER_EXISTS.
 * Signing in proves ownership with the password chosen earlier, and the
 * wizard continues exactly where `onComplete` always took it. Starting over
 * from scratch remains a factory reset — by design, not a wizard affordance.
 */
export function AccountStep({
  onComplete,
}: {
  onComplete: (displayName: string) => void;
}) {
  const [mode, setMode] = useState<"create" | "signin">("create");
  // Adopt the wizard's auto-login into the auth context. Without this the
  // context `user` stays null for the whole wizard (loginUser only sets the
  // cookie), so AuthGate treats the owner as anonymous at the Done screen and
  // bounces them to /login mid-flourish — the embedded tour never plays and
  // they're asked to sign in to the account they created seconds earlier.
  // `setUserFromPasskey` is the existing adopt-an-established-session setter
  // (sets user + re-probes the authoritative lifecycle state, WARP-867), so
  // the unclaimed appliance keeps the wizard in place. The method is called
  // optionally: wizard-page test harnesses mock useAuth() with step-scoped
  // objects that don't carry it, and there the adoption is simply skipped.
  const { setUserFromPasskey } = useAuth();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // WARP-165 — physical-presence claim gate. When the orchestrator reports the
  // gate is on, the create flow shows a claim-code field (read off the device's
  // front panel) and POST /auth/setup requires it. Default OFF so the field
  // never appears — and can never block setup — on a box that isn't gated.
  const [claimGateOn, setClaimGateOn] = useState(false);
  const [claimCode, setClaimCode] = useState("");
  // WARP-929 (A3) — true once THIS session created the owner. After that, the
  // proactive "owner exists → sign in" probe below must NOT flip the step to the
  // "Welcome back" sign-in mode: doing so showed a "Welcome back" screen
  // mid-signup (Romain's report) if the account step ever re-rendered. The nav
  // floor (WARP-929) already stops back-navigation here, but this is the
  // belt-and-braces guard for any same-session re-render.
  const createdHere = useRef(false);

  // WARP-650: label/input associations for the account-step form fields.
  const claimCodeId = useId();
  const emailId = useId();
  const displayNameId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();

  // WARP-867 — proactive owner-exists detection. Tri-state probe: only an
  // EXPLICIT "complete" flips to sign-in; "unknown" (cold boot, 5xx, timeout)
  // keeps the create form so a transient probe failure can't hide the normal
  // first-run flow. The reactive OWNER_EXISTS catch below covers the race
  // where the probe was wrong or raced the row's creation.
  useEffect(() => {
    let cancelled = false;
    void checkSetupRequired().then((status) => {
      // A3: never flip to "Welcome back" after we created the owner this session.
      if (!cancelled && !createdHere.current && status === "complete") {
        setMode("signin");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // WARP-165 — probe whether the claim gate is on. Fail-safe: any indeterminate
  // answer resolves to false (checkClaimGateEnabled), so a transient failure
  // never hides the normal first-run create form behind a field the server
  // wouldn't enforce.
  useEffect(() => {
    let cancelled = false;
    void checkClaimGateEnabled().then((on) => {
      if (!cancelled) setClaimGateOn(on);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const emailOk = isValidEmail(email);
  const pwOk = validatePassword(password).ok;
  const matchOk = password.length > 0 && password === confirmPassword;
  // The claim code only gates the CREATE flow (a returning owner signing in
  // already proved presence at their first run). It's satisfied by any
  // non-empty value; the server is the authority on whether it actually
  // matches the front-panel code.
  const claimOk = !claimGateOn || mode === "signin" || claimCode.trim().length > 0;
  const canSubmit =
    mode === "signin"
      ? emailOk && password.length > 0 && !isSubmitting
      : emailOk && pwOk && matchOk && claimOk && !isSubmitting;

  // Spell out the first thing still blocking submission so the disabled CTA is
  // never an unexplained dead end. A 10-char password clears the character-class
  // rule but not the 12-char minimum — the exact stuck state from the field
  // report (a disabled button + no error). The live checklist flags the
  // password/match rules; this also covers the email (which isn't in the
  // checklist) and ties the gate to the button. Only shown once the user has
  // started filling the form in. Sign-in mode has no policy gates — the only
  // blockers are the two fields themselves.
  const engaged =
    email.length > 0 || password.length > 0 || confirmPassword.length > 0;
  const blockerHint =
    !engaged || canSubmit
      ? null
      : !emailOk
        ? email.length > 0
          ? "That work email doesn't look right yet."
          : "Add your work email to continue."
        : mode === "signin"
          ? password.length === 0
            ? "Enter your password to continue."
            : null
          : !pwOk
            ? "Your password doesn't meet all the requirements yet."
            : !matchOk
              ? "Re-enter the same password to confirm it."
              : !claimOk
                ? "Enter the claim code from your device's front panel to continue."
                : null;

  async function handleCreateAccount() {
    setError(null);
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      // WARP-165 — pass the claim code ONLY when the gate is on. On the
      // default un-gated path we make the original 3-arg call so the request
      // body (and call shape) is byte-identical to main.
      if (claimGateOn) {
        await setupAdmin(
          email,
          password,
          displayName || undefined,
          claimCode.trim(),
        );
      } else {
        await setupAdmin(email, password, displayName || undefined);
      }
      // WARP-929 (A3) — the owner now exists because WE just made it; from here
      // the proactive probe must not flip this step to "Welcome back".
      createdHere.current = true;
      // Auto-login for the authed steps that follow, and adopt the session
      // into the auth context so AuthGate knows the owner is signed in.
      // (Read defensively — step harnesses stub loginUser without a body.)
      const login = await loginUser(email, password);
      if (login?.user) setUserFromPasskey?.(login.user);
      onComplete(displayName);
    } catch (err: unknown) {
      // WARP-867 — the owner row already exists (interrupted earlier run).
      // Don't dead-end on the 409: flip to the sign-in variant, keep the
      // typed email, and clear the password fields (the rules checklist has
      // no meaning for an existing credential).
      if ((err as { code?: string } | null)?.code === "OWNER_EXISTS") {
        setMode("signin");
        setPassword("");
        setConfirmPassword("");
        setError(null);
      } else {
        setError(translateError(err, "auth"));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSignIn() {
    setError(null);
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const { user } = await loginUser(email, password);
      setUserFromPasskey?.(user);
      onComplete(user.displayName ?? "");
    } catch (err: unknown) {
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  const submit = mode === "signin" ? handleSignIn : handleCreateAccount;

  return (
    <StepShell
      current="account"
      title={mode === "signin" ? "Welcome back" : "Create your account"}
      subtitle={
        mode === "signin"
          ? "This Droplet already has an administrator account. Sign in to keep setting it up."
          : "This will be the administrator account for your Droplet."
      }
      primary={{
        label: mode === "signin" ? "Sign In & Continue" : "Create Account",
        loadingLabel: mode === "signin" ? "Signing in..." : "Creating account...",
        onClick: submit,
        isLoading: isSubmitting,
        disabled: !canSubmit,
      }}
    >
      <div className="space-y-4">
        {mode === "signin" && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2.5 rounded-md border border-separator bg-surface-secondary px-3 py-2.5"
          >
            <UserCheck
              size={16}
              className="mt-0.5 shrink-0 text-accent"
              aria-hidden
            />
            <p className="type-footnote text-label-secondary">
              Use the email and password you chose earlier in setup. To start
              over with a different account, factory-reset the Droplet first.
            </p>
          </div>
        )}

        {/* WARP-165 — physical-presence claim code. Create flow only, and only
            when the orchestrator reports the gate is on. Mirrors the Work email
            field pattern (dp-input + left icon + type-subheadline label) for a
            cohesive form; the caption tells the user where to read the code. */}
        {mode === "create" && claimGateOn && (
          <div>
            <label htmlFor={claimCodeId} className="type-subheadline text-label-secondary block mb-1">
              Claim code
            </label>
            <p
              id="account-claim-hint"
              className="type-caption-1 text-label-secondary mb-1.5"
            >
              Enter the code shown on your Droplet&apos;s front panel to confirm
              you&apos;re setting it up in person.
            </p>
            <div className="relative">
              <KeyRound
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              />
              <input
                id={claimCodeId}
                type="text"
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value)}
                placeholder="DRPL-XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby="account-claim-hint"
                className="dp-input pl-10 font-mono tracking-wide"
              />
            </div>
          </div>
        )}

        <div>
          <label htmlFor={emailId} className="type-subheadline text-label-secondary block mb-1.5">
            Work email
          </label>
          <div className="relative">
            <Mail
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={emailId}
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

        {mode === "create" && (
          <div>
            <label htmlFor={displayNameId} className="type-subheadline text-label-secondary block mb-1.5">
              Display name (optional)
            </label>
            <input
              id={displayNameId}
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="dp-input"
            />
          </div>
        )}

        <div>
          <label htmlFor={passwordId} className="type-subheadline text-label-secondary block mb-1">
            Password
          </label>
          {/* WARP-668 — state the requirement up front, before the user types,
              derived from the policy so it can't drift. The live checklist
              below tracks progress against it. Only meaningful while CREATING
              a credential — sign-in takes the password as-is. */}
          {mode === "create" && (
            <p
              id="account-password-hint"
              className="type-caption-1 text-label-secondary mb-1.5"
            >
              Use at least {PASSWORD_MIN} characters with a mix of letters,
              numbers, and symbols.
            </p>
          )}
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={passwordId}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                mode === "signin" ? "Your password" : "Create a password"
              }
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
              aria-describedby={
                mode === "create" ? "account-password-hint" : undefined
              }
              className="dp-input pl-10 pr-10"
              onKeyDown={(e) =>
                mode === "signin" && e.key === "Enter" && handleSignIn()
              }
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

        {mode === "create" && (
          <div>
            <label htmlFor={confirmPasswordId} className="type-subheadline text-label-secondary block mb-1.5">
              Confirm password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
              />
              <input
                id={confirmPasswordId}
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
        )}

        {mode === "create" && (
          <PasswordRulesChecklist password={password} confirm={confirmPassword} />
        )}

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
