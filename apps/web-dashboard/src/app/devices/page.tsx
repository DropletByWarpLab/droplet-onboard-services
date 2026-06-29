"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, Smartphone, Wifi, Cpu, ShieldCheck } from "lucide-react";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useSmartHomeEvents } from "@/lib/hooks/useSmartHomeEvents";
import { useScenes } from "@/lib/hooks/useScenes";
import { useMatterCommandConfirm } from "@/lib/hooks/useMatterCommandConfirm";
import { useAuth } from "@/lib/auth";
import { DeviceGroup } from "@/components/smart-home/DeviceGroup";
import { DiscoveryBanner } from "@/components/smart-home/DiscoveryBanner";
import { DeviceDetailPanel } from "@/components/smart-home/DeviceDetailPanel";
import { DeviceStats } from "@/components/smart-home/DeviceStats";
import { RoutinesSection } from "@/components/smart-home/RoutinesSection";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ShellPage } from "@/components/shell/ShellPage";
import type { MatterDevice } from "@/lib/types";

const SUB =
  "Lights, plugs, sensors and more paired over Matter — discovered and controlled locally on your Droplet.";

export default function DevicesPage() {
  const router = useRouter();
  const {
    grouped,
    discovered,
    totalDevices,
    isLoading,
    isRefreshing,
    error,
    command,
    refresh,
  } = useSmartHome();
  useSmartHomeEvents();
  const { scenes, refresh: refreshScenes } = useScenes();
  const { user } = useAuth();
  const canAuthor = user?.role === "owner" || user?.role === "admin";

  // KAN-5: a Tier-2 device write (lock/unlock, climate setpoint >= 30C) answers
  // confirmation_required instead of executing. `request` stages that, opening
  // the confirm dialog below; the device-control sibling of the chat confirm.
  const { pending, request, accept, cancel } = useMatterCommandConfirm(
    command,
    refresh,
  );
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [selectedDevice, setSelectedDevice] = useState<MatterDevice | null>(null);

  async function onConfirm() {
    setConfirmError(null);
    try {
      await accept();
    } catch (e) {
      // Keep the dialog open (ConfirmDialog swallows the throw) and surface why.
      setConfirmError(e instanceof Error ? e.message : "Couldn't apply that change.");
      throw e;
    }
  }

  const groups = grouped
    ? [
        { title: "Lights", devices: grouped.lights },
        { title: "Switches", devices: grouped.switches },
        { title: "Climate", devices: grouped.climate },
        { title: "Sensors", devices: grouped.sensors },
        { title: "Media", devices: grouped.media },
        { title: "Covers", devices: grouped.covers },
        { title: "Locks", devices: grouped.locks },
        { title: "Other", devices: grouped.other },
      ]
    : [];

  const actions = (
    <>
      {/* WARP-102: scan QR / commission a new Matter device. */}
      <button
        className="btn primary"
        onClick={() => router.push("/devices/add-matter")}
        title="Scan a Matter device QR code to add it"
        type="button"
      >
        <Plus size={15} />
        <span className="hidden sm:inline">Add device</span>
      </button>
      <button
        className="btn"
        onClick={() => router.push("/devices/clients")}
        title="Paired phones + laptops"
        type="button"
      >
        <Smartphone size={15} />
        <span className="hidden sm:inline">Paired apps</span>
      </button>
      <button
        className="icon-btn"
        onClick={refresh}
        disabled={isRefreshing}
        aria-label="Refresh devices"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage icon={<Cpu size={15} />} label="Devices" title="Devices" sub={SUB} actions={actions}>
      <div
        style={{ transition: "opacity 300ms", opacity: isRefreshing ? 0.6 : 1 }}
      >
        {isLoading ? (
          <div className="grid c3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card" style={{ height: 96, opacity: 0.5 }} />
            ))}
          </div>
        ) : error ? (
          <div className="card">
            <div className="empty">
              <span className="ei">
                <Wifi size={24} />
              </span>
              <span className="eh">Matter controller not available</span>
              <span>
                The Matter controller could not start. Check that the device has network access for
                mDNS discovery.
              </span>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <DiscoveryBanner count={discovered.length} />

            {/* KPI strip — lights / climate / locks / routines at a glance. */}
            {totalDevices > 0 && (
              <DeviceStats grouped={grouped} routineCount={scenes.length} />
            )}

            {groups.map((group) => (
              <DeviceGroup
                key={group.title}
                title={group.title}
                devices={group.devices}
                onCommand={request}
                onDeviceClick={setSelectedDevice}
              />
            ))}

            {/* Routines — list + one-tap run (confirm-gated). */}
            {totalDevices > 0 && (
              <RoutinesSection
                scenes={scenes}
                canAuthor={canAuthor}
                onChanged={refreshScenes}
              />
            )}

            {totalDevices === 0 && (
              <div className="card">
                <div className="empty">
                  <span className="ei">
                    <Wifi size={24} />
                  </span>
                  <span className="eh">No smart home devices yet</span>
                  <span>
                    Scan a Matter QR code to add your first device. Most plugs, lights, and switches
                    that say <em>“Works with Matter”</em> on the box will work.
                  </span>
                  <button
                    className="btn primary"
                    onClick={() => router.push("/devices/add-matter")}
                    type="button"
                    style={{ marginTop: 10 }}
                  >
                    <Plus size={16} /> Add your first device
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedDevice && (
        <DeviceDetailPanel
          device={selectedDevice}
          onCommand={request}
          onClose={() => setSelectedDevice(null)}
        />
      )}

      {/* KAN-5: Tier-2 device-write confirm — reuses <ConfirmDialog> with the
          same orange Write chip the network/switch Tier-2 writes use. */}
      {pending && (
        <ConfirmDialog
          open
          title="Confirm this device change?"
          description={pending.reason}
          confirmLabel="Confirm & apply"
          variant="neutral"
          accessory={
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1 type-caption-2 font-semibold text-system-orange bg-system-orange/10 px-2 py-0.5 rounded-full">
                <ShieldCheck size={10} aria-hidden="true" />
                Write · confirm to apply
              </span>
              <span className="type-caption-2 text-label-tertiary">
                Logged to Activity
              </span>
            </div>
          }
          onConfirm={onConfirm}
          onCancel={() => {
            setConfirmError(null);
            cancel();
          }}
        />
      )}

      {confirmError && (
        <div
          role="status"
          className="fixed bottom-4 right-4 bg-label-primary text-surface-primary px-3 py-2 rounded shadow flex items-center gap-2 z-50"
        >
          <span className="type-subheadline">{confirmError}</span>
          <button
            type="button"
            onClick={() => setConfirmError(null)}
            aria-label="Dismiss"
            className="ml-1 opacity-80 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}
    </ShellPage>
  );
}
