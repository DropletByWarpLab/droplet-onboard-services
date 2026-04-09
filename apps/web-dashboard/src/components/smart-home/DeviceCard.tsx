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

const TOGGLEABLE = new Set<SmartHomeCategory>([
  "light",
  "switch",
  "fan",
  "cover",
]);

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
        dp-card cursor-pointer transition-all duration-200
        ${isOn && isConnected ? "ring-1 ring-accent/20 bg-accent/[0.03]" : ""}
        ${!isConnected ? "opacity-60" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
            ${isOn && isConnected ? "bg-accent/15 text-accent" : "bg-surface-secondary text-label-tertiary"}
          `}
        >
          {isConnected ? <Icon size={20} /> : <WifiOff size={20} />}
        </div>

        {/* Name + state */}
        <div className="flex-1 min-w-0">
          <p className="type-subheadline text-label-primary font-medium truncate">
            {device.name}
          </p>
          <p className="type-caption-1 text-label-tertiary capitalize">
            {subtitle}
          </p>
        </div>

        {/* Toggle for binary devices */}
        {isToggleable && isConnected && (
          <ToggleSwitch on={isOn} onToggle={handleToggle} />
        )}
      </div>

      {/* Brightness slider for lights that are on */}
      {device.category === "light" && isOn && isConnected && brightnessPct != null && (
        <div className="mt-3 pt-3 border-t border-separator">
          <BrightnessSlider
            brightness={brightnessPct}
            onBrightnessChange={handleBrightness}
          />
        </div>
      )}

      {/* Sensor reading inline */}
      {(device.category === "sensor" || device.category === "binary_sensor") && isConnected && (
        <div className="mt-3 pt-3 border-t border-separator">
          <SensorReading device={device} />
        </div>
      )}
    </div>
  );
}
