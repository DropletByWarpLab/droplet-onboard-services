/**
 * Smart-home KPI strip — derivation smoke test.
 *
 * Pins that the counts come from live device groups + the routine count, never
 * fabricated: lights "on" tally, locks unlocked tally, and the honest empty
 * states when nothing is paired.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceStats } from "@/components/smart-home/DeviceStats";
import type { MatterDevice, MatterGrouped } from "@/lib/types";

function dev(
  category: MatterDevice["category"],
  state: string,
): MatterDevice {
  return {
    nodeId: "n-" + Math.round(state.length),
    name: "d",
    category,
    state,
    connectionState: "connected",
    endpoints: [],
    attributes: {},
  } as MatterDevice;
}

function grouped(partial: Partial<MatterGrouped>): MatterGrouped {
  return {
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
    ...partial,
  };
}

describe("DeviceStats KPI strip", () => {
  it("derives lights on-count, locks unlocked-count, and routine count", () => {
    const g = grouped({
      lights: [dev("light", "on"), dev("light", "on"), dev("light", "off")],
      climate: [dev("climate", "heat")],
      locks: [dev("lock", "locked"), dev("lock", "unlocked")],
    });
    render(<DeviceStats grouped={g} routineCount={4} />);

    expect(screen.getByText("Lights")).toBeTruthy();
    expect(screen.getByText("2 on")).toBeTruthy();
    expect(screen.getByText("1 unlocked")).toBeTruthy();
    expect(screen.getByText("Routines")).toBeTruthy();
    // routine count value
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("shows 'all locked' when every lock is secured", () => {
    const g = grouped({ locks: [dev("lock", "locked"), dev("lock", "closed")] });
    render(<DeviceStats grouped={g} routineCount={0} />);
    expect(screen.getByText("all locked")).toBeTruthy();
  });

  it("shows honest empty states with no devices", () => {
    render(<DeviceStats grouped={grouped({})} routineCount={0} />);
    // lights + climate + locks all report "none paired"
    expect(screen.getAllByText("none paired").length).toBe(3);
  });
});
