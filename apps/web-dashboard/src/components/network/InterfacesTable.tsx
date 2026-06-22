"use client";

import useSWR from "swr";
import { Cable } from "lucide-react";
import { fetchInterfaces, type NetworkInterfaceRow } from "@/lib/api";

/**
 * Interfaces (Droplet Design System · Network · System).
 *
 * Read-only enumeration of every configured interface (name/device/proto/
 * address/zone/status) — not just lan/wan. Mirrors the FirewallTab read-table
 * idiom. Honesty rules:
 *  - a `present:false` interface (configured but with no live ubus object on
 *    this box — e.g. a single-box WAN handled by the host) renders an explicit
 *    "not on this box" state, NEVER a fabricated "down" row;
 *  - a null zone/address renders a dash placeholder, never a made-up value.
 *
 * Adding/editing interfaces is intentionally NOT here: a generic interface
 * editor can rewrite /etc/config/network and cut the AP/LAN this dashboard rides
 * on (the single-box UCI-write hazard class) — deferred to a guarded,
 * connectivity-preserving design. There is no Restart-network button either; a
 * read table can't cut connectivity, and restart is its own owner-confirmed flow.
 */
function StatusChip({ up, present }: { up: boolean; present: boolean }) {
  if (!present) {
    return (
      <span className="type-caption-2 font-medium px-2 py-0.5 rounded-full bg-surface-secondary text-label-tertiary">
        Not on this box
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 type-caption-1 ${
        up ? "text-system-green" : "text-label-tertiary"
      }`}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          up ? "bg-system-green" : "bg-label-quaternary"
        }`}
        aria-hidden="true"
      />
      {up ? "Up" : "Down"}
    </span>
  );
}

export function InterfacesTable() {
  const { data, isLoading } = useSWR<NetworkInterfaceRow[]>(
    "/api/network/interfaces",
    fetchInterfaces,
    { refreshInterval: 30000 },
  );

  const rows = data ?? [];

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Cable size={18} className="text-label-tertiary" aria-hidden="true" />
        <h3 className="type-headline text-label-primary">Interfaces</h3>
      </div>
      <p className="type-caption-1 text-label-tertiary mb-4">
        Every network interface this appliance is configured with. Read-only —
        interfaces are set up during installation.
      </p>

      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full type-caption-1">
            <thead>
              <tr className="text-label-tertiary text-left">
                <th className="font-medium pb-2 pr-4">Name</th>
                <th className="font-medium pb-2 pr-4">Device</th>
                <th className="font-medium pb-2 pr-4">Protocol</th>
                <th className="font-medium pb-2 pr-4">Address</th>
                <th className="font-medium pb-2 pr-4">Zone</th>
                <th className="font-medium pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((iface) => (
                <tr
                  key={iface.name}
                  className={`border-t border-separator/60 ${
                    iface.present ? "" : "opacity-60"
                  }`}
                >
                  <td className="py-2 pr-4">
                    <span className="type-subheadline text-label-primary font-medium">
                      {iface.name}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-label-tertiary font-mono">
                    {iface.device ?? "—"}
                  </td>
                  <td className="py-2 pr-4 text-label-tertiary">{iface.proto ?? "—"}</td>
                  <td className="py-2 pr-4 text-label-tertiary font-mono">
                    {iface.address ?? "—"}
                  </td>
                  <td className="py-2 pr-4 text-label-tertiary">{iface.zone ?? "—"}</td>
                  <td className="py-2">
                    <StatusChip up={iface.up} present={iface.present} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="type-subheadline text-label-tertiary">
          {isLoading ? "Loading interfaces…" : "No interfaces reported."}
        </p>
      )}
    </div>
  );
}
