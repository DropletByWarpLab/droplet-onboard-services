"use client";

import { useState } from "react";
import { Network, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useSwitch } from "@/lib/hooks/useSwitch";
import { useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import type { SwitchPort } from "@/lib/types/switch";
import { PoeBudget } from "./PoeBudget";
import { Faceplate } from "./Faceplate";
import { PortTable } from "./PortTable";
import { VlanView } from "./VlanView";
import { SwitchPortDrawer } from "./SwitchPortDrawer";
import type { SwitchAction } from "./helpers";

type Layout = "face" | "table";

/**
 * WARP-2165 — describe the unit from its own ports.
 *
 * "8-port + 2 SFP" was hardcoded, which was the GS1900-10HP's layout printed
 * over every switch we ship. Falls back to a neutral phrase while the port
 * list is still loading rather than guessing a count.
 */
function portSummary(ports: { is_sfp: boolean }[]): string {
  if (ports.length === 0) return "port layout loading…";
  const sfp = ports.filter((p) => p.is_sfp).length;
  const copper = ports.length - sfp;
  return sfp > 0 ? `${copper}-port + ${sfp} SFP` : `${copper}-port`;
}

function lastAppliedLabel(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** The panel shell — always a Switch-labelled net-group + a bordered card. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="type-footnote font-semibold text-[color:var(--text-muted)]">Switch</h4>
      <div className="card relative">{children}</div>
    </div>
  );
}

/**
 * SwitchPanel — the managed-switch surface (ADDON §4.1). Container for the
 * header, the layout toggle + read-only LAN-profile reflection, the port map
 * (faceplate ↔ table), the VLAN view, the port drawer, and the write confirm.
 *
 * Bound to the §7 contract via useSwitch (PR-A backend; mocked in tests).
 */
export function SwitchPanel() {
  const { status, ports, vlans, isLoading, error, connected, changeVlan, togglePoe, setPortEnabled, reapplyConfig } =
    useSwitch();
  const { user } = useAuth();
  const { toast } = useToast();
  const canWrite = user?.role === "owner" || user?.role === "admin";

  const [layout, setLayout] = useState<Layout>("face");
  const [picked, setPicked] = useState<SwitchPort | null>(null);
  const [action, setAction] = useState<SwitchAction | null>(null);

  // Loading — reuse the page's pulse-card skeleton.
  if (isLoading && !status) {
    return (
      <Shell>
        <div data-testid="switch-skeleton" className="h-40 animate-pulse bg-[var(--inset)] rounded-[10px]" />
      </Shell>
    );
  }

  // Error — switch unreachable. Mirrors the page's error-card pattern.
  if (error && !connected) {
    return (
      <Shell>
        <div className="text-center py-10" role="alert">
          <WifiOff size={28} className="mx-auto text-[color:var(--text-faint)] mb-2" aria-hidden="true" />
          <p className="type-subheadline text-[color:var(--text)] mb-1">We can&apos;t reach the switch</p>
          <p className="type-footnote text-[color:var(--text-muted)] max-w-sm mx-auto">
            The managed switch isn&apos;t responding. We&apos;ll keep retrying — check the switch service and its LAN
            connection.
          </p>
        </div>
      </Shell>
    );
  }

  // Empty — no managed switch on this deployment (common). Calm, no blame.
  if (!connected || !status) {
    return (
      <Shell>
        <p className="text-center py-7 type-footnote text-[color:var(--text-muted)]">
          No managed switch detected. Ports appear here when a Droplet-managed switch is connected.
        </p>
      </Shell>
    );
  }

  const profile = status.vlan_profile;

  // Run the confirmed write through the matching useSwitch action.
  async function applyAction() {
    if (!action) return;
    try {
      if (action.kind === "vlan") await changeVlan(action.port.port, action.vlanId);
      else if (action.kind === "poe") await togglePoe(action.port.port, action.enabled);
      else if (action.kind === "enable") await setPortEnabled(action.port.port, action.enabled);
      else if (action.kind === "provision") await reapplyConfig();
    } catch (err) {
      // Surface the failure as a toast (mirrors DeviceDetailPanel's
      // translateError pattern); re-throw so ConfirmDialog stays open by
      // contract and the owner can retry. Without this a failed switch write
      // was silent — UX review finding on item 12 (PR-B).
      toast(translateError(err, "network"), "error");
      throw err;
    }
  }

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center gap-3.5 flex-wrap">
        <span className="w-[38px] h-[38px] rounded-[10px] bg-[var(--brand-subtle)] text-[color:var(--brand)] flex items-center justify-center flex-none">
          <Network size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="type-subheadline font-semibold text-[color:var(--text)] flex items-center gap-2.5">
            {/* WARP-1674: the driver owns vendor branding — the openwrt
                driver reports the board model verbatim (e.g. "Zyxel
                GS1900-10HP A1"). */}
            {status.model || "Managed switch"}
            {status.auto_managed && (
              <span className="inline-flex items-center gap-1.5 type-caption-2 font-medium text-system-green bg-system-green/10 px-2.5 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-system-green" aria-hidden="true" />
                Auto-managed
              </span>
            )}
          </div>
          <div className="type-caption-1 text-[color:var(--text-muted)] mt-0.5 font-mono">
            {/* WARP-2165: this used to read the literal "8-port + 2 SFP" on
                every unit — the layout of a GS1900-10HP. Count what the
                switch actually reports so an 8HP (no optical cage) is
                described correctly, and so the line stays right on whatever
                hardware ships next. */}
            PoE switch · {portSummary(ports)} · firmware {status.firmware} · applied{" "}
            {lastAppliedLabel(status.last_provisioned_at)}
          </div>
        </div>
        <PoeBudget usedW={status.poe_used_w} budgetW={status.poe_budget_w} activePorts={status.poe_ports_active} />
        {canWrite && (
          <button
            type="button"
            onClick={() =>
              setAction({
                kind: "provision",
                what: "Re-apply the managed switch layout?",
                blast: "Hand-edited ports snap back to the auto-managed layout. Devices on changed ports briefly drop.",
              })
            }
            className="btn sm ml-auto"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Re-apply config
          </button>
        )}
      </div>

      {/* Controls — interactive layout toggle + READ-ONLY profile reflection */}
      <div className="flex items-center gap-3 my-4 flex-wrap">
        <div className="pills" role="group" aria-label="Port map layout">
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
        <div className="grow" />
        {/* Read-only reflection of status.vlan_profile — NOT a user toggle. */}
        <span className="type-caption-2 text-[color:var(--text-muted)]">LAN profile</span>
        {/* `.pills` styles its own <button> children; these are inert <span>s
            (read-only reflection, not a control), so the active/idle ink is
            spelled out here against the same shell tokens. */}
        <div
          className="pills"
          role="status"
          aria-label={`LAN profile: ${profile === "segmented" ? "Segmented" : "Flat LAN"}`}
        >
          {(["flat-lan", "segmented"] as const).map((id) => (
            <span
              key={id}
              aria-current={profile === id ? "true" : undefined}
              className={[
                "type-caption-2 font-medium px-2.5 py-1.5 rounded-[7px]",
                profile === id
                  ? "bg-[var(--brand-subtle)] text-[color:var(--brand)]"
                  : "text-[color:var(--text-faint)]",
              ].join(" ")}
            >
              {id === "flat-lan" ? "Flat LAN" : "Segmented"}
            </span>
          ))}
        </div>
      </div>

      {/* Port map — faceplate is desktop-only; table is the mobile default. */}
      {layout === "face" ? (
        <>
          <div className="hidden md:block">
            <Faceplate ports={ports} onPick={setPicked} />
          </div>
          {/* Below md the faceplate collapses to the table. */}
          <div className="md:hidden">
            <PortTable ports={ports} onPick={setPicked} />
          </div>
        </>
      ) : (
        <PortTable ports={ports} onPick={setPicked} />
      )}

      {/* VLAN view */}
      <div className="flex items-baseline gap-2.5 mt-5 mb-2.5">
        <h5 className="type-footnote font-semibold text-[color:var(--text)] m-0">VLANs</h5>
        <span className="type-caption-2 text-[color:var(--text-muted)]">
          reflects switch <span className="font-mono">vlan_profile: {profile}</span>
        </span>
      </div>
      <VlanView profile={profile} vlans={vlans} />

      {/* Port drawer */}
      {picked && (
        <SwitchPortDrawer
          port={picked}
          profile={profile}
          canWrite={canWrite}
          protectedPort={status.protected_port}
          onClose={() => setPicked(null)}
          onAction={(a) => {
            setPicked(null);
            setAction(a);
          }}
        />
      )}

      {/* Write confirm — reuses <ConfirmDialog> with the orange Write chip. */}
      {action && (
        <ConfirmDialog
          open
          title={action.what}
          description={action.blast}
          confirmLabel="Confirm & apply"
          variant="neutral"
          accessory={
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-orange bg-system-orange/10 px-2 py-0.5 rounded-full">
                <ShieldCheck size={10} aria-hidden="true" />
                Write · confirm to apply
              </span>
              <span className="type-caption-2 text-[color:var(--text-muted)]">Owner / admin only · logged to Activity</span>
            </div>
          }
          onConfirm={applyAction}
          onCancel={() => setAction(null)}
        />
      )}
    </Shell>
  );
}
