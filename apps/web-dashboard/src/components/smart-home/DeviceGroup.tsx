"use client";

import type { SmartHomeDevice } from "@/lib/types";
import { DeviceCard } from "./DeviceCard";

interface DeviceGroupProps {
  title: string;
  devices: SmartHomeDevice[];
  onCommand: (entityId: string, service: string, data?: Record<string, unknown>) => void;
  onDeviceClick?: (device: SmartHomeDevice) => void;
}

export function DeviceGroup({
  title,
  devices,
  onCommand,
  onDeviceClick,
}: DeviceGroupProps) {
  if (devices.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="type-title-3 text-label-primary">{title}</h2>
        <span className="type-caption-1 text-label-quaternary bg-surface-secondary px-2 py-0.5 rounded-full">
          {devices.length}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {devices.map((device) => (
          <DeviceCard
            key={device.entityId}
            device={device}
            onCommand={onCommand}
            onClick={() => onDeviceClick?.(device)}
          />
        ))}
      </div>
    </section>
  );
}
