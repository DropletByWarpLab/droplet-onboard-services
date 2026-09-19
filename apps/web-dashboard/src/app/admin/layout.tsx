"use client";

/**
 * The console's one gate.
 *
 * Every page under /admin used to carry its own copy of the same
 * owner/admin check — four predicates, spelled two different ways, and four
 * different denial cards. They had already drifted: /admin/files had no
 * auth-hydration branch and rendered its real chrome to whoever asked while
 * the auth probe was in flight, where its three siblings showed "Loading…".
 *
 * CLIENT-SIDE ONLY, like the per-page checks it consolidates. This decides
 * what to render; the boundary is `requireRole("owner", "admin")` in the
 * orchestrator, which every route under here enforces independently. A
 * person who edits their way past this layout gets 403s, not data.
 *
 * The gate is deliberately BARE on the allowed path: each page under /admin
 * renders its own ShellPage with its own icon, label and status chip, so a
 * ShellPage here would double-wrap them. The refused path has no children to
 * collide with, so it wraps its own.
 */

import type { ReactNode } from "react";
import { ShieldOff } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";

const ICON = <ShieldOff size={15} />;

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();

  // Hydrating. Render neutral chrome rather than the page — this is the
  // branch /admin/files was missing.
  if (isLoading) {
    return (
      <ShellPage icon={ICON} label="Console" title="Console">
        <div
          className="card"
          aria-busy="true"
          style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}
        >
          Loading…
        </div>
      </ShellPage>
    );
  }

  if (!isAdminRole(user?.role)) {
    return (
      <ShellPage icon={ICON} label="Console" title="Console">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span>
              The console is where this Droplet is configured, so it is limited
              to <code>owner</code> and <code>admin</code>. Ask an admin if you
              need access.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return <>{children}</>;
}
