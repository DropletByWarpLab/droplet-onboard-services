"use client";

import {
  Thermometer,
  Droplets,
  Eye,
  Battery,
  Gauge,
  Activity,
} from "lucide-react";
import type { MatterDevice } from "@/lib/types";

const SENSOR_ICONS: Record<string, typeof Thermometer> = {
  temperature: Thermometer,
  humidity: Droplets,
  motion: Eye,
  battery: Battery,
  pressure: Gauge,
  power: Activity,
  energy: Activity,
};

export function SensorReading({ device }: { device: MatterDevice }) {
  // Infer sensor type from category and available attributes
  const hasTemp = device.attributes.measuredValue !== undefined || device.attributes.localTemperature !== undefined;
  const sensorType = hasTemp ? "temperature" : undefined;
  const Icon = (sensorType && SENSOR_ICONS[sensorType]) || Activity;
  const unit = hasTemp ? "°C" : undefined;

  return (
    <div className="flex items-center gap-3">
      <Icon size={20} className="flex-shrink-0" style={{ color: "var(--text-muted)" }} />
      <div className="flex-1 min-w-0">
        <span className="type-title-3" style={{ color: "var(--text)" }}>{device.state}</span>
        {unit && (
          <span className="type-subheadline ml-1" style={{ color: "var(--text-muted)" }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
