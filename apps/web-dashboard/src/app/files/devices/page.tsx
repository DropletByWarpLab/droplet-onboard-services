"use client";

import { useState } from "react";
import { Laptop, Plus, RefreshCw } from "lucide-react";
import { useDeviceClients } from "@/lib/hooks/useDeviceClients";
import { revokeDeviceClient } from "@/lib/api";
import { ClientDeviceCard } from "@/components/ClientDeviceCard";
import { ClientDetailPanel } from "@/components/ClientDetailPanel";
import { PairDialog } from "@/components/PairDialog";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { DeviceClientInfo } from "@/lib/types";

export default function SyncDevicesPage() {
  const { items, isLoading, isRefreshing, refresh } = useDeviceClients();
  const [selectedClient, setSelectedClient] = useState<DeviceClientInfo | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DeviceClientInfo | null>(null);
  const { toast } = useToast();

  const activeItems = items.filter((i) => i.status === "active");
  const revokedItems = items.filter((i) => i.status === "revoked");

  function handleRevoke(client: DeviceClientInfo) {
    setRevokeTarget(client);
  }

  async function performRevoke() {
    const client = revokeTarget;
    if (!client) return;
    try {
      await revokeDeviceClient(client.id);
      setRevokeTarget(null);
      await refresh();
      setSelectedClient(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Revoke failed");
      throw err;
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Sync Devices</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {activeItems.length > 0
              ? `${activeItems.length} device${activeItems.length !== 1 ? "s" : ""} paired`
              : "No devices paired"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPairOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg type-subheadline text-accent hover:text-accent-hover hover:bg-accent-subtle transition-colors"
          >
            <Plus size={16} />
            <span>Pair Device</span>
          </button>
          <button
            onClick={() => refresh()}
            disabled={isRefreshing}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <RefreshCw
              size={16}
              className={isRefreshing ? "animate-spin" : ""}
            />
            <span className="type-subheadline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Content with refresh fade */}
      <div
        className={`transition-opacity duration-300 ${isRefreshing ? "opacity-60" : "opacity-100"}`}
      >
        {/* Loading */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="dp-card h-24 animate-pulse bg-surface-secondary"
              />
            ))}
          </div>
        ) : (
          <>
            {/* Empty state */}
            {items.length === 0 && (
              <div className="dp-card text-center py-12">
                <Laptop
                  size={32}
                  className="mx-auto text-label-quaternary mb-3"
                />
                <h2 className="type-title-3 text-label-primary mb-1">
                  No devices paired yet
                </h2>
                <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
                  Pair a laptop or phone to sync files with this Droplet.
                  Click <strong>Pair Device</strong> to get started.
                </p>
              </div>
            )}

            {/* Active devices */}
            {activeItems.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeItems.map((client) => (
                  <ClientDeviceCard
                    key={client.id}
                    client={client}
                    onRevoke={handleRevoke}
                    onClick={() => setSelectedClient(client)}
                  />
                ))}
              </div>
            )}

            {/* Revoked devices */}
            {revokedItems.length > 0 && (
              <section className="mt-8 pt-6 border-t border-separator">
                <details>
                  <summary className="type-caption-1 text-label-tertiary cursor-pointer hover:text-label-secondary">
                    {revokedItems.length} revoked device
                    {revokedItems.length !== 1 ? "s" : ""}
                  </summary>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                    {revokedItems.map((client) => (
                      <ClientDeviceCard
                        key={client.id}
                        client={client}
                        onRevoke={handleRevoke}
                      />
                    ))}
                  </div>
                </details>
              </section>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selectedClient && (
        <ClientDetailPanel
          client={selectedClient}
          onRevoke={handleRevoke}
          onClose={() => setSelectedClient(null)}
        />
      )}

      {/* Pair dialog */}
      {pairOpen && (
        <PairDialog
          onClose={() => setPairOpen(false)}
          onPaired={() => {
            void refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onConfirm={performRevoke}
        onCancel={() => setRevokeTarget(null)}
        title={
          revokeTarget
            ? `Revoke "${revokeTarget.deviceName}"?`
            : "Revoke device?"
        }
        description="This device stops syncing files immediately. To use it again, pair it from the Pair Device flow."
        confirmLabel="Revoke"
        variant="destructive"
      />
    </div>
  );
}
