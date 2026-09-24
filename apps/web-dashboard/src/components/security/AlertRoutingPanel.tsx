"use client";

/**
 * WARP-2978 (ADR-059 P3 §8, D25, D26) — "Who's told about alerts", on
 * /security/settings.
 *
 * At manage — the module level (which fails closed) AND the box answering
 * with the whole list — one row per person: a switch, their role, a
 * `Manages the Security department` chip (a suggestion from the department
 * set-up; it grants nothing), and how they'd hear (a phone set up for
 * notifications, or only while Droplet is open). Someone who can't be told
 * (no access to Security, an inactive account, …) says why, and can't be
 * switched on; if they are still set to be told, their switch shows it and
 * can be switched OFF — the clean-up the box always allows (PR-B review B).
 * When nobody chosen can be told, the owners are told instead, and a banner
 * says so.
 *
 * Below manage: the viewer's own line only. The box decides what is listed
 * (route 21 is a filter by level, not a gate); this renders exactly that.
 *
 * A switch is written one at a time. While a write is in flight every switch
 * is aria-disabled — never `disabled`, so the pressed one keeps focus — and a
 * ref refuses a second press. The pressed switch shows the choice until the
 * box answers; a refusal (409 NO_RECIPIENT: the last person who can be told)
 * is a `translateError(err, "security")` toast, and the switch shows the
 * box's state again.
 */
import { useRef, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useAlertRouting } from "@/lib/hooks/useSecurity";
import type { AlertRoutingPerson } from "@/lib/types";
import { fill } from "./TimezoneSelect";

export const ROUTING_COPY = {
  title: "Who's told about alerts",
  explainer:
    "Droplet sends an alert when someone is seen in an area marked Inside or Staff only while the site is closed or set to away. Each person only hears about cameras they're allowed to see.",
  switchLabel: "Tell {name} about alerts",
  managesChip: "Manages the Security department",
  deliveryPush: "Notifications on their phone",
  deliveryInApp: "Only in Droplet while it's open",
  cantBeTold: {
    no_access: "Can't be told: no longer has access to Security",
    inactive: "Can't be told: this account isn't active",
    role: "Can't be told: this role can't open Security",
    no_address: "Can't be told: this account can't receive notifications",
  },
  cantBeToldUnknown: "Can't be told right now",
  fallback: "Nobody chosen can be told right now, so the owners are told instead.",
  selfTold: "You're told about alerts.",
  selfNotTold: "You're not told about alerts. People who manage Security choose who is.",
  loadError: "Droplet couldn't read who is told about alerts",
  loadErrorBody: "This doesn't mean nobody is told. Try again in a moment.",
  retry: "Retry",
  loading: "Loading who is told about alerts",
  roles: { owner: "Owner", admin: "Admin", family: "Family", guest: "Guest" },
} as const;

/** The page around the panel (a page file may not export its copy). */
export const SETTINGS_COPY = {
  pageTitle: "Security settings",
  pageSub: "When the site is normally open, and who's told about alerts.",
} as const;

function roleLabel(role: string): string {
  return (ROUTING_COPY.roles as Record<string, string>)[role] ?? role;
}

function cantBeTold(p: AlertRoutingPerson): string {
  return (p.ineligibleReason && (ROUTING_COPY.cantBeTold as Record<string, string>)[p.ineligibleReason]) || ROUTING_COPY.cantBeToldUnknown;
}

/** Eligible: either way. Not eligible: only OFF, and only while still set to be told. */
function switchable(p: AlertRoutingPerson): boolean {
  return p.eligible || p.state === "receiving";
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

export function AlertRoutingPanel() {
  const level = useModuleLevel("security");
  const { routing, error, refresh, set } = useAlertRouting();
  const { toast } = useToast();
  // The switch a write is in flight for, and the state it asked for.
  const [pending, setPending] = useState<{ userId: string; state: "receiving" | "not_receiving" } | null>(null);
  const busyRef = useRef(false);

  const toggle = async (p: AlertRoutingPerson) => {
    // Someone who can't be told can only be switched off.
    if (busyRef.current || !switchable(p)) return;
    busyRef.current = true;
    const next = p.state === "receiving" ? "not_receiving" : "receiving";
    setPending({ userId: p.userId, state: next });
    try {
      await set(p.userId, { state: next, expectedVersion: p.version });
    } catch (err) {
      // Typed copy only (409 NO_RECIPIENT / VERSION_CONFLICT, 422 NOT_ELIGIBLE, …) — never err.message.
      toast(translateError(err, "security"), "error");
      void refresh();
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  };

  let body: React.ReactNode;
  if (!routing && error) {
    body = (
      <div className="empty" role="alert" style={{ padding: "28px 12px" }}>
        <span className="eh">{ROUTING_COPY.loadError}</span>
        <span style={{ maxWidth: "48ch" }}>{ROUTING_COPY.loadErrorBody}</span>
        <button type="button" className="btn" onClick={() => void refresh()} style={{ marginTop: 8 }}>
          <RefreshCw size={16} aria-hidden />
          {ROUTING_COPY.retry}
        </button>
      </div>
    );
  } else if (!routing) {
    body = (
      <div className="empty" aria-busy="true" style={{ padding: "28px 12px" }}>
        <Loader2 size={20} className="animate-spin" aria-hidden />
        <span className="sr-only">{ROUTING_COPY.loading}</span>
      </div>
    );
  } else if (routing.level === "manage") {
    // Switches only when the module level says manage too: it fails closed.
    const canManage = levelAtLeast(level, "manage");
    body = (
      <>
        {routing.fallbackActive && (
          <p role="status" style={{ margin: "0 0 12px", display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--text)" }}>
            <span className="badge warn" aria-hidden style={{ flexShrink: 0 }}>
              <TriangleAlert size={12} />
            </span>
            <span>{ROUTING_COPY.fallback}</span>
          </p>
        )}
        <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {routing.people.map((p) => {
            const mine = pending?.userId === p.userId;
            const on = mine ? pending!.state === "receiving" : p.state === "receiving";
            const inert = pending !== null || !switchable(p);
            return (
              <li key={p.userId} className="lrow" data-user={p.userId} style={{ alignItems: "center" }}>
                <span className="ava" aria-hidden>
                  {initialsOf(p.name)}
                </span>
                <span className="rt">
                  <span className="nm" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    <span>{p.name}</span>
                    {p.managesSecurityDepartment && <span className="badge info">{ROUTING_COPY.managesChip}</span>}
                  </span>
                  <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    {[roleLabel(p.role), p.eligible ? (p.delivery === "push" ? ROUTING_COPY.deliveryPush : ROUTING_COPY.deliveryInApp) : cantBeTold(p)].join(" · ")}
                  </span>
                </span>
                {canManage && (
                  <button
                    type="button"
                    role="switch"
                    className={`sw${on ? " on" : ""}`}
                    aria-checked={on}
                    aria-label={fill(ROUTING_COPY.switchLabel, { name: p.name })}
                    // aria-disabled, not disabled: the pressed switch keeps focus while its write is in flight.
                    aria-disabled={inert || undefined}
                    style={inert ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                    onClick={() => void toggle(p)}
                  >
                    <span className="ball" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  } else {
    body = (
      <p style={{ margin: 0, fontSize: 14, color: "var(--text)" }} data-self-state={routing.self.state}>
        {routing.self.state === "receiving" && routing.self.eligible ? ROUTING_COPY.selfTold : ROUTING_COPY.selfNotTold}
      </p>
    );
  }

  return (
    <section className="card" data-testid="alert-routing">
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", maxWidth: "72ch" }}>{ROUTING_COPY.explainer}</p>
      {body}
    </section>
  );
}
