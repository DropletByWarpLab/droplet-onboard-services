"use client";

/**
 * SwitchPortMap — read-only managed-switch surface for Network → System.
 *
 * Wires the existing `useSwitch` hook (ports / VLAN / PoE) into the dashboard
 * so the operator can see the switch the box is "replacing the router, switch,
 * NVR" with (FEATURES §2.6). Read-only by design — every switch *write* stays
 * on the orchestrator Tier-2 confirmation path (routes/switch.ts), so this
 * panel carries no controls and no safety chip (the 3-tier contract governs
 * write surfaces, §6).
 *
 * Link + PoE state are conveyed by icon + text, not color alone (WCAG 1.4.1).
 * Design tokens only — no hardcoded colors (dp-card, type-*, text-label-*,
 * system-green/orange).
 */

import { Network, Zap, ArrowUpFromLine } from "lucide-react";
import { useSwitch } from "@/lib/hooks/useSwitch";

interface SwitchPort {
  port: number;
  name: string;
  enabled: boolean;
  link_up: boolean;
  speed: string | null;
  duplex: string | null;
  is_sfp: boolean;
  vlan: number | null;
}

interface SwitchPoEPort {
  port: number;
  enabled: boolean;
  delivering: boolean;
  power_mw: number;
}

function watts(mw: number): string {
  return `${(mw / 1000).toFixed(1)} W`;
}

function PortTile({ port, poe }: { port: SwitchPort; poe?: SwitchPoEPort }) {
  // Link state drives the dominant affordance. Down ports recede (tertiary
  // label, muted surface); up ports read at full contrast with a green dot.
  const linkLabel = port.link_up ? "up" : "down";
  const kind = port.is_sfp ? "SFP" : "copper";
  const delivering = poe?.delivering && poe.power_mw > 0;

  return (
    <div
      aria-label={`Port ${port.port}, ${kind}, link ${linkLabel}${
        delivering ? `, PoE ${watts(poe!.power_mw)}` : ""
      }`}
      className={[
        "relative flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-2.5 text-center",
        port.link_up
          ? "border-separator bg-surface-secondary/60"
          : "border-separator/60 bg-surface-secondary/20",
      ].join(" ")}
    >
      {/* Link dot — paired with the text label below for non-color cue. */}
      <span
        aria-hidden="true"
        className={[
          "absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full",
          port.link_up ? "bg-system-green" : "bg-label-quaternary",
        ].join(" ")}
      />
      {port.is_sfp && (
        <ArrowUpFromLine
          size={11}
          aria-hidden="true"
          className="absolute left-1.5 top-1.5 text-label-tertiary"
        />
      )}
      <span
        className={[
          "font-mono type-subheadline tabular-nums",
          port.link_up ? "text-label-primary" : "text-label-tertiary",
        ].join(" ")}
      >
        {port.port}
      </span>
      {/* Sub-label is the only state text not duplicated elsewhere on the
          tile, so keep it at tertiary (>=4.5:1) rather than quaternary. */}
      <span className="type-caption-2 text-label-tertiary">
        {port.link_up ? port.speed ?? linkLabel : linkLabel}
      </span>
      {delivering && (
        <span className="inline-flex items-center gap-0.5 type-caption-2 text-system-green">
          <Zap size={10} aria-hidden="true" />
          {watts(poe!.power_mw)}
        </span>
      )}
    </div>
  );
}

export function SwitchPortMap() {
  const { ports, poe, vlans, isLoading, error } = useSwitch();

  const poeByPort = new Map<number, SwitchPoEPort>(
    (poe as SwitchPoEPort[]).map((p) => [p.port, p]),
  );
  const linkUpCount = (ports as SwitchPort[]).filter((p) => p.link_up).length;
  const poeActive = (poe as SwitchPoEPort[]).filter(
    (p) => p.delivering && p.power_mw > 0,
  ).length;

  return (
    <div className="dp-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network size={18} className="text-label-secondary" aria-hidden="true" />
          <h3 className="type-headline text-label-primary">Managed switch</h3>
        </div>
        {!isLoading && !error && ports.length > 0 && (
          <p className="type-caption-1 text-label-tertiary">
            {linkUpCount}/{ports.length} linked · {vlans.length} VLAN
            {vlans.length === 1 ? "" : "s"}
            {poeActive > 0 ? ` · ${poeActive} PoE` : ""}
          </p>
        )}
      </div>

      {/* Loading — port-grid-shaped skeleton so the layout doesn't jump. */}
      {isLoading && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-[68px] animate-pulse rounded-md bg-surface-secondary"
            />
          ))}
        </div>
      )}

      {/* Error — switch service unreachable / not connected. */}
      {!isLoading && error && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md bg-surface-secondary/50 px-3 py-3"
        >
          <Network size={16} className="text-label-quaternary" aria-hidden="true" />
          <p className="type-subheadline text-label-tertiary">
            The managed switch isn&apos;t reachable right now. Port and PoE
            status will appear once the switch service responds.
          </p>
        </div>
      )}

      {/* Connected-empty — reachable but reports no ports. */}
      {!isLoading && !error && ports.length === 0 && (
        <div className="flex items-center gap-2 rounded-md bg-surface-secondary/50 px-3 py-3">
          <Network size={16} className="text-label-quaternary" aria-hidden="true" />
          <p className="type-subheadline text-label-tertiary">
            No managed switch detected on this Droplet.
          </p>
        </div>
      )}

      {/* Port grid. */}
      {!isLoading && !error && ports.length > 0 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {(ports as SwitchPort[])
            .slice()
            .sort((a, b) => a.port - b.port)
            .map((p) => (
              <PortTile key={p.port} port={p} poe={poeByPort.get(p.port)} />
            ))}
        </div>
      )}
    </div>
  );
}
