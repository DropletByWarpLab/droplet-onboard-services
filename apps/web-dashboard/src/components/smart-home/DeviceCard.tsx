"use client";

import {
  Lightbulb,
  ToggleRight,
  Thermometer,
  ThermometerSun,
  Music,
  DoorOpen,
  Fan,
  Lock,
  Camera,
  CircleDot,
  WifiOff,
} from "lucide-react";
import type { MatterDevice, SmartHomeCategory } from "@/lib/types";
import { ToggleSwitch } from "./ToggleSwitch";
import { BrightnessSlider } from "./BrightnessSlider";
import { SensorReading } from "./SensorReading";
import { ColorControls } from "./ColorControls";
import { CoverControls } from "./CoverControls";
import { FanControls } from "./FanControls";
import { LockControl } from "./LockControl";
import { MediaControls } from "./MediaControls";
import { CLUSTER, hasCluster } from "./clusters";
import { displayName } from "./rooms-model";

const CATEGORY_ICONS: Record<SmartHomeCategory, typeof Lightbulb> = {
  light: Lightbulb,
  switch: ToggleRight,
  sensor: Thermometer,
  binary_sensor: CircleDot,
  climate: ThermometerSun,
  media_player: Music,
  cover: DoorOpen,
  fan: Fan,
  lock: Lock,
  camera: Camera,
  vacuum: CircleDot,
};

// WARP-897: covers are NOT toggleable — the toggle sent an onOff command a
// WindowCovering never implements (guaranteed 500, June audit). Covers get
// real motion controls below instead.
const TOGGLEABLE = new Set<SmartHomeCategory>([
  "light",
  "switch",
  "fan",
]);

// The device's source/ecosystem, surfaced from the Matter fabric's vendorName.
// Bridged ecosystems (Hue, SmartThings, etc.) surface their brand here; a plain
// Matter device with no read-back vendor falls back to the calm "Matter" label.
// Lead with plain meaning, keep the protocol a quiet secondary (ADR-002).
function deviceSource(device: MatterDevice): string {
  return device.vendorName?.trim() || "Matter";
}

interface DeviceCardProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  onClick?: () => void;
}

export function DeviceCard({ device, onCommand, onClick }: DeviceCardProps) {
  const Icon = CATEGORY_ICONS[device.category] || CircleDot;
  const isOn = device.state === "on" || device.state === "playing";
  const isToggleable = TOGGLEABLE.has(device.category);
  const isConnected = device.connectionState === "connected";
  const brightness = device.attributes.currentLevel as number | undefined;
  // Matter brightness is 0-254, convert to percentage
  const brightnessPct = brightness != null ? Math.round((brightness / 254) * 100) : undefined;

  function handleToggle() {
    onCommand(device.nodeId, "toggle");
  }

  function handleBrightness(value: number) {
    onCommand(device.nodeId, "set_brightness", { brightness: value });
  }

  const subtitle = (() => {
    if (!isConnected) return device.connectionState;
    if (device.category === "light" && brightnessPct != null) {
      return `${brightnessPct}%`;
    }
    if (device.category === "sensor" || device.category === "binary_sensor") {
      return device.state;
    }
    if (device.category === "climate") {
      const temp = device.attributes.localTemperature as number | undefined;
      return temp != null ? `${(temp / 100).toFixed(1)}°` : device.state;
    }
    return device.state;
  })();

  return (
    <div
      onClick={onClick}
      className={`
        card hover transition-all duration-200
        ${!isConnected ? "opacity-60" : ""}
      `}
      style={
        isOn && isConnected
          ? {
              borderColor: "color-mix(in srgb, var(--brand) 30%, var(--card-bd))",
              background: "var(--brand-subtle)",
            }
          : undefined
      }
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={
            isOn && isConnected
              ? { background: "var(--brand-subtle)", color: "var(--brand)" }
              : { background: "var(--card-inner)", color: "var(--text-muted)" }
          }
        >
          {isConnected ? <Icon size={20} /> : <WifiOff size={20} />}
        </div>

        {/* Name + state + source */}
        <div className="flex-1 min-w-0">
          <p className="type-subheadline font-medium truncate" style={{ color: "var(--text)" }}>
            {/* WARP-1396: show the household name (alias → product → Matter),
                matching the detail panel — the card was still showing the raw
                Matter product name after a rename. */}
            {displayName(device)}
          </p>
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="type-caption-1 capitalize truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {subtitle}
            </span>
            <span
              className="type-caption-2 px-1.5 py-0.5 rounded-sm flex-shrink-0 max-w-[120px] truncate"
              style={{ color: "var(--text-faint)", background: "var(--card-inner)" }}
            >
              {deviceSource(device)}
            </span>
          </div>
        </div>

        {/* Toggle for binary devices */}
        {isToggleable && isConnected && (
          <ToggleSwitch on={isOn} onToggle={handleToggle} />
        )}
      </div>

      {/* Brightness slider for lights that are on */}
      {device.category === "light" && isOn && isConnected && brightnessPct != null && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <BrightnessSlider
            brightness={brightnessPct}
            onBrightnessChange={handleBrightness}
          />
        </div>
      )}

      {/* WARP-897: color controls — only for lights that actually implement
          ColorControl (capability truth from the endpoint clusters). */}
      {device.category === "light" &&
        isOn &&
        isConnected &&
        hasCluster(device, CLUSTER.COLOR_CONTROL) && (
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
            <ColorControls device={device} onCommand={onCommand} />
          </div>
        )}

      {/* WARP-897: cover motion + position */}
      {device.category === "cover" && isConnected && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <CoverControls device={device} onCommand={onCommand} />
        </div>
      )}

      {/* WARP-897: fan speed + mode (cluster-gated — an on/off fan keeps
          just its toggle) */}
      {device.category === "fan" &&
        isConnected &&
        hasCluster(device, CLUSTER.FAN_CONTROL) && (
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
            <FanControls device={device} onCommand={onCommand} />
          </div>
        )}

      {/* WARP-897: lock / unlock — routes through the page's Tier-2 confirm */}
      {device.category === "lock" && isConnected && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <LockControl device={device} onCommand={onCommand} />
        </div>
      )}

      {/* WARP-897: media playback verbs */}
      {device.category === "media_player" && isConnected && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <MediaControls device={device} onCommand={onCommand} />
        </div>
      )}

      {/* Sensor reading inline */}
      {(device.category === "sensor" || device.category === "binary_sensor") && isConnected && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <SensorReading device={device} />
        </div>
      )}
    </div>
  );
}
