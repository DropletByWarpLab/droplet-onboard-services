"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { DropletMark } from "@/components/DropletMark";

const PUBLIC_PATHS = ["/setup", "/login"];

export function AuthGate({ children }: { children: ReactNode }) {
  // PR #372 — route off the explicit `/setup/state` machine. The appliance
  // lifecycle ("unclaimed" | "ready") replaces the boolean `setupRequired`
  // that was derived from Nextcloud's `installed` flag.
  const { user, isLoading, setupState, setupProbeError, retrySetupProbe } =
    useAuth();
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

  useEffect(() => {
    if (isLoading) return;
    if (probeBlocked) return;

    // Unclaimed appliance → first-run wizard. The wizard itself hydrates
    // `setupState.setupStep` to resume at the right step (resumability).
    if (applianceUnclaimed && pathname !== "/setup") {
      router.replace("/setup");
      return;
    }

    // Appliance already claimed but the user is on /setup → bounce to login.
    if (!applianceUnclaimed && pathname === "/setup") {
      router.replace("/login?from=setup");
      return;
    }

    // NOTE (PR #372): the spec's "ready + tour pending → tour" branch is
    // intentionally NOT wired here — no /tour route ships on this branch
    // (the product tour is a separate, gated workstream). `setupState
    // .userTourCompleted` is plumbed through the context so that branch
    // slots in cleanly when the tour route lands, without a dead redirect
    // target today.

    // If not authenticated and not on a public page, redirect to login.
    if (!user && !isPublicPage && !applianceUnclaimed) {
      router.replace("/login");
      return;
    }

    // If authenticated and on login/setup page, redirect to dashboard.
    if (user && isPublicPage) {
      router.replace("/");
      return;
    }
  }, [user, isLoading, applianceUnclaimed, pathname, router, isPublicPage, probeBlocked]);

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="text-center">
          <div className="flex items-center justify-center mx-auto mb-3 animate-pulse">
            <DropletMark size={32} className="text-accent" aria-label="Droplet" />
          </div>
          <p className="type-subheadline text-label-tertiary">Loading...</p>
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
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="text-center max-w-sm px-6">
          <div className="flex items-center justify-center mx-auto mb-3">
            <DropletMark size={32} className="text-accent" aria-label="Droplet" />
          </div>
          <p className="type-headline text-label-primary mb-2">
            Can&apos;t reach your appliance
          </p>
          <p className="type-subheadline text-label-tertiary mb-4">
            {setupProbeError}
          </p>
          <button
            type="button"
            onClick={() => {
              void retrySetupProbe();
            }}
            className="rounded-full bg-accent px-5 py-2 text-on-accent type-subheadline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Public pages (setup, login) render without sidebar
  if (isPublicPage) {
    return <>{children}</>;
  }

  // Not authenticated — show nothing while redirecting
  if (!user) {
    return null;
  }

  // Authenticated — show sidebar + main content
  return (
    <>
      <Sidebar />
      <main
        id="main"
        tabIndex={-1}
        className="lg:ml-[260px] pb-[calc(56px_+_env(safe-area-inset-bottom))] lg:pb-0 min-h-dvh"
      >
        {children}
      </main>
    </>
  );
}
