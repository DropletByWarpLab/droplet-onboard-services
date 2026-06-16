"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Check } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import { translateError } from "@/lib/friendly-errors";
import { AuroraPanel } from "@/components/auth/AuroraPanel";
import { SignInForm } from "@/components/auth/SignInForm";
// PR #377: passwordless passkey sign-in helpers.
import { isPasskeySupported, signInWithPasskey } from "@/lib/webauthn";
// WARP-629: runtime SSO discovery — the login shows only the IdPs this box has
// actually configured (local-first, SSO optional).
import { getEnabledSsoProviders } from "@/lib/api";

/**
 * Resolve a `?next=` redirect to a same-origin path, or fall back to "/".
 *
 * A plain `startsWith("/")` / `startsWith("//")` guard is unsafe: the WHATWG
 * URL parser (used by router.push → `new URL(next, origin)` in Next 14.2)
 * collapses `\` → `/` and strips leading tab/newline, so `/\evil.com`,
 * `/⇥/evil.com` and `/\n//evil.com` resolve to an off-origin authority *after*
 * a naive string check passes. Instead we resolve the candidate against a
 * sentinel origin and only honour it when its `.origin` is unchanged — then
 * return just the path+query+fragment so the caller never pushes an absolute
 * URL. Anything off-origin (incl. `//host`, `https:evil`, encoded variants) or
 * malformed falls back to "/".
 *
 * The sentinel-origin check is necessary but NOT sufficient: `..` resolution
 * can pop the empty leading path segment so the *resolved path itself* becomes
 * an authority while `.origin` stays the sentinel. `/..//evil.com` resolves to
 * `.pathname === "//evil.com"` with `.origin === SENTINEL` (the origin check
 * passes), and returning `//evil.com` lets the caller's `router.push` resolve
 * it against the *real* `location.origin` → off-origin nav. Re-checking the
 * origin can't catch this — under the sentinel `//evil.com` looks same-origin —
 * so we additionally reject any resolved path that opens with `//` or `/\`
 * (`/x/..//evil.com`, `/.//evil.com`, `/../\evil.com`, …) and fall back to "/".
 */
function safeNext(next: string | null): string {
  if (!next) return "/";
  const SENTINEL = "http://x.invalid";
  try {
    const u = new URL(next, SENTINEL);
    if (u.origin !== SENTINEL) return "/";
    const path = u.pathname + u.search + u.hash;
    // Reject a protocol-relative / authority-leading resolved path, which
    // router.push would otherwise resolve against the real location.origin.
    if (path.startsWith("//") || path.startsWith("/\\")) return "/";
    return path;
  } catch {
    return "/";
  }
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, setUserFromPasskey } = useAuth();
  const fromSetup = searchParams.get("from") === "setup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // PR #377: passkeys are an alternative passwordless path. The affordance is
  // only shown on browsers that support WebAuthn (detected client-side after
  // mount, so SSR renders nothing and we don't flash an unusable button).
  const [passkeyReady, setPasskeyReady] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
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
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Enter your work email and password to continue.");
      return;
    }

    setIsSubmitting(true);
    try {
      // The built-in directory keys on email in a later PR; today the
      // orchestrator validates the identifier as a username, so we pass it
      // through unchanged.
      await login(email.trim(), password);
      router.push(safeNext(searchParams.get("next")));
    } catch (err) {
      // WARP-294: never render err.message verbatim — orchestrator may
      // surface terse strings like "OCS 401" / "connect ECONNREFUSED".
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePasskeySignIn() {
    setError(null);
    setPasskeyBusy(true);
    try {
      const user = await signInWithPasskey();
      setUserFromPasskey(user);
      router.push("/");
    } catch {
      // Passkey-specific friendly copy — never echo the ceremony error (it can
      // carry transport details). Sentence case, no exclamation (copy rules).
      setError("We couldn't sign you in with that passkey. Try again, or use your password.");
    } finally {
      setPasskeyBusy(false);
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

          <h1 className="type-title-1 text-label-primary">Welcome back</h1>
          <p className="type-subheadline text-label-secondary mt-1.5 mb-6">
            Sign in to your Droplet workspace.
          </p>

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
            passkeyBusy={passkeyBusy}
          />

          {/* WARP-629: the local-first promise is true for the password path,
              but an SSO sign-in federates to an external IdP — so the copy is
              caveated whenever an SSO button is shown to stay accurate. */}
          <p className="type-caption-1 text-label-tertiary text-center mt-6 leading-relaxed">
            {ssoProviders.length > 0
              ? "Password sign-in happens on your local network. Single sign-on redirects to your provider."
              : "Sign-in happens on your local network — nothing leaves the box."}
          </p>
        </div>
      </div>
    </div>
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
        <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-surface-primary">
          <AuroraPanel className="hidden lg:flex" />
          <div className="flex items-center justify-center p-6 sm:p-10">
            <div className="w-full max-w-[380px]">
              <div className="lg:hidden flex items-center gap-2 mb-8">
                <DropletMark size={24} className="text-accent" />
                <span className="type-headline text-label-primary">Droplet</span>
              </div>
              <h1 className="type-title-1 text-label-primary">Welcome back</h1>
              <p className="type-subheadline text-label-secondary mt-1.5 mb-6">
                Sign in to your Droplet workspace.
              </p>
            </div>
          </div>
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
