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
  const { user, isLoading, setupState } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // The appliance still needs claiming when setup state has loaded and
  // reports "unclaimed". Treat an unresolved (null) state as "not unclaimed"
  // so a transient `/setup/state` failure can't trap the user in the wizard.
  const applianceUnclaimed = setupState?.appliance === "unclaimed";

  useEffect(() => {
    if (isLoading) return;

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
  }, [user, isLoading, applianceUnclaimed, pathname, router, isPublicPage]);

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
