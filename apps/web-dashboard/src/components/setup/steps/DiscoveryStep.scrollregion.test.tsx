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
  // WARP-851: the step probes capabilities at mount; stub it so the
  // fail-soft catch isn't silently masking a missing mock.
  fetchMatterCapabilities: vi.fn().mockResolvedValue({ bleCommissioning: true }),
  // WARP-1281: the step also runs the commissionable-device browse while
  // scanning; stub it healthy-and-empty for the same reason — a missing
  // export makes every browse throw and (by design) trips the
  // service-unavailable state under enough fake-timer advancement.
  discoverMatterDevices: vi.fn().mockResolvedValue({ devices: [], count: 0 }),
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

    // WARP-1281: the region label widened to cover the commissionable
    // "ready to pair" cards it now also holds.
    const region = screen.getByRole("region", {
      name: /discovered and nearby devices/i,
    });
    expect(within(region).getByText("Living room lamp")).toBeInTheDocument();
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });
});
