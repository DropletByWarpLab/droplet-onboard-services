"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Check } from "lucide-react";
import { translateError } from "@/lib/friendly-errors";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignInForm } from "@/components/auth/SignInForm";
// WARP-1054: the passkey button now navigates to a dedicated approval page
// (/login/passkey) that owns the whole ceremony; the login page only needs the
// support probe to decide whether to render the affordance.
import { isPasskeySupported } from "@/lib/webauthn";
// WARP-1054: shared hardened `?next=` resolver (extracted from this file so the
// approval page reuses the exact same open-redirect coverage).
import { safeNext } from "@/lib/safe-next";
// WARP-629: runtime SSO discovery — the login shows only the IdPs this box has
// actually configured (local-first, SSO optional).
import { getEnabledSsoProviders } from "@/lib/api";

/**
 * PR #375 — the orchestrator's two-factor gate answers a correct password with
 * `401 { code: "TOTP_REQUIRED" }`. We dispatch on the typed `code` (the same
 * idiom as friendly-errors and the invite page) rather than `instanceof`, so
 * the check survives module duplication / mocking and doesn't force every
 * `@/lib/auth` consumer to share one error-class identity.
 */
function isTotpRequired(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "TOTP_REQUIRED"
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const fromSetup = searchParams.get("from") === "setup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // PR #375 — two-factor challenge state. `mfaRequired` flips true the first
  // time a correct password comes back as TOTP_REQUIRED; the form then shows
  // the code field. `mfaMode` toggles between the authenticator code and a
  // saved recovery code. The codes live here (the page owns all auth state)
  // and ride the next login() call.
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaMode, setMfaMode] = useState<"totp" | "recovery">("totp");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // PR #377: passkeys are an alternative passwordless path. The affordance is
  // only shown on browsers that support WebAuthn (detected client-side after
  // mount, so SSR renders nothing and we don't flash an unusable button).
  // WARP-1054: clicking it navigates to /login/passkey (instant), so there's no
  // busy state to track on this page anymore.
  const [passkeyReady, setPasskeyReady] = useState(false);
  // WARP-629: which IdP buttons to show is decided at runtime from what the
  // appliance has configured (not a build-time flag). Fetched after mount,
  // mirroring the passkey-capability probe below. Starts empty so SSR /
  // first paint is password-only; SSO is purely additive once discovered.
  const [ssoProviders, setSsoProviders] = useState<string[]>([]);

  useEffect(() => {
    setPasskeyReady(isPasskeySupported());
  }, []);

  useEffect(() => {
    let alive = true;
    getEnabledSsoProviders()
      .then((providers) => {
        if (alive) setSsoProviders(providers);
      })
      .catch(() => {
        // Local-first: a failed/timed-out discovery must never block the
        // password path. Leave the SSO list empty and carry on.
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleLogin() {
    // Re-entrancy guard: the submit button is disabled while submitting, but the
    // email/password/code inputs submit on Enter — without this, mashing Enter
    // fires concurrent login() calls (e.g. two POSTs of the same single-use
    // recovery code, the loser flashing a false "didn't match").
    if (isSubmitting) return;
    setError(null);

    // Two-factor challenge in progress: validate the code, not the credentials
    // (the orchestrator already accepted the password on the first call).
    if (mfaRequired) {
      const code =
        mfaMode === "recovery" ? recoveryCode.trim() : totpCode.trim();
      if (!code) {
        // Distinct from the panel's standing help subtext (which already says
        // where the code comes from) — a short prompt to act, not a repeat.
        setError(
          mfaMode === "recovery"
            ? "Enter a recovery code to continue."
            : "Enter the 6-digit code to continue.",
        );
        return;
      }
    } else if (!email.trim() || !password.trim()) {
      setError("Enter your work email and password to continue.");
      return;
    }

    setIsSubmitting(true);
    try {
      // The built-in directory keys on email in a later PR; today the
      // orchestrator validates the identifier as a username, so we pass it
      // through unchanged. On the 2FA step we resend the same credentials plus
      // the entered second factor — the orchestrator re-verifies both in one
      // call (PR #375). The password-only path stays a 2-arg call (no trailing
      // undefined) so it reads as the plain sign-in it is.
      if (mfaRequired) {
        const secondFactor =
          mfaMode === "recovery"
            ? { recoveryCode: recoveryCode.trim() }
            : { totp: totpCode.trim() };
        await login(email.trim(), password, secondFactor);
      } else {
        await login(email.trim(), password);
      }
      router.push(safeNext(searchParams.get("next")));
    } catch (err) {
      // PR #375: a correct password on a 2FA account rejects with the typed
      // TOTP_REQUIRED code. The FIRST time, reveal the code field (no error —
      // the user hasn't done anything wrong yet). If we're ALREADY on the
      // challenge step, the same rejection means the code they just entered was
      // wrong (or the account is now throttled), so show actionable copy.
      if (isTotpRequired(err)) {
        if (!mfaRequired) {
          setMfaRequired(true);
        } else {
          // Clear the rejected code so the stale value doesn't re-fire on Enter.
          if (mfaMode === "recovery") setRecoveryCode("");
          else setTotpCode("");
          setError(
            mfaMode === "recovery"
              ? "That recovery code didn't match. Try another saved code."
              : "That code didn't match. Check your authenticator app and try again.",
          );
        }
        return;
      }
      // On the 2FA challenge step the password field is gone, so the credential-
      // centric auth fallback ("check your username and password") would be
      // misleading for a non-TOTP failure. Coded errors (e.g. 429
      // TOO_MANY_ATTEMPTS) still get their precise copy via translateError; only
      // a codeless failure (e.g. a 500 during verify), which would otherwise hit
      // that password fallback, gets a neutral code-appropriate message.
      if (mfaRequired) {
        const hasCode = typeof (err as { code?: unknown })?.code === "string";
        setError(
          hasCode
            ? translateError(err, "auth")
            : "We couldn't verify that code right now. Try again in a moment.",
        );
        return;
      }
      // WARP-294: never render err.message verbatim — orchestrator may
      // surface terse strings like "OCS 401" / "connect ECONNREFUSED".
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  // Abandon the 2FA challenge and return to the credentials step (e.g. wrong
  // account). Clears the entered codes so they don't leak into a later attempt.
  function handleCancelMfa() {
    setMfaRequired(false);
    setMfaMode("totp");
    setTotpCode("");
    setRecoveryCode("");
    setError(null);
  }

  // Switch between the authenticator code and a saved recovery code. Clear any
  // stale "didn't match" error AND both code fields so the panel reads cleanly
  // — a half-typed code from the previous mode shouldn't linger (or silently
  // re-present a just-rejected code when toggling back).
  function handleToggleMfaMode() {
    setMfaMode((m) => (m === "totp" ? "recovery" : "totp"));
    setTotpCode("");
    setRecoveryCode("");
    setError(null);
  }

  // WARP-1054: the passkey button no longer runs the ceremony inline (which
  // left the user staring at the unchanged login form while the native sheet
  // ran). It navigates to the dedicated /login/passkey approval page, which
  // owns the whole ceremony — guidance, live status, cancel, retry, and the
  // post-verify redirect. Carry the RAW `?next=` through so the approval page
  // re-validates it with the same `safeNext` guard (don't pre-resolve here).
  function handlePasskeySignIn() {
    const rawNext = searchParams.get("next");
    router.push(
      "/login/passkey" +
        (rawNext ? `?next=${encodeURIComponent(rawNext)}` : ""),
    );
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your Droplet workspace."
      /* WARP-629: the local-first promise is true for the password path,
         but an SSO sign-in federates to an external IdP — so the copy is
         caveated whenever an SSO button is shown to stay accurate. */
      footer={
        ssoProviders.length > 0
          ? "Password sign-in happens on your local network. Single sign-on redirects to your provider."
          : "Sign-in happens on your local network — nothing leaves the box."
      }
    >
      {fromSetup && (
        <div className="flex items-center gap-2 bg-accent/10 text-accent rounded-lg px-4 py-3 mb-6">
          <Check size={16} className="flex-shrink-0" aria-hidden="true" />
          <p className="type-subheadline">
            Setup already completed. Sign in to access your dashboard.
          </p>
        </div>
      )}

      {/* PR #377: the passkey affordance lives inside SignInForm (one
          button, no duplication). Pass the handler only when the browser
          supports WebAuthn — otherwise the form omits the action entirely. */}
      <SignInForm
        email={email}
        password={password}
        showPassword={showPassword}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onTogglePassword={() => setShowPassword((s) => !s)}
        onSubmit={handleLogin}
        error={error}
        submitting={isSubmitting}
        // WARP-629: only the providers this appliance has configured,
        // discovered at runtime. Empty → password-only login.
        ssoProviders={ssoProviders}
        // ADR-013 (PR #378): SSO sign-in lands back on the originally
        // requested page. Reuse the same same-origin guard as the
        // password path so a crafted `?next=` can't redirect off-origin.
        returnTo={safeNext(searchParams.get("next"))}
        onPasskey={passkeyReady ? handlePasskeySignIn : undefined}
        // PR #375 — two-factor challenge. When mfaRequired the form swaps
        // the credential block for the code-entry panel.
        mfaRequired={mfaRequired}
        mfaMode={mfaMode}
        totpCode={totpCode}
        onTotpCodeChange={setTotpCode}
        recoveryCode={recoveryCode}
        onRecoveryCodeChange={setRecoveryCode}
        onToggleMfaMode={handleToggleMfaMode}
        onCancelMfa={handleCancelMfa}
      />
    </AuthLayout>
  );
}

/**
 * The login surface reads `?next=` / `?from=` via `useSearchParams()`. In the
 * App Router that requires a `<Suspense>` boundary — without one, Next opts the
 * whole route into a client-side-rendering bailout, so the page ships blank and
 * only paints after hydration (the "blank login until N refreshes" report, and
 * the "content only after a refresh" on client-side navigation). The boundary
 * lets the brand shell paint immediately while the search-param-dependent form
 * resolves on the same tick. Fallback mirrors the static chrome so there's no
 * spinner or flash on this public page.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout
          title="Welcome back"
          subtitle="Sign in to your Droplet workspace."
        >
          {null}
        </AuthLayout>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
