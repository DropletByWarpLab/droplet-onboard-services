"use client";

import { useState } from "react";
import { Router, ShieldCheck, WifiOff } from "lucide-react";
import { useRouterPorts } from "@/lib/hooks/useRouterPorts";
import { useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { RouterPortRefusedError } from "@/lib/api";
import type { RouterPort } from "@/lib/types/router-ports";
import { RouterFaceplate } from "./RouterFaceplate";
import { RouterPortTable } from "./RouterPortTable";
import { RouterPortDrawer } from "./RouterPortDrawer";
import { linkSummary, type RouterAction } from "./helpers";

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
 * RouterPortsPanel — the router's physical port map (WARP-1866) and, since
 * WARP-1907, its write.
 *
 * The switch has had both since WARP-1674; the router only ever showed its
 * logical interfaces, so nothing in the product answered "which jacks are
 * live", and then nothing let you do anything about it. This panel now mirrors
 * SwitchPanel object for object — RBAC gate, drawer, ConfirmDialog with the
 * blast copy — because the two port maps sit one above the other on /network
 * and a router jack that behaved differently from a switch port would read as
 * a different kind of thing.
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
 *
 * The confirm escalates rather than branching: EVERY write takes the ordinary
 * blast-radius confirm, and a jack the server guarded takes a second,
 * destructive one on top. Only that second acknowledgement sends `force: true`
 * — the flag the routing service demands before it will cut the WAN or a live
 * management jack. Same shape as `../InterfaceWriteControls`, and for the same
 * reason: the extra confirm IS the acknowledgement, not a decoration on it.
 */
export function RouterPortsPanel() {
  const { map, isLoading, error, setPortEnabled } = useRouterPorts();
  const { user } = useAuth();
  const { toast } = useToast();
  const canWrite = user?.role === "owner" || user?.role === "admin";
  const [layout, setLayout] = useState<Layout>("face");
  const [picked, setPicked] = useState<RouterPort | null>(null);
  const [action, setAction] = useState<RouterAction | null>(null);
  const [escalated, setEscalated] = useState<RouterAction | null>(null);

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

  /**
   * Run the confirmed write. `force` is passed, never inferred: it is the
   * user's second acknowledgement, and a default would silently clear the
   * routing service's WAN guard for every write that reached here.
   *
   * A `RouterPortRefusedError` is not a failure to report — it is the server
   * telling us this jack needed the escalation after all. That happens for real:
   * `disable_guard` is read on a 10s poll, so a jack that was empty when the map
   * last loaded can have a cable in it by the time someone clicks. Raise the
   * same second confirm the drawer would have raised, from the server's own
   * words, instead of toasting "409" at someone who can then never succeed.
   */
  async function applyAction(a: RouterAction, force: boolean) {
    try {
      await setPortEnabled(a.port.id, a.enabled, force);
    } catch (err) {
      if (err instanceof RouterPortRefusedError && !force) {
        setEscalated({ ...a, guard: err.guard });
        return;
      }
      // Toast AND re-throw: ConfirmDialog's contract is to stay open on a
      // rejected confirm so the operator can retry, and a write that fails
      // silently is how someone walks away believing a jack is off.
      toast(translateError(err, "network"), "error");
      throw err;
    }
  }

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
              <RouterFaceplate ports={ports} onPick={setPicked} />
            </div>
            <div className="md:hidden">
              <RouterPortTable ports={ports} onPick={setPicked} />
            </div>
          </>
        ) : (
          <RouterPortTable ports={ports} onPick={setPicked} />
        )}
      </div>

      {/* Port drawer — opens for everyone; the ACTIONS inside are RBAC-gated. */}
      {picked && (
        <RouterPortDrawer
          port={picked}
          canWrite={canWrite}
          onClose={() => setPicked(null)}
          onAction={(a) => {
            setPicked(null);
            setAction(a);
          }}
        />
      )}

      {/* Step 1 — the ordinary Tier-2 blast-radius confirm, identical in shape
          to SwitchPanel's. */}
      {action && (
        <ConfirmDialog
          open
          title={action.what}
          description={action.blast}
          // On a guarded jack this button opens the second acknowledgement
          // rather than applying anything, so it must not promise to apply.
          confirmLabel={action.guard ? "Continue" : "Confirm & apply"}
          variant="neutral"
          accessory={
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-orange bg-system-orange/10 px-2 py-0.5 rounded-full">
                <ShieldCheck size={10} aria-hidden="true" />
                Write · confirm to apply
              </span>
              <span className="type-caption-2 text-[color:var(--text-muted)]">
                Owner / admin only · logged to Activity
              </span>
            </div>
          }
          onConfirm={async () => {
            const a = action;
            setAction(null);
            // A guarded jack does not apply here. The server refuses it without
            // `force`, and `force` is only ever the answer to the question
            // below — asked in the server's own words.
            if (a.guard) setEscalated(a);
            else await applyAction(a, false);
          }}
          onCancel={() => setAction(null)}
        />
      )}

      {/* Step 2 — the acknowledgement that IS `force: true`. The description is
          the routing service's `disable_guard.reason`, verbatim: the WAN and
          management refusals differ on whether anything puts the jack back, and
          re-writing either sentence here would be a second copy of a rule this
          client cannot see (DROPLET_MGMT_INTERFACES). */}
      {escalated?.guard && (
        <ConfirmDialog
          open
          title={
            escalated.guard.code === "WAN_PORT"
              ? "Take your home offline?"
              : "Cut the connection you're using?"
          }
          description={escalated.guard.reason}
          confirmLabel="I understand — turn it off"
          variant="destructive"
          onConfirm={async () => {
            const a = escalated;
            setEscalated(null);
            await applyAction(a, true);
          }}
          onCancel={() => setEscalated(null)}
        />
      )}
    </Shell>
  );
}
