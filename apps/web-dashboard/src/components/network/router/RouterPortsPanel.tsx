"use client";

import { useState } from "react";
import { Router, WifiOff } from "lucide-react";
import { useRouterPorts } from "@/lib/hooks/useRouterPorts";
import { RouterFaceplate } from "./RouterFaceplate";
import { RouterPortTable } from "./RouterPortTable";
import { linkSummary } from "./helpers";

type Layout = "face" | "table";

/** Always a Router-labelled net-group + a bordered card — matches SwitchPanel's
 *  Shell so the two port maps stack as siblings. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="type-footnote font-semibold text-[color:var(--text-muted)]">Router</h4>
      <div className="card relative">{children}</div>
    </div>
  );
}

/**
 * RouterPortsPanel — the router's physical port map (WARP-1866).
 *
 * The switch has had one since WARP-1674; the router only ever showed its
 * logical interfaces, so nothing in the product answered "which jacks are
 * live". Read-only by design: there is no write path to a router jack (see the
 * route comment in apps/orchestrator/src/routes/network-status.routes.ts), so
 * unlike SwitchPanel this panel has no RBAC gate, no drawer and no confirm.
 *
 * Four render paths, and the distinction between the last two is the point:
 *   - loading      → skeleton
 *   - error        → "we can't reach the router"       (we asked, nobody answered)
 *   - unsupported  → the server's own `detail` sentence (we asked, this shape
 *                    has no port map)
 *   - ports        → faceplate / table
 * An empty faceplate is never rendered for either of the middle two. Drawing
 * every jack dark would state, with the full confidence of the hardware view,
 * that the router has no cables in it.
 */
export function RouterPortsPanel() {
  const { map, isLoading, error } = useRouterPorts();
  const [layout, setLayout] = useState<Layout>("face");

  if (isLoading && !map) {
    return (
      <Shell>
        <div data-testid="router-ports-skeleton" className="h-40 animate-pulse bg-[var(--inset)] rounded-[10px]" />
      </Shell>
    );
  }

  if (error || !map) {
    return (
      <Shell>
        <div className="text-center py-10" role="alert">
          <WifiOff size={28} className="mx-auto text-[color:var(--text-faint)] mb-2" aria-hidden="true" />
          <p className="type-subheadline text-[color:var(--text)] mb-1">We can&apos;t reach the router</p>
          <p className="type-footnote text-[color:var(--text-muted)] max-w-sm mx-auto">
            The router isn&apos;t answering, so we can&apos;t show its ports. We&apos;ll keep retrying — check the
            routing service and the router&apos;s LAN connection.
          </p>
        </div>
      </Shell>
    );
  }

  if (!map.supported || map.ports.length === 0) {
    return (
      <Shell>
        <p className="text-center py-7 type-footnote text-[color:var(--text-muted)]">
          {map.detail ?? "This router doesn't report a physical port map."}
        </p>
      </Shell>
    );
  }

  const ports = map.ports;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center gap-3.5 flex-wrap">
        <span className="w-[38px] h-[38px] rounded-[10px] bg-[var(--brand-subtle)] text-[color:var(--brand)] flex items-center justify-center flex-none">
          <Router size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="type-subheadline font-semibold text-[color:var(--text)]">
            {/* The board reports its own model verbatim — no vendor string is
                hardcoded here, the same rule the switch panel follows. */}
            {map.model || "Edge router"}
          </div>
          <div className="type-caption-1 text-[color:var(--text-muted)] mt-0.5 font-mono">
            {linkSummary(ports)}
          </div>
        </div>

        {/* Layout toggle */}
        <div className="pills ml-auto" role="group" aria-label="Port map layout">
          {(["face", "table"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setLayout(id)}
              aria-pressed={layout === id}
              className={layout === id ? "active" : ""}
            >
              {id === "face" ? "Faceplate" : "Port table"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {/* Faceplate is desktop-only; the table is the mobile default. */}
        {layout === "face" ? (
          <>
            <div className="hidden md:block">
              <RouterFaceplate ports={ports} />
            </div>
            <div className="md:hidden">
              <RouterPortTable ports={ports} />
            </div>
          </>
        ) : (
          <RouterPortTable ports={ports} />
        )}
      </div>
    </Shell>
  );
}
