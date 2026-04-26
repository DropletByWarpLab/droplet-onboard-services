"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Smartphone, Wifi } from "lucide-react";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useSmartHomeEvents } from "@/lib/hooks/useSmartHomeEvents";
import { DeviceGroup } from "@/components/smart-home/DeviceGroup";
import { DiscoveryBanner } from "@/components/smart-home/DiscoveryBanner";
import { DeviceDetailPanel } from "@/components/smart-home/DeviceDetailPanel";
import type { MatterDevice } from "@/lib/types";

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

  const [selectedDevice, setSelectedDevice] = useState<MatterDevice | null>(
    null
  );

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

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Devices</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {totalDevices > 0
              ? `${totalDevices} device${totalDevices !== 1 ? "s" : ""} connected`
              : "No devices found"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/devices/clients")}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
            title="Paired phones + laptops"
          >
            <Smartphone size={16} />
            <span className="type-subheadline">Paired apps</span>
          </button>
          <button
            onClick={refresh}
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
        {/* Loading skeleton */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="dp-card h-24 animate-pulse bg-surface-secondary"
              />
            ))}
          </div>
        ) : error ? (
          <div className="dp-card text-center py-12">
            <Wifi size={32} className="mx-auto text-label-quaternary mb-3" />
            <h2 className="type-title-3 text-label-primary mb-1">
              Matter Controller Not Available
            </h2>
            <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
              The Matter controller could not start. Check that the device has
              network access for mDNS discovery.
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            <DiscoveryBanner count={discovered.length} />

            {/* Device groups */}
            {groups.map((group) => (
              <DeviceGroup
                key={group.title}
                title={group.title}
                devices={group.devices}
                onCommand={command}
                onDeviceClick={setSelectedDevice}
              />
            ))}

            {/* Empty state */}
            {totalDevices === 0 && (
              <div className="dp-card text-center py-12">
                <Wifi
                  size={32}
                  className="mx-auto text-label-quaternary mb-3"
                />
                <h2 className="type-title-3 text-label-primary mb-1">
                  No smart home devices yet
                </h2>
                <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
                  Matter-compatible devices on your network will be discovered
                  automatically. Commission new devices through the chat or by
                  entering their pairing code.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedDevice && (
        <DeviceDetailPanel
          device={selectedDevice}
          onCommand={command}
          onClose={() => setSelectedDevice(null)}
        />
      )}
    </div>
  );
}
