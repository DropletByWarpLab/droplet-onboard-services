/**
 * WARP-820 — DiscoveryStep's discovered-device list is unbounded (it grows as
 * the network is scanned), so it moves from its bespoke
 * `max-h-[320px] overflow-y-auto` div into the shared <ScrollRegion> — the one
 * permitted scroll surface. The title, the "N devices found" subtitle, and the
 * Continue/Skip CTA stay pinned in the StepShell; only the device list scrolls.
 *
 * Structure assertion (jsdom can't measure scroll): once a device is
 * discovered, its row renders INSIDE the labelled "Discovered devices" region,
 * and that region carries the bounded-scroll classes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import type { MatterDevice, MatterGrouped } from "@/lib/types";

const emptyGrouped: MatterGrouped = {
  lights: [],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
};

const oneLight: MatterDevice = {
  nodeId: "node-1",
  name: "Living room lamp",
  category: "light",
  state: "on",
  connectionState: "connected",
  endpoints: [],
  attributes: {},
};

const fetchMatterDevicesMock = vi.fn(async () => ({
  ...emptyGrouped,
  lights: [oneLight],
}));

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: () => fetchMatterDevicesMock(),
}));

import { DiscoveryStep } from "./DiscoveryStep";

describe("DiscoveryStep device list in ScrollRegion (WARP-820)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMatterDevicesMock.mockClear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders the discovered devices inside a bounded, labelled scroll region", async () => {
    render(<DiscoveryStep onContinue={() => {}} />);

    // Advance one 3s poll tick and let the awaited fetch resolve.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    const region = screen.getByRole("region", { name: /discovered devices/i });
    expect(within(region).getByText("Living room lamp")).toBeInTheDocument();
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });
});
