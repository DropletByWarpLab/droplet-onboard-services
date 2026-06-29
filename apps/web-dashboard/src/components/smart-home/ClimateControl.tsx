"use client";

import { Minus, Plus } from "lucide-react";
import type { MatterDevice } from "@/lib/types";

interface ClimateControlProps {
  device: MatterDevice;
  onCommand: (command: string, data?: Record<string, unknown>) => void;
}

const MODES = ["heat", "cool", "auto", "off"] as const;

// Matter Thermostat SystemMode enum → label. Read from the device's `systemMode`
// attribute (NOT device.state, which is the temperature string and could never
// match a mode label, so the pill never highlighted).
const SYSTEM_MODE_LABEL: Record<number, (typeof MODES)[number]> = {
  0: "off",
  1: "auto",
  3: "cool",
  4: "heat",
};

export function ClimateControl({ device, onCommand }: ClimateControlProps) {
  // Matter temperatures are in units of 0.01°C
  const rawCurrent = device.attributes.localTemperature as number | undefined;
  const rawHeating = device.attributes.occupiedHeatingSetpoint as number | undefined;
  const rawCooling = device.attributes.occupiedCoolingSetpoint as number | undefined;
  const systemMode = device.attributes.systemMode as number | undefined;
  const isCooling = systemMode === 3;
  const currentTemp = rawCurrent != null ? rawCurrent / 100 : undefined;
  // Show — and adjust — the setpoint that matches the active mode. A cooling
  // thermostat must target its COOLING setpoint, not the heating one.
  const rawTarget = isCooling ? (rawCooling ?? rawHeating) : (rawHeating ?? rawCooling);
  const targetTemp = rawTarget != null ? rawTarget / 100 : undefined;
  const hvacMode = systemMode != null ? SYSTEM_MODE_LABEL[systemMode] : undefined;

  function adjustTemp(delta: number) {
    if (targetTemp == null) return;
    // mode 1 = cooling setpoint, 0 = heating setpoint (matches the sidecar's
    // set_temperature handler). Without this the write always lands on the
    // heating setpoint even when the thermostat is cooling.
    onCommand("set_temperature", {
      temperature: targetTemp + delta,
      mode: isCooling ? 1 : 0,
    });
  }

  // KAN-7: the mode tabs are interactive. heat/cool/auto are Tier-1 — the
  // page's command handler applies them directly; "off" is Tier-2 — the same
  // handler (useMatterCommandConfirm.request) intercepts the orchestrator's
  // 202 confirmation_required and opens the confirm dialog, so ClimateControl
  // issues every mode the same way. Re-selecting the active mode is a no-op so
  // we don't spend a rate-limit slot (or a confirm prompt) on it.
  function selectMode(mode: (typeof MODES)[number]) {
    if (mode === hvacMode) return;
    onCommand("set_hvac_mode", { mode });
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

      {/* Mode switch — heat/cool/auto apply directly; off confirms first. */}
      <div
        role="tablist"
        aria-label="Climate mode"
        className="flex gap-1 bg-surface-secondary rounded-lg p-1"
      >
        {MODES.map((mode) => {
          const active = hvacMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={mode}
              disabled={active}
              onClick={() => selectMode(mode)}
              className={`
                flex-1 py-1.5 px-2 rounded-md type-caption-1 capitalize text-center
                transition-colors duration-150
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                ${
                  active
                    ? "bg-accent text-white font-medium cursor-default"
                    : "text-label-secondary hover:bg-surface-tertiary hover:text-label-primary"
                }
              `}
            >
              {mode}
            </button>
          );
        })}
      </div>
    </div>
  );
}
