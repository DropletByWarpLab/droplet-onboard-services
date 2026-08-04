"use client";

import useSWR from "swr";
import { Cable } from "lucide-react";
import { fetchInterfaces, type NetworkInterfaceRow } from "@/lib/api";
import { InterfaceWriteControls } from "./InterfaceWriteControls";

/**
 * Interfaces (Droplet Design System · Network · System).
 *
 * Enumeration of every configured interface (name/device/proto/address/zone/
 * status) — not just lan/wan. Mirrors the FirewallTab read-table idiom. Honesty
 * rules:
 *  - a `present:false` interface (configured but with no live ubus object on
 *    this box — e.g. a single-box WAN handled by the host) renders an explicit
 *    "not on this box" state, NEVER a fabricated "down" row;
 *  - a null zone/address renders a dash placeholder, never a made-up value.
 *
 * KAN-10: the Add / Edit / Restart write path now rides the same blast-radius
 * safety the rest of the Network tab uses — owner/admin only, Tier-2/3 confirm,
 * routing-side safe_apply (60s auto-rollback), and an EXTRA confirm before a
 * write to the management interface (the one this dashboard is reached on). The
 * controls render only for an editor; for everyone else the table stays
 * read-only.
 */
function StatusChip({ up, present }: { up: boolean; present: boolean }) {
  if (!present) {
    return (
      <span className="type-caption-2 font-medium px-2 py-0.5 rounded-full bg-[var(--card-inner)] text-[color:var(--text-muted)]">
        Not on this box
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 type-caption-1 ${
        up ? "text-system-green" : "text-[color:var(--text-muted)]"
      }`}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          up ? "bg-system-green" : "bg-[var(--text-faint)]"
        }`}
        aria-hidden="true"
      />
      {up ? "Up" : "Down"}
    </span>
  );
}

export function InterfacesTable({
  canEdit = false,
  isOwner = false,
}: {
  /** owner/admin — may add + edit interfaces. */
  canEdit?: boolean;
  /** owner only — may also restart networking. */
  isOwner?: boolean;
} = {}) {
  const { data, isLoading, mutate } = useSWR<NetworkInterfaceRow[]>(
    "/api/network/interfaces",
    fetchInterfaces,
    { refreshInterval: 30000 },
  );

  const rows = data ?? [];

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Cable size={18} className="text-[color:var(--text-muted)]" aria-hidden="true" />
        <h3 className="type-headline text-[color:var(--text)]">Interfaces</h3>
      </div>
      <p className="type-caption-1 text-[color:var(--text-muted)] mb-4">
        {canEdit
          ? "Every network interface this appliance is configured with. Changes here can affect connectivity, so we confirm before applying."
          : "Every network interface this appliance is configured with."}
      </p>

      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full type-caption-1">
            <thead>
              <tr className="text-[color:var(--text-muted)] text-left">
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
                  className={`border-t border-[var(--card-bd)] ${
                    iface.present ? "" : "opacity-60"
                  }`}
                >
                  <td className="py-2 pr-4">
                    <span className="type-subheadline text-[color:var(--text)] font-medium">
                      {iface.name}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-[color:var(--text-muted)] font-mono">
                    {iface.device ?? "—"}
                  </td>
                  <td className="py-2 pr-4 text-[color:var(--text-muted)]">{iface.proto ?? "—"}</td>
                  <td className="py-2 pr-4 text-[color:var(--text-muted)] font-mono">
                    {iface.address ?? "—"}
                  </td>
                  <td className="py-2 pr-4 text-[color:var(--text-muted)]">{iface.zone ?? "—"}</td>
                  <td className="py-2">
                    <StatusChip up={iface.up} present={iface.present} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="type-subheadline text-[color:var(--text-muted)]">
          {isLoading ? "Loading interfaces…" : "No interfaces reported."}
        </p>
      )}

      <InterfaceWriteControls
        rows={rows}
        canEdit={canEdit}
        isOwner={isOwner}
        onApplied={() => void mutate()}
      />
    </div>
  );
}
