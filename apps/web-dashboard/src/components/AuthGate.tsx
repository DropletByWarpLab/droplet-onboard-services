"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { Droplets } from "lucide-react";

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
          <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mx-auto mb-3 animate-pulse">
            <Droplets size={24} className="text-accent" />
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
      <main className="lg:ml-[260px] pb-[84px] lg:pb-0 min-h-screen">
        {children}
      </main>
    </>
  );
}
