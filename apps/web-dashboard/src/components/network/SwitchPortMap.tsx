"use client";

import { useSwitch } from "@/lib/hooks/useSwitch";
import { RefreshCw, Zap, ZapOff, Unplug, Cable } from "lucide-react";

/**
 * Visual port map for the managed switch (SM8TAT2SA: 8 copper PoE + 2 SFP).
 * Color-coded by status: green=linked+PoE, blue=linked, gray=no link, red=disabled.
 */
export function SwitchPortMap() {
  const { ports, poe, vlans, isLoading, error, refresh } = useSwitch();

  if (isLoading) {
    return (
      <div className="dp-card p-4">
        <div className="h-6 w-40 bg-surface-secondary rounded animate-pulse mb-4" />
        <div className="flex gap-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="w-14 h-20 bg-surface-secondary rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dp-card p-4">
        <div className="flex items-center gap-2 text-label-tertiary">
          <Unplug size={18} />
          <span className="type-subheadline">Switch not connected</span>
        </div>
      </div>
    );
  }

  // Merge PoE data into ports
  const poeMap = new Map(poe.map((p) => [p.port, p]));

  // Total PoE power
  const totalPower = poe.reduce((sum, p) => sum + (p.delivering ? p.power_mw : 0), 0);
  const totalBudget = poe.length > 0 ? poe[0].max_power_mw * poe.length : 240000;

  return (
    <div className="dp-card">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="type-headline text-label-primary">Switch Ports</h3>
            <p className="type-caption-1 text-label-tertiary">
              SM8TAT2SA &middot; {ports.filter((p) => p.link_up).length}/{ports.length} active
              {totalPower > 0 && ` \u00B7 PoE: ${(totalPower / 1000).toFixed(1)}W`}
            </p>
          </div>
          <button
            onClick={refresh}
            className="p-2 rounded-sm text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Port grid */}
        <div className="flex gap-2 overflow-x-auto pb-2">
          {ports.map((port) => {
            const poeInfo = poeMap.get(port.port);
            const isPoe = port.port <= 8;
            const isSfp = port.is_sfp;

            // Status color
            let bgColor = "bg-surface-secondary"; // no link
            let borderColor = "border-transparent";
            let statusText = "Down";

            if (!port.enabled) {
              bgColor = "bg-system-red/10";
              borderColor = "border-system-red/30";
              statusText = "Off";
            } else if (port.link_up) {
              if (poeInfo?.delivering) {
                bgColor = "bg-system-green/10";
                borderColor = "border-system-green/30";
                statusText = `${(poeInfo.power_mw / 1000).toFixed(1)}W`;
              } else {
                bgColor = "bg-accent/10";
                borderColor = "border-accent/30";
                statusText = port.speed || "Up";
              }
            }

            return (
              <div
                key={port.port}
                className={`flex flex-col items-center justify-between p-2 rounded-lg border ${bgColor} ${borderColor} min-w-[56px]`}
                title={`Port ${port.port}${isSfp ? " (SFP)" : ""} - ${port.link_up ? `Link up ${port.speed}` : "No link"}${poeInfo ? ` - PoE: ${poeInfo.delivering ? `${poeInfo.power_mw}mW` : "off"}` : ""} - VLAN ${port.vlan || 1}`}
              >
                {/* Port number */}
                <span className="type-caption-1 text-label-primary font-medium">
                  {port.port}
                </span>

                {/* Port icon */}
                <div className="my-1">
                  {isSfp ? (
                    <Cable size={16} className={port.link_up ? "text-accent" : "text-label-quaternary"} />
                  ) : poeInfo?.delivering ? (
                    <Zap size={16} className="text-system-green" />
                  ) : isPoe && port.link_up ? (
                    <ZapOff size={14} className="text-label-quaternary" />
                  ) : (
                    <div className={`w-3 h-3 rounded-full ${port.link_up ? "bg-accent" : "bg-label-quaternary/30"}`} />
                  )}
                </div>

                {/* Status */}
                <span className="type-caption-2 text-label-tertiary truncate max-w-full">
                  {statusText}
                </span>

                {/* VLAN tag */}
                {port.vlan && port.vlan !== 1 && (
                  <span className="type-caption-2 text-accent font-medium mt-0.5">
                    V{port.vlan}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex gap-4 mt-3 pt-3 border-t border-separator">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-system-green" />
            <span className="type-caption-2 text-label-tertiary">PoE active</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-accent" />
            <span className="type-caption-2 text-label-tertiary">Link up</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-label-quaternary/30" />
            <span className="type-caption-2 text-label-tertiary">No link</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Cable size={12} className="text-label-tertiary" />
            <span className="type-caption-2 text-label-tertiary">SFP</span>
          </div>
        </div>
      </div>
    </div>
  );
}
