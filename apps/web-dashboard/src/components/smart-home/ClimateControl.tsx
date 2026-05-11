"use client";

import { Minus, Plus } from "lucide-react";
import type { MatterDevice } from "@/lib/types";

interface ClimateControlProps {
  device: MatterDevice;
  onCommand: (command: string, data?: Record<string, unknown>) => void;
}

const MODES = ["heat", "cool", "auto", "off"] as const;

export function ClimateControl({ device, onCommand }: ClimateControlProps) {
  // Matter temperatures are in units of 0.01°C
  const rawCurrent = device.attributes.localTemperature as number | undefined;
  const rawHeating = device.attributes.occupiedHeatingSetpoint as number | undefined;
  const rawCooling = device.attributes.occupiedCoolingSetpoint as number | undefined;
  const currentTemp = rawCurrent != null ? rawCurrent / 100 : undefined;
  const targetTemp = rawHeating != null ? rawHeating / 100 : rawCooling != null ? rawCooling / 100 : undefined;
  const hvacMode = device.state;

  function adjustTemp(delta: number) {
    if (targetTemp == null) return;
    onCommand("set_temperature", { temperature: targetTemp + delta });
  }

  return (
    <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
      {/* Current temperature */}
      {currentTemp != null && (
        <div className="text-center">
          <span className="type-caption-1 text-label-tertiary">Current</span>
          <p className="type-large-title text-label-primary">
            {currentTemp.toFixed(1)}°C
          </p>
        </div>
      )}

      {/* Target temperature */}
      {targetTemp != null && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => adjustTemp(-0.5)}
            aria-label="Lower target temperature by 0.5°C"
            className="w-10 h-10 rounded-full bg-surface-secondary flex items-center justify-center
              hover:bg-surface-tertiary transition-colors"
          >
            <Minus size={18} aria-hidden="true" />
          </button>
          <div className="text-center min-w-[80px]">
            <span className="type-caption-1 text-label-tertiary">Target</span>
            <p className="type-title-1 text-accent">{targetTemp.toFixed(1)}°C</p>
          </div>
          <button
            onClick={() => adjustTemp(0.5)}
            aria-label="Raise target temperature by 0.5°C"
            className="w-10 h-10 rounded-full bg-surface-secondary flex items-center justify-center
              hover:bg-surface-tertiary transition-colors"
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Mode indicator */}
      <div className="flex gap-1 bg-surface-secondary rounded-lg p-1">
        {MODES.map((mode) => (
          <div
            key={mode}
            className={`
              flex-1 py-1.5 px-2 rounded-md type-caption-1 capitalize text-center
              ${
                hvacMode === mode
                  ? "bg-accent text-white font-medium"
                  : "text-label-secondary"
              }
            `}
          >
            {mode}
          </div>
        ))}
      </div>
    </div>
  );
}
