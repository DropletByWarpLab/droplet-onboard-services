"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { DropletMark } from "@/components/DropletMark";

const PUBLIC_PATHS = ["/setup", "/login"];

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, setupRequired } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (isLoading) return;

    // If setup is required, redirect to setup page
    if (setupRequired && pathname !== "/setup") {
      router.replace("/setup");
      return;
    }

    // If setup is already done but user visits /setup, redirect to login
    if (!setupRequired && pathname === "/setup") {
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
  }, [user, isLoading, setupRequired, pathname, router, isPublicPage]);

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
