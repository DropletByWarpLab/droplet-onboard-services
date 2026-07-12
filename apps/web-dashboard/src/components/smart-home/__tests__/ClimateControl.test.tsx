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
    const cool = screen.getByRole("tab", { name: /cool/i });
    // Active tab carries the indigo brand-subtle fill (WARP-1091 recolor; was bg-accent).
    expect(cool.className).toContain("bg-[var(--brand-subtle)]");
    expect(cool.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /heat/i }).className).not.toContain("bg-[var(--brand-subtle)]");
  });

  // KAN-7: the mode tabs are interactive. Heat/cool/auto are Tier-1 (the page's
  // `request` applies them directly); "off" is Tier-2, but ClimateControl just
  // issues the command — `request` (from useMatterCommandConfirm) intercepts the
  // 202 and opens the confirm dialog, so the component fires the same way.
  it("clicking Heat issues set_hvac_mode with mode heat", () => {
    const onCommand = vi.fn();
    render(
      <ClimateControl
        // Start in cool so Heat is an inactive, clickable tab.
        device={thermostat({ localTemperature: 2300, occupiedCoolingSetpoint: 2100, systemMode: 3 })}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^heat$/i }));
    expect(onCommand).toHaveBeenCalledWith("set_hvac_mode", { mode: "heat" });
  });

  it("clicking Off issues set_hvac_mode with mode off (the Tier-2 confirm path)", () => {
    const onCommand = vi.fn();
    render(
      <ClimateControl
        device={thermostat({ localTemperature: 2000, occupiedHeatingSetpoint: 2000, systemMode: 4 })}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^off$/i }));
    expect(onCommand).toHaveBeenCalledWith("set_hvac_mode", { mode: "off" });
  });

  it("does not re-issue a command when clicking the already-active mode", () => {
    const onCommand = vi.fn();
    render(
      <ClimateControl
        device={thermostat({ localTemperature: 2000, occupiedHeatingSetpoint: 2000, systemMode: 4 })}
        onCommand={onCommand}
      />,
    );
    // systemMode 4 = heat is already active.
    fireEvent.click(screen.getByRole("tab", { name: /^heat$/i }));
    expect(onCommand).not.toHaveBeenCalled();
  });
});
