"use client";

import { useId } from "react";
import { X } from "lucide-react";
import type { MatterDevice } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ToggleSwitch } from "./ToggleSwitch";
import { BrightnessSlider } from "./BrightnessSlider";
import { ClimateControl } from "./ClimateControl";
import { SensorReading } from "./SensorReading";

interface DeviceDetailPanelProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  onClose: () => void;
}

const TOGGLEABLE = new Set(["light", "switch", "fan", "cover"]);

/**
 * Smart-home device detail side-panel.
 *
 * WARP-289: rebuilt on the shared `<Dialog placement="right">` primitive
 * — full role="dialog" + aria-modal + aria-labelledby + Escape close +
 * focus restore come from there.
 */
export function DeviceDetailPanel({
  device,
  onCommand,
  onClose,
}: DeviceDetailPanelProps) {
  const isOn = device.state === "on" || device.state === "playing";
  const isConnected = device.connectionState === "connected";
  const isToggleable = TOGGLEABLE.has(device.category);
  const brightness = device.attributes.currentLevel as number | undefined;
  const brightnessPct = brightness != null ? Math.round((brightness / 254) * 100) : undefined;

  const headingId = useId();

  function cmd(command: string, data?: Record<string, unknown>) {
    onCommand(device.nodeId, command, data);
  }

  return (
    // `flush`: sectioned side panel — full-width dividers, sections own their
    // padding (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right" flush>
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b border-separator">
        <div>
          <h2 id={headingId} className="type-title-3 text-label-primary">
            {device.name}
          </h2>
          <p className="type-caption-1 text-label-tertiary capitalize">
            {device.category.replace("_", " ")} &middot; {device.state}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-2 rounded-lg text-label-tertiary hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X size={20} />
        </button>
      </div>

      {/* Controls */}
      <div className="p-5 space-y-6">
        {/* Connection state — offline is a warning, not a saved-state */}
        {!isConnected && (
          <div className="bg-system-orange/10 border border-system-orange/20 rounded-lg p-3">
            <p className="type-caption-1 text-label-secondary capitalize">
              {device.connectionState}
            </p>
          </div>
        )}

        {/* Toggle */}
        {isToggleable && isConnected && (
          <div className="flex items-center justify-between">
            <span className="type-subheadline text-label-primary">Power</span>
            <ToggleSwitch on={isOn} onToggle={() => cmd("toggle")} />
          </div>
        )}

        {/* Brightness */}
        {device.category === "light" && isConnected && brightnessPct != null && (
          <div>
            <span className="type-caption-1 text-label-tertiary mb-2 block">
              Brightness
            </span>
            <BrightnessSlider
              brightness={brightnessPct}
              onBrightnessChange={(v) => cmd("set_brightness", { brightness: v })}
            />
          </div>
        )}

        {/* Climate */}
        {device.category === "climate" && isConnected && (
          <ClimateControl device={device} onCommand={cmd} />
        )}

        {/* Sensor */}
        {(device.category === "sensor" ||
          device.category === "binary_sensor") && isConnected && (
          <SensorReading device={device} />
        )}

        {/* Device info */}
        <div className="pt-4 border-t border-separator space-y-3">
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Node ID
            </span>
            <code className="type-caption-1 text-label-secondary bg-surface-secondary px-2 py-1 rounded">
              {device.nodeId}
            </code>
          </div>
          {device.vendorName && (
            <div>
              <span className="type-caption-1 text-label-tertiary block mb-1">Vendor</span>
              <span className="type-caption-1 text-label-secondary">{device.vendorName}</span>
            </div>
          )}
          {device.productName && (
            <div>
              <span className="type-caption-1 text-label-tertiary block mb-1">Product</span>
              <span className="type-caption-1 text-label-secondary">{device.productName}</span>
            </div>
          )}
          {device.serialNumber && (
            <div>
              <span className="type-caption-1 text-label-tertiary block mb-1">Serial</span>
              <span className="type-caption-1 text-label-secondary">{device.serialNumber}</span>
            </div>
          )}
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
    </Dialog>
  );
}
