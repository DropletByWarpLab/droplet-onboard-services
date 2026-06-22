/**
 * ClimateControl — setpoint-mode + mode-indicator correctness.
 *
 * Pins the two fixes: (1) a cooling thermostat adjusts its COOLING setpoint and
 * writes set_temperature with mode:1 (heating thermostat → mode:0); (2) the mode
 * pill highlights the device's real `systemMode` attribute (not device.state).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClimateControl } from "../ClimateControl";
import type { MatterDevice } from "@/lib/types";

function thermostat(attrs: Record<string, unknown>): MatterDevice {
  return {
    nodeId: "n1",
    name: "Office",
    category: "climate",
    state: "21.0°",
    connectionState: "connected",
    endpoints: [],
    attributes: attrs,
  } as MatterDevice;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ClimateControl", () => {
  it("a cooling thermostat targets the cooling setpoint and writes mode:1", () => {
    const onCommand = vi.fn();
    render(
      <ClimateControl
        device={thermostat({
          localTemperature: 2300,
          occupiedCoolingSetpoint: 2100,
          occupiedHeatingSetpoint: 1900,
          systemMode: 3, // cool
        })}
        onCommand={onCommand}
      />,
    );
    // Target shows the cooling setpoint (21.0°C), not the heating one (19.0).
    expect(screen.getByText("21.0°C")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/raise target temperature/i));
    expect(onCommand).toHaveBeenCalledWith("set_temperature", { temperature: 21.5, mode: 1 });
  });

  it("a heating thermostat writes mode:0", () => {
    const onCommand = vi.fn();
    render(
      <ClimateControl
        device={thermostat({
          localTemperature: 2000,
          occupiedHeatingSetpoint: 2000,
          systemMode: 4, // heat
        })}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByLabelText(/lower target temperature/i));
    expect(onCommand).toHaveBeenCalledWith("set_temperature", { temperature: 19.5, mode: 0 });
  });

  it("highlights the active mode from systemMode (not device.state)", () => {
    render(
      <ClimateControl
        device={thermostat({ localTemperature: 2300, occupiedCoolingSetpoint: 2100, systemMode: 3 })}
        onCommand={vi.fn()}
      />,
    );
    const cool = screen.getByText("cool");
    expect(cool.className).toMatch(/bg-accent/);
    expect(screen.getByText("heat").className).not.toMatch(/bg-accent/);
  });
});
