"use client";

import { useState } from "react";
import {
  Laptop,
  Smartphone,
  Plus,
  Trash2,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import { PairDialog } from "./PairDialog";
import { useDeviceClients } from "@/lib/hooks/useDeviceClients";
import { revokeDeviceClient } from "@/lib/api";
import { useToast } from "@/components/Toast";
import type { DeviceClientInfo } from "@/lib/types";

function platformIcon(platform: DeviceClientInfo["platform"]): LucideIcon {
  if (platform === "ios" || platform === "android") return Smartphone;
  return Laptop;
}

function formatLastSeen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const delta = Math.floor((now - d.getTime()) / 1000);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Lists the current user's paired client devices with revoke controls.
 * Dropped into /devices above the Matter devices section. Tapping
 * "Pair new device" opens the QR + polling dialog.
 */
export function DeviceClientsSection() {
  const { items, isLoading, refresh } = useDeviceClients();
  const [pairOpen, setPairOpen] = useState(false);
  const { toast } = useToast();

  const handleRevoke = async (client: DeviceClientInfo) => {
    if (
      !confirm(
        `Revoke "${client.deviceName}"? It won't be able to sync until you pair it again.`
      )
    ) {
      return;
    }
    try {
      await revokeDeviceClient(client.id);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Revoke failed");
    }
  };

  const activeItems = items.filter((i) => i.status === "active");
  const revokedItems = items.filter((i) => i.status === "revoked");

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between px-1 mb-2">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider">
          Connected devices
        </h2>
        <button
          onClick={() => setPairOpen(true)}
          className="flex items-center gap-1 type-caption-1 text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={12} />
          Pair new device
        </button>
      </div>

      {isLoading && items.length === 0 && (
        <div className="dp-card py-10 text-center type-subheadline text-label-tertiary">
          Loading…
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="dp-card py-10 flex flex-col items-center justify-center text-label-tertiary">
          <Laptop size={28} className="mb-2 text-label-quaternary" />
          <p className="type-subheadline">No devices paired yet</p>
          <p className="type-caption-1 mt-1 text-label-quaternary text-center max-w-xs">
            Click <strong>Pair new device</strong> to connect a laptop or phone
            that can sync files with this Droplet.
          </p>
        </div>
      )}

      {activeItems.length > 0 && (
        <div className="dp-group">
          {activeItems.map((client) => {
            const Icon = platformIcon(client.platform);
            return (
              <div key={client.id} className="dp-row group">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Icon size={16} className="text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="type-callout text-label-primary truncate">
                      {client.deviceName}
                    </p>
                    <p className="type-caption-2 text-label-tertiary">
                      {client.platform} · {client.deviceType}
                      {client.appVersion ? ` · v${client.appVersion}` : ""}
                      {" · "}
                      <CircleDot
                        size={9}
                        className="inline text-system-green align-middle -mt-0.5 mr-1"
                      />
                      {formatLastSeen(client.lastSeen)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(client)}
                  className="p-1.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 opacity-0 group-hover:opacity-100 transition-all"
                  title="Revoke this device"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {revokedItems.length > 0 && (
        <details className="mt-3">
          <summary className="type-caption-1 text-label-tertiary cursor-pointer hover:text-label-primary">
            {revokedItems.length} revoked device
            {revokedItems.length === 1 ? "" : "s"}
          </summary>
          <div className="dp-group mt-2 opacity-60">
            {revokedItems.map((client) => {
              const Icon = platformIcon(client.platform);
              return (
                <div key={client.id} className="dp-row">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Icon size={14} className="text-label-tertiary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="type-footnote text-label-secondary truncate line-through">
                        {client.deviceName}
                      </p>
                      <p className="type-caption-2 text-label-tertiary">
                        Revoked · {formatLastSeen(client.lastSeen)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {pairOpen && (
        <PairDialog
          onClose={() => setPairOpen(false)}
          onPaired={() => {
            void refresh();
          }}
        />
      )}
    </section>
  );
}
