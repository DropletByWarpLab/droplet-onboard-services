"use client";

/**
 * WARP-2896 → WARP-2974 — `/workshop/<id>` forwards to the space.
 *
 * WARP-2896 gave every workspace a page of its own (five stacked cards);
 * WARP-2974 folded that into the Workshop's context pane, so the route now
 * only carries its deep link across: `/workshop?workspace=<id>` opens that
 * custom tool with the composer pointed at it. A malformed id forwards to
 * the bare Workshop rather than to a query it could never satisfy.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Hammer } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { forwardTarget } from "@/components/workshop/forward";

export default function WorkspaceForward() {
  const params = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const target = forwardTarget(params?.workspaceId);
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return (
    <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop">
      <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
        Opening the workspace…
      </div>
    </ShellPage>
  );
}
