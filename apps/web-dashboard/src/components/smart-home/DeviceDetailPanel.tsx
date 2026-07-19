"use client";

import { useId } from "react";
import { X } from "lucide-react";
import type { MatterDevice } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ToggleSwitch } from "./ToggleSwitch";
import { BrightnessSlider } from "./BrightnessSlider";
import { ClimateControl } from "./ClimateControl";
import { SensorReading } from "./SensorReading";
import { ColorControls } from "./ColorControls";
import { CoverControls } from "./CoverControls";
import { FanControls } from "./FanControls";
import { LockControl } from "./LockControl";
import { MediaControls } from "./MediaControls";
import { CLUSTER, hasCluster } from "./clusters";

interface DeviceDetailPanelProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  onClose: () => void;
}

// WARP-897: covers get real motion controls, not an onOff toggle a
// WindowCovering never implements.
const TOGGLEABLE = new Set(["light", "switch", "fan"]);

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
      <div className="flex items-center justify-between p-5" style={{ borderBottom: "1px solid var(--card-bd)" }}>
        <div>
          <h2 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>
            {device.name}
          </h2>
          <p className="type-caption-1 capitalize" style={{ color: "var(--text-muted)" }}>
            {device.category.replace("_", " ")} &middot; {device.state}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:ring-[var(--brand)]"
        >
          <X size={20} />
        </button>
      </div>

      {/* Controls */}
      <div className="p-5 space-y-6">
        {/* Connection state — offline is a warning, not a saved-state */}
        {!isConnected && (
          <div className="bg-system-orange/10 border border-system-orange/20 rounded-lg p-3">
            <p className="type-caption-1 capitalize" style={{ color: "var(--text-muted)" }}>
              {device.connectionState}
            </p>
          </div>
        )}

        {/* Toggle */}
        {isToggleable && isConnected && (
          <div className="flex items-center justify-between">
            <span className="type-subheadline" style={{ color: "var(--text)" }}>Power</span>
            <ToggleSwitch on={isOn} onToggle={() => cmd("toggle")} />
          </div>
        )}

        {/* Brightness */}
        {device.category === "light" && isConnected && brightnessPct != null && (
          <div>
            <span className="type-caption-1 mb-2 block" style={{ color: "var(--text-muted)" }}>
              Brightness
            </span>
            <BrightnessSlider
              brightness={brightnessPct}
              onBrightnessChange={(v) => cmd("set_brightness", { brightness: v })}
            />
          </div>
        )}

        {/* WARP-897: color for ColorControl-capable lights */}
        {device.category === "light" &&
          isConnected &&
          hasCluster(device, CLUSTER.COLOR_CONTROL) && (
            <div>
              <span className="type-caption-1 mb-2 block" style={{ color: "var(--text-muted)" }}>
                Color
              </span>
              <ColorControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
            </div>
          )}

        {/* WARP-897: cover motion + position */}
        {device.category === "cover" && isConnected && (
          <CoverControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
        )}

        {/* WARP-897: fan speed + mode */}
        {device.category === "fan" &&
          isConnected &&
          hasCluster(device, CLUSTER.FAN_CONTROL) && (
            <FanControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
          )}

        {/* WARP-897: lock / unlock (Tier-2 confirm flows via the page) */}
        {device.category === "lock" && isConnected && (
          <LockControl device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
        )}

        {/* WARP-897: media playback */}
        {device.category === "media_player" && isConnected && (
          <MediaControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
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
        <div className="pt-4 space-y-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <div>
            <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>
              Node ID
            </span>
            <code
              className="type-caption-1 px-2 py-1 rounded"
              style={{ color: "var(--text-muted)", background: "var(--card-inner)" }}
            >
              {device.nodeId}
            </code>
          </div>
          {device.vendorName && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Vendor</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.vendorName}</span>
            </div>
          )}
          {device.productName && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Product</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.productName}</span>
            </div>
          )}
          {device.serialNumber && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Serial</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.serialNumber}</span>
            </div>
          )}
        </div>

        {/* Attributes (collapsible) */}
        <details className="pt-2">
          <summary
            className="type-caption-1 cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            All Attributes
          </summary>
          <pre
            className="mt-2 type-caption-2 rounded-lg p-3 overflow-x-auto max-h-60"
            style={{ color: "var(--text-muted)", background: "var(--card-inner)" }}
          >
            {JSON.stringify(device.attributes, null, 2)}
          </pre>
        </details>
      </div>
    </Dialog>
  );
}
