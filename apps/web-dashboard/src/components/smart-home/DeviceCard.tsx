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
} from "lucide-react";
import type { SmartHomeDevice, SmartHomeCategory } from "@/lib/types";
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
  device: SmartHomeDevice;
  onCommand: (entityId: string, service: string, data?: Record<string, unknown>) => void;
  onClick?: () => void;
}

export function DeviceCard({ device, onCommand, onClick }: DeviceCardProps) {
  const Icon = CATEGORY_ICONS[device.category] || CircleDot;
  const isOn = device.state === "on" || device.state === "playing";
  const isToggleable = TOGGLEABLE.has(device.category);
  const brightness = device.attributes.brightness as number | undefined;

  function handleToggle() {
    onCommand(device.entityId, "toggle");
  }

  function handleBrightness(value: number) {
    onCommand(device.entityId, "turn_on", { brightness: value });
  }

  const subtitle = (() => {
    if (device.category === "light" && brightness != null) {
      return `${Math.round((brightness / 255) * 100)}%`;
    }
    if (device.category === "sensor" || device.category === "binary_sensor") {
      const unit = device.attributes.unit_of_measurement as string | undefined;
      return unit ? `${device.state} ${unit}` : device.state;
    }
    if (device.category === "climate") {
      const temp = device.attributes.current_temperature as number | undefined;
      return temp != null ? `${temp}°` : device.state;
    }
    return device.state;
  })();

  return (
    <div
      onClick={onClick}
      className={`
        dp-card cursor-pointer transition-all duration-200
        ${isOn ? "ring-1 ring-accent/20 bg-accent/[0.03]" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
            ${isOn ? "bg-accent/15 text-accent" : "bg-surface-secondary text-label-tertiary"}
          `}
        >
          <Icon size={20} />
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
        {isToggleable && (
          <ToggleSwitch on={isOn} onToggle={handleToggle} />
        )}
      </div>

      {/* Brightness slider for lights that are on */}
      {device.category === "light" && isOn && brightness != null && (
        <div className="mt-3 pt-3 border-t border-separator">
          <BrightnessSlider
            brightness={brightness}
            onBrightnessChange={handleBrightness}
          />
        </div>
      )}

      {/* Sensor reading inline */}
      {(device.category === "sensor" || device.category === "binary_sensor") && (
        <div className="mt-3 pt-3 border-t border-separator">
          <SensorReading device={device} />
        </div>
      )}
    </div>
  );
}
