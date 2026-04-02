"use client";

import { X } from "lucide-react";
import type { SmartHomeDevice } from "@/lib/types";
import { ToggleSwitch } from "./ToggleSwitch";
import { BrightnessSlider } from "./BrightnessSlider";
import { ClimateControl } from "./ClimateControl";
import { SensorReading } from "./SensorReading";

interface DeviceDetailPanelProps {
  device: SmartHomeDevice;
  onCommand: (entityId: string, service: string, data?: Record<string, unknown>) => void;
  onClose: () => void;
}

const TOGGLEABLE = new Set(["light", "switch", "fan", "cover"]);

export function DeviceDetailPanel({
  device,
  onCommand,
  onClose,
}: DeviceDetailPanelProps) {
  const isOn = device.state === "on" || device.state === "playing";
  const isToggleable = TOGGLEABLE.has(device.category);
  const brightness = device.attributes.brightness as number | undefined;

  function cmd(service: string, data?: Record<string, unknown>) {
    onCommand(device.entityId, service, data);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-surface-primary border-l border-separator overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-separator">
          <div>
            <h2 className="type-title-3 text-label-primary">{device.name}</h2>
            <p className="type-caption-1 text-label-tertiary capitalize">
              {device.category.replace("_", " ")} &middot; {device.state}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-label-tertiary hover:bg-surface-secondary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Controls */}
        <div className="p-5 space-y-6">
          {/* Toggle */}
          {isToggleable && (
            <div className="flex items-center justify-between">
              <span className="type-subheadline text-label-primary">Power</span>
              <ToggleSwitch on={isOn} onToggle={() => cmd("toggle")} />
            </div>
          )}

          {/* Brightness */}
          {device.category === "light" && brightness != null && (
            <div>
              <span className="type-caption-1 text-label-tertiary mb-2 block">
                Brightness
              </span>
              <BrightnessSlider
                brightness={brightness}
                onBrightnessChange={(v) => cmd("turn_on", { brightness: v })}
              />
            </div>
          )}

          {/* Climate */}
          {device.category === "climate" && (
            <ClimateControl device={device} onCommand={cmd} />
          )}

          {/* Sensor */}
          {(device.category === "sensor" ||
            device.category === "binary_sensor") && (
            <SensorReading device={device} />
          )}

          {/* Entity ID */}
          <div className="pt-4 border-t border-separator">
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Entity ID
            </span>
            <code className="type-caption-1 text-label-secondary bg-surface-secondary px-2 py-1 rounded">
              {device.entityId}
            </code>
          </div>

          {/* Last changed */}
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Last Changed
            </span>
            <span className="type-caption-1 text-label-secondary">
              {new Date(device.lastChanged).toLocaleString()}
            </span>
          </div>

          {/* Attributes (collapsible) */}
          <details className="pt-2">
            <summary className="type-caption-1 text-label-tertiary cursor-pointer hover:text-label-secondary">
              All Attributes
            </summary>
            <pre className="mt-2 type-caption-2 text-label-tertiary bg-surface-secondary rounded-lg p-3 overflow-x-auto max-h-60">
              {JSON.stringify(device.attributes, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
