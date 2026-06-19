"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, Smartphone, Wifi, Cpu } from "lucide-react";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useSmartHomeEvents } from "@/lib/hooks/useSmartHomeEvents";
import { useScenes } from "@/lib/hooks/useScenes";
import { useAuth } from "@/lib/auth";
import { DeviceGroup } from "@/components/smart-home/DeviceGroup";
import { DiscoveryBanner } from "@/components/smart-home/DiscoveryBanner";
import { DeviceDetailPanel } from "@/components/smart-home/DeviceDetailPanel";
import { DeviceStats } from "@/components/smart-home/DeviceStats";
import { RoutinesSection } from "@/components/smart-home/RoutinesSection";
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

  const [selectedDevice, setSelectedDevice] = useState<MatterDevice | null>(null);

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
                onCommand={command}
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
          onCommand={command}
          onClose={() => setSelectedDevice(null)}
        />
      )}
    </ShellPage>
  );
}
