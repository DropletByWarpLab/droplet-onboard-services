"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { ModuleRouteGuard } from "@/components/ModuleRouteGuard";
import { DropletMark } from "@/components/DropletMark";
import { HelpLauncher } from "@/components/help/HelpLauncher";
import { HELP_PATH } from "@/lib/routing";

// `/invite` is public: an invite link goes to a brand-new, NOT-yet-authenticated
// person so they can set their password at `/invite/<token>`. Omitting it made
// AuthGate treat the page as protected and bounce the invitee to `/login` on a
// claimed box (appliance "ready"), so the link "just goes to the sign-in page"
// and they can never set a password. `startsWith` is safe — `/invite` is the
// only route under that prefix.
const PUBLIC_PATHS = ["/setup", "/login", "/invite"];

// WARP-1079 — AuthGate renders ABOVE every page scope (`.droplet-shell`,
// `.droplet-home`, the auth pages), so its full-screen loading / probe-error
// states can't resolve the shell's CSS variables. The literal hexes below are
// the indigo ramp from `components/shell/indigo-tokens.css`, kept in lockstep
// by hand (light / dark): bg #f5f6fb / #0f1117, text #1b1e2b / #e4e4e7,
// text-muted #6b7180 / #8a8a94, brand #6366f1 / #818cf8.
const GATE_BG = "bg-[#f5f6fb] dark:bg-[#0f1117]";
const GATE_TEXT = "text-[#1b1e2b] dark:text-[#e4e4e7]";
const GATE_TEXT_MUTED = "text-[#6b7180] dark:text-[#8a8a94]";
const GATE_BRAND_TEXT = "text-[#6366f1] dark:text-[#818cf8]";
const GATE_BRAND_BG = "bg-[#6366f1] dark:bg-[#818cf8]";

export function AuthGate({ children }: { children: ReactNode }) {
  // PR #372 — route off the explicit `/setup/state` machine. The appliance
  // lifecycle ("unclaimed" | "ready") replaces the boolean `setupRequired`
  // that was derived from Nextcloud's `installed` flag.
  const {
    user,
    isLoading,
    setupState,
    setupProbeError,
    setupAutoRetrying,
    retrySetupProbe,
  } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // The appliance still needs claiming when setup state has loaded and
  // reports "unclaimed". Treat an unresolved (null) state as "not unclaimed"
  // so a transient `/setup/state` failure can't trap the user in the wizard.
  const applianceUnclaimed = setupState?.appliance === "unclaimed";

  // M3 — when the lifecycle probe failed and we have no appliance state on a
  // protected page, we render an explicit error/retry (below) instead of
  // routing off a guess. Suppress the routing effect in that case so we
  // don't silently bounce the user (e.g. to /login) before they can retry.
  const probeBlocked =
    setupProbeError !== null && setupState === null && !isPublicPage;

  // WARP-824 — forced password change. An admin-created user signs in with a
  // temporary password and carries an explicit `mustChangePassword` flag (read
  // fresh from the row by /auth/me). They must replace it before reaching any
  // other surface. We require an explicit `true` so a profile that predates
  // the field (no flag) is never trapped here. This takes precedence over the
  // tour below — the user can't do anything useful until the temp password is
  // gone. The server-side gate enforces the same rule regardless of the client.
  const forcePasswordChange = user?.mustChangePassword === true;

  // Tour gate: the appliance is claimed ("ready") but the post-setup product
  // tour hasn't been completed yet. We require an explicit `false` (not just
  // a falsy/unresolved state) so a transient `/setup/state` failure leaves
  // `setupState` null and can't shove an authenticated user into the tour
  // on every cold load. The tour only makes sense once the owner exists, so
  // we also gate on `user`.
  const tourPending =
    setupState?.appliance === "ready" &&
    setupState.userTourCompleted === false;

  useEffect(() => {
    if (isLoading) return;
    if (probeBlocked) return;

    // Unclaimed appliance → first-run wizard. The wizard itself hydrates
    // `setupState.setupStep` to resume at the right step (resumability).
    // WARP-930 — /help is exempt: each wizard step's "Learn more" links to
    // /help#<anchor>, and during the unclaimed phase that navigation would
    // otherwise bounce straight back to /setup (the link "does nothing", and a
    // same-tab bounce remounts the wizard and wipes the in-progress form). The
    // help page renders standalone below for the unclaimed/anonymous case.
    if (
      applianceUnclaimed &&
      pathname !== "/setup" &&
      pathname !== HELP_PATH
    ) {
      router.replace("/setup");
      return;
    }

    // Appliance already claimed and an ANONYMOUS visitor is on /setup →
    // bounce to login. Guarded on !user: the wizard signs the owner in at the
    // account step (the context adopts that session), so an authenticated
    // user on /setup is the wizard itself — most importantly the Done screen,
    // which flips the appliance ready while it plays the flourish + embedded
    // tour. Bouncing on appliance-state alone yanked the owner to
    // /login?from=setup mid-celebration and re-asked for the password they
    // chose a minute earlier.
    if (!user && !applianceUnclaimed && pathname === "/setup") {
      router.replace("/login?from=setup");
      return;
    }

    // If not authenticated and not on a public page, redirect to login.
    if (!user && !isPublicPage && !applianceUnclaimed) {
      router.replace("/login");
      return;
    }

    // WARP-824 — an authenticated must-change user is pinned to
    // /change-password until they replace the temporary password. Runs BEFORE
    // the tour branch (the temp password is a hard block) and only when
    // they're not already there. A public page (login/setup) owns its own
    // flow, so we don't yank them off it.
    if (user && forcePasswordChange && !isPublicPage && pathname !== "/change-password") {
      router.replace("/change-password");
      return;
    }

    // The flag cleared (password changed) but the user is still parked on
    // /change-password → let them into the dashboard.
    if (user && !forcePasswordChange && pathname === "/change-password") {
      router.replace("/");
      return;
    }

    // PR #382 — the spec's "ready + tour pending → tour" branch (plumbed but
    // left unwired by #372). An authenticated owner on a claimed appliance
    // who hasn't finished the post-setup tour is routed to /tour. We only
    // redirect when they're NOT already there and NOT on a public page
    // (login/setup own their own flow), so the tour shows exactly once and
    // refreshing mid-tour lands back on /tour rather than the dashboard.
    if (user && !forcePasswordChange && tourPending && !isPublicPage && pathname !== "/tour") {
      router.replace("/tour");
      return;
    }

    // Tour already complete but the user is parked on /tour (e.g. they
    // finished it in another tab, or hit /tour directly) → let them into the
    // dashboard. Replaying the tour later goes through the Help page's
    // explicit trigger, not this route.
    if (user && !tourPending && pathname === "/tour") {
      router.replace("/");
      return;
    }

    // If authenticated and on login/setup page, redirect to dashboard —
    // but ONLY once the appliance is claimed. The wizard authenticates the
    // owner at the account step (auto-login), so while the appliance is
    // still "unclaimed" an authenticated user on /setup is the NORMAL
    // mid-wizard state, not a stray sign-in. Bouncing them to "/" here while
    // the unclaimed branch above bounces "/" straight back to /setup was an
    // infinite redirect loop on every mid-wizard refresh after the account
    // step (WARP-867). /setup stays the stable home until the finish PATCH
    // flips the appliance ready; an authenticated user on /login with an
    // unclaimed box is routed into the wizard by the first branch above.
    // …and not while the wizard's Done screen owns the viewport: the finish
    // PATCH flips the appliance ready while the owner is still on /setup
    // watching the flourish + EMBEDDED tour (DoneStep phase machine). While
    // the tour is pending, /setup is that screen — leave it alone; when the
    // tour completes, ProductTour itself navigates to "/" (and this branch
    // re-fires harmlessly toward the same target). /login is deliberately NOT
    // excepted: an authenticated user parked there still belongs on the
    // dashboard, where the tour gate routes them onward.
    const onWizardDoneScreen = pathname === "/setup" && tourPending;
    if (user && isPublicPage && !applianceUnclaimed && !onWizardDoneScreen) {
      router.replace("/");
      return;
    }
  }, [
    user,
    isLoading,
    applianceUnclaimed,
    forcePasswordChange,
    tourPending,
    pathname,
    router,
    isPublicPage,
    probeBlocked,
  ]);

  // Public pages (login, setup) render WITHOUT being blocked by the
  // session/setup-state probes. This MUST run before the `isLoading` gate
  // below: AuthProvider.init() flips `isLoading` false only after its probes
  // resolve, so gating /login on `isLoading` left the login form blank on a
  // cold/slow/hung backend ("takes ~5 refreshes"). A public page has nothing
  // to gate — it shows the same content whether or not auth has resolved — so
  // it paints on first render. The redirect effect above still early-returns
  // while `isLoading`, so an authenticated user already on /login isn't
  // bounced before the probe settles; once it does, the `user && isPublicPage`
  // branch routes them to the dashboard.
  if (isPublicPage) {
    return <>{children}</>;
  }

  // Loading state — protected surfaces only. We still hold protected content
  // behind the spinner until auth resolves so we never flash a protected page
  // (or its data) to an unauthenticated viewer.
  if (isLoading) {
    return (
      <div className={`min-h-screen ${GATE_BG} flex items-center justify-center`}>
        <div className="text-center">
          <div className="flex items-center justify-center mx-auto mb-3 animate-pulse">
            <DropletMark size={32} className={GATE_BRAND_TEXT} aria-label="Droplet" />
          </div>
          <p className={`type-subheadline ${GATE_TEXT_MUTED}`}>Loading...</p>
        </div>
      </div>
    );
  }

  // M3 (PR #372 re-review) — the lifecycle probe failed and we have no
  // appliance state to route off. Rather than fail open silently (guess
  // "ready" and bounce a first-run owner to /login on an unclaimed box), and
  // only when we're not already on a public page, surface an EXPLICIT error
  // with a retry. A public page (/setup, /login) still renders so a deep-link
  // isn't blocked behind a transient probe failure.
  if (probeBlocked) {
    // WARP-667 — while a bounded cold-boot auto-retry is still pending, show a
    // calm "Reconnecting…" state (the box is usually just warming up) rather
    // than immediately flashing an error + manual Retry. Once the auto-retries
    // are exhausted we fall back to the explicit error + Retry affordance.
    return (
      <div className={`min-h-screen ${GATE_BG} flex items-center justify-center`}>
        <div
          role="status"
          aria-live="polite"
          className="text-center max-w-sm px-6"
        >
          <div
            className={`flex items-center justify-center mx-auto mb-3${
              setupAutoRetrying ? " animate-pulse motion-reduce:animate-none" : ""
            }`}
          >
            {/* Decorative — the role="status" region + headline carry the
                spoken status, so the mark stays out of the a11y tree (it sits
                next to "…your Droplet" / the error copy). */}
            <DropletMark size={32} className={GATE_BRAND_TEXT} />
          </div>
          {setupAutoRetrying ? (
            <>
              <p className={`type-headline ${GATE_TEXT} mb-2`}>
                Reconnecting to your Droplet…
              </p>
              <p className={`type-subheadline ${GATE_TEXT_MUTED} mb-4`}>
                Your Droplet is starting up. This can take a few seconds on the
                first boot.
              </p>
            </>
          ) : (
            <>
              <p className={`type-headline ${GATE_TEXT} mb-2`}>
                Can&apos;t reach your appliance
              </p>
              <p className={`type-subheadline ${GATE_TEXT_MUTED} mb-4`}>
                {setupProbeError}
              </p>
              <button
                type="button"
                onClick={() => {
                  void retrySetupProbe();
                }}
                className={`rounded-full ${GATE_BRAND_BG} px-5 py-2 text-white type-subheadline`}
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // WARP-930 — /help must be reachable DURING setup (the LearnMoreCard "Learn
  // more" links on every wizard step point at /help#<anchor>). While the
  // appliance is UNCLAIMED (the only setup phase — covers both the anonymous
  // claim step and the signed-in owner mid-wizard), render the help page
  // standalone (no sidebar chrome — the wizard owns the look) instead of
  // bouncing to /setup. A claimed appliance falls through: authed users get the
  // normal sidebar render below (post-setup /help unchanged), and an anonymous
  // visitor hits the return-null-while-redirecting path (no early help paint).
  // Gated on `applianceUnclaimed` (not `!user`) so a claimed-box logged-out
  // visitor doesn't briefly see the manual before the /login redirect.
  if (pathname === HELP_PATH && applianceUnclaimed) {
    return <>{children}</>;
  }

  // Not authenticated — show nothing while redirecting
  if (!user) {
    return null;
  }

  // The post-setup tour is an authenticated, full-screen takeover (like the
  // wizard) — render it without the sidebar/main chrome so the walkthrough
  // owns the viewport. It still requires `user`, unlike PUBLIC_PATHS.
  if (pathname === "/tour") {
    return <>{children}</>;
  }

  // WARP-824 — the forced password-change screen is the same kind of
  // authenticated, full-screen takeover: no sidebar/main chrome so the
  // change form owns the viewport (matches the /login + /setup look). It
  // requires `user` (it's the signed-in temp-password handoff), unlike the
  // public login page.
  if (pathname === "/change-password") {
    return <>{children}</>;
  }

  // Authenticated — show sidebar + main content, plus the persistent help
  // launcher (Onboarding-Flow redesign §4). It mounts here, in the authenticated
  // branch only, so it never appears on the wizard, login, the full-screen tour,
  // or the change-password takeover (each returns earlier).
  //
  // WARP-1528 (nav-gate gap c): the module route guard wraps the page content
  // INSIDE the shell — a person who deep-links into a feature they can't open
  // keeps their nav and can walk away, instead of landing on a page shell that
  // renders fully and then fails request by request. It sits below every
  // earlier takeover branch on purpose: setup, tour and change-password own
  // their own routing and must never be second-guessed by a feature gate.
  return (
    <>
      <Sidebar />
      <main
        id="main"
        tabIndex={-1}
        className="lg:ml-[260px] pb-[calc(56px_+_env(safe-area-inset-bottom))] lg:pb-0 min-h-dvh"
      >
        <ModuleRouteGuard>{children}</ModuleRouteGuard>
      </main>
      <HelpLauncher />
    </>
  );
}
