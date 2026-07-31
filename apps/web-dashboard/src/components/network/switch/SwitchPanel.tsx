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
      <h4 className="type-footnote font-semibold text-label-secondary">Switch</h4>
      <div className="dp-card relative">{children}</div>
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
        <div data-testid="switch-skeleton" className="h-40 animate-pulse bg-surface-secondary rounded-[10px]" />
      </Shell>
    );
  }

  // Error — switch unreachable. Mirrors the page's error-card pattern.
  if (error && !connected) {
    return (
      <Shell>
        <div className="text-center py-10" role="alert">
          <WifiOff size={28} className="mx-auto text-label-quaternary mb-2" aria-hidden="true" />
          <p className="type-subheadline text-label-primary mb-1">We can&apos;t reach the switch</p>
          <p className="type-footnote text-label-tertiary max-w-sm mx-auto">
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
        <p className="text-center py-7 type-footnote text-label-tertiary">
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
        <span className="w-[38px] h-[38px] rounded-[10px] bg-accent-subtle text-accent flex items-center justify-center flex-none">
          <Network size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="type-subheadline font-semibold text-label-primary flex items-center gap-2.5">
            {/* WARP-1674: the driver owns vendor branding — the Lantronix
                driver reports "Lantronix SM8TAT2SA", the openwrt driver the
                board model ("Zyxel GS1900-10HP A1"). */}
            {status.model || "Managed switch"}
            {status.auto_managed && (
              <span className="inline-flex items-center gap-1.5 type-caption-2 font-medium text-system-green bg-system-green/10 px-2.5 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-system-green" aria-hidden="true" />
                Auto-managed
              </span>
            )}
          </div>
          <div className="type-caption-1 text-label-tertiary mt-0.5 font-mono">
            PoE switch · 8-port + 2 SFP · firmware {status.firmware} · applied{" "}
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
            className="dp-btn-secondary text-sm flex items-center gap-2 ml-auto"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Re-apply config
          </button>
        )}
      </div>

      {/* Controls — interactive layout toggle + READ-ONLY profile reflection */}
      <div className="flex items-center gap-3 my-4 flex-wrap">
        <div className="inline-flex bg-surface-secondary rounded-[9px] p-0.5 gap-0.5" role="group" aria-label="Port map layout">
          {(["face", "table"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setLayout(id)}
              aria-pressed={layout === id}
              className={[
                "type-caption-2 font-medium px-3.5 py-1.5 rounded-[7px] transition-colors",
                layout === id
                  ? "bg-surface-primary text-label-primary shadow-sm"
                  : "text-label-secondary hover:text-label-primary",
              ].join(" ")}
            >
              {id === "face" ? "Faceplate" : "Port table"}
            </button>
          ))}
        </div>
        <div className="grow" />
        {/* Read-only reflection of status.vlan_profile — NOT a user toggle. */}
        <span className="type-caption-2 text-label-tertiary">LAN profile</span>
        <div
          className="inline-flex bg-surface-secondary rounded-[9px] p-0.5 gap-0.5"
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
                  ? "bg-surface-primary text-label-primary shadow-sm"
                  : "text-label-quaternary",
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
        <h5 className="type-footnote font-semibold text-label-primary m-0">VLANs</h5>
        <span className="type-caption-2 text-label-tertiary">
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
              <span className="type-caption-2 text-label-tertiary">Owner / admin only · logged to Activity</span>
            </div>
          }
          onConfirm={applyAction}
          onCancel={() => setAction(null)}
        />
      )}
    </Shell>
  );
}
