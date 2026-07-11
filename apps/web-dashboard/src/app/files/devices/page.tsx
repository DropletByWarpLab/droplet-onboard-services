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
import { translateError } from "@/lib/friendly-errors";
import type { DeviceClientInfo } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";

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
      toast(translateError(err, "files"));
      throw err;
    }
  }

  const actions = (
    <>
      <button onClick={() => setPairOpen(true)} className="btn primary" type="button">
        <Plus size={15} />
        Pair device
      </button>
      <button
        onClick={() => refresh()}
        disabled={isRefreshing}
        className="icon-btn"
        aria-label="Refresh"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Laptop size={15} />}
      label="Sync devices"
      title="Sync devices"
      sub={
        activeItems.length > 0
          ? `${activeItems.length} device${activeItems.length !== 1 ? "s" : ""} paired`
          : "No devices paired"
      }
      actions={actions}
    >
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
                className="card animate-pulse"
                style={{ height: 96, background: "var(--surface-2)" }}
              />
            ))}
          </div>
        ) : (
          <>
            {/* Empty state */}
            {items.length === 0 && (
              <div className="card">
                <div className="empty">
                  <span className="ei"><Laptop size={24} /></span>
                  <span className="eh">No devices paired yet</span>
                  <span style={{ maxWidth: "44ch" }}>
                    Pair a laptop or phone to sync files with this Droplet.
                    Click <strong>Pair device</strong> to get started.
                  </span>
                </div>
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
              <section className="mt-8 pt-6 border-t border-[color:var(--border)]">
                <details>
                  <summary className="type-caption-1 text-[color:var(--text-muted)] cursor-pointer hover:text-[color:var(--text)]">
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
    </ShellPage>
  );
}
