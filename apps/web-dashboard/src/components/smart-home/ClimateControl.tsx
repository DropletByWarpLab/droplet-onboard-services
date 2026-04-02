"use client";

import { Minus, Plus } from "lucide-react";
import type { SmartHomeDevice } from "@/lib/types";

interface ClimateControlProps {
  device: SmartHomeDevice;
  onCommand: (service: string, data?: Record<string, unknown>) => void;
}

const MODES = ["heat", "cool", "auto", "off"] as const;

export function ClimateControl({ device, onCommand }: ClimateControlProps) {
  const currentTemp = device.attributes.current_temperature as number | undefined;
  const targetTemp = device.attributes.temperature as number | undefined;
  const hvacMode = device.state;
  const unit = (device.attributes.temperature_unit as string) || "°C";

  function adjustTemp(delta: number) {
    if (targetTemp == null) return;
    onCommand("set_temperature", { temperature: targetTemp + delta });
  }

  function setMode(mode: string) {
    onCommand("set_hvac_mode", { hvac_mode: mode });
  }

  return (
    <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
      {/* Current temperature */}
      {currentTemp != null && (
        <div className="text-center">
          <span className="type-caption-1 text-label-tertiary">Current</span>
          <p className="type-large-title text-label-primary">
            {currentTemp}{unit}
          </p>
        </div>
      )}

      {/* Target temperature */}
      {targetTemp != null && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => adjustTemp(-0.5)}
            className="w-10 h-10 rounded-full bg-surface-secondary flex items-center justify-center
              hover:bg-surface-tertiary transition-colors"
          >
            <Minus size={18} />
          </button>
          <div className="text-center min-w-[80px]">
            <span className="type-caption-1 text-label-tertiary">Target</span>
            <p className="type-title-1 text-accent">{targetTemp}{unit}</p>
          </div>
          <button
            onClick={() => adjustTemp(0.5)}
            className="w-10 h-10 rounded-full bg-surface-secondary flex items-center justify-center
              hover:bg-surface-tertiary transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>
      )}

      {/* Mode selector */}
      <div className="flex gap-1 bg-surface-secondary rounded-lg p-1">
        {MODES.map((mode) => (
          <button
            key={mode}
            onClick={() => setMode(mode)}
            className={`
              flex-1 py-1.5 px-2 rounded-md type-caption-1 capitalize transition-all
              ${
                hvacMode === mode
                  ? "bg-accent text-white font-medium"
                  : "text-label-secondary hover:text-label-primary"
              }
            `}
          >
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}
