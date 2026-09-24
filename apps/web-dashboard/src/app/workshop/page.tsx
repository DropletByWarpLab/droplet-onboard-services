"use client";

/**
 * WARP-2925 → WARP-2974 (ADR-056) — Workshop (`/workshop`).
 *
 * Where a person gives the box a goal and follows the background run that
 * pursues it — and, since WARP-2896, where they have it build a CUSTOM TOOL
 * in a workspace of its own. WARP-2925 shipped this as stacked cards (a
 * form, a workspaces card, the WARP-2180 runs panel); WARP-2974 made it a
 * space: the chat surface's rail / transcript / composer layout with the
 * workspace as a context pane. The page itself only gates by role and hands
 * over to `WorkshopSpace`.
 *
 * Nothing renders before the role is known — the /admin/audit pattern. The
 * space's mount fetches (GET /api/agent-runs, /api/workspace, the schedules)
 * never fire before anyone knows who is asking.
 *
 * `?run=<id>` opens that run (the `/admin/audit` deep link forwards here);
 * `?workspace=<id>` opens that custom tool (`/workshop/<id>` forwards here).
 */

import { Suspense } from "react";
import { Hammer } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { WorkshopSpace } from "@/components/workshop/WorkshopSpace";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";

const SUB = "Give your Droplet a goal and let it work in the background, or have it build you a custom tool.";

function WorkshopSkeleton() {
  return (
    <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop" sub={SUB}>
      <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
        Loading…
      </div>
    </ShellPage>
  );
}

export default function WorkshopPage() {
  const { user, isLoading: authLoading } = useAuth();
  if (authLoading) return <WorkshopSkeleton />;
  if (!isAdminRole(user?.role)) {
    return (
      <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop" sub={SUB}>
        <div className="card" role="status">
          <p style={{ margin: 0, fontSize: 13 }}>Workshop is for the box&apos;s owner and admins. Ask them if you need a run started.</p>
        </div>
      </ShellPage>
    );
  }
  // useSearchParams must be read under a Suspense boundary (Next.js
  // app-router); the space reads it.
  return (
    <Suspense fallback={<WorkshopSkeleton />}>
      <WorkshopSpace />
    </Suspense>
  );
}
