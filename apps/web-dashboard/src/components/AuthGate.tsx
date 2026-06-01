"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { DropletMark } from "@/components/DropletMark";

const PUBLIC_PATHS = ["/setup", "/login"];

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, setupRequired, setupStatus, retrySetupCheck } =
    useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // WARP-577: an indeterminate setup probe must NEVER redirect — not to
  // /setup and not to /login. We hold the user on a connecting interstitial
  // and let the auth provider retry until it gets a definitive answer.
  const isConnecting = setupStatus === "unknown";

  useEffect(() => {
    if (isLoading) return;
    if (isConnecting) return;

    // If setup is required, redirect to setup page
    if (setupRequired && pathname !== "/setup") {
      router.replace("/setup");
      return;
    }

    // If setup is already done but user visits /setup, redirect to login.
    // setupRequired === false here means a CONFIRMED 'complete' (never the
    // indeterminate 'unknown', which is gated out above).
    if (setupRequired === false && pathname === "/setup") {
      router.replace("/login?from=setup");
      return;
    }

    // If not authenticated and not on a public page, redirect to login
    if (!user && !isPublicPage && !setupRequired) {
      router.replace("/login");
      return;
    }

    // If authenticated and on login/setup page, redirect to dashboard
    if (user && isPublicPage) {
      router.replace("/");
      return;
    }
  }, [
    user,
    isLoading,
    isConnecting,
    setupRequired,
    pathname,
    router,
    isPublicPage,
  ]);

  // WARP-577: orchestrator unreachable / transient error — show a connecting
  // state with a manual retry instead of bouncing into the first-run wizard
  // (or to login). Checked before the generic loading state so a 'Retry now'
  // attempt that flips isLoading back on still shows the connecting copy.
  if (isConnecting) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="text-center max-w-sm px-6">
          <div className="flex items-center justify-center mx-auto mb-3 animate-pulse">
            <DropletMark size={32} className="text-accent" aria-label="Droplet" />
          </div>
          <p className="type-subheadline text-label-primary">
            Connecting to your Droplet…
          </p>
          <p className="type-footnote text-label-tertiary mt-1">
            Your device may still be starting up. This will resolve
            automatically.
          </p>
          <button
            type="button"
            onClick={retrySetupCheck}
            className="mt-4 rounded-lg border border-separator px-4 py-2 type-subheadline text-label-secondary hover:bg-fill-quaternary transition-colors"
          >
            Retry now
          </button>
        </div>
      </div>
    );
  }

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
