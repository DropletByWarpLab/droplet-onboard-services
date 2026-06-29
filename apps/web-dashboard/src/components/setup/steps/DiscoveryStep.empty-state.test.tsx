/**
 * WARP-937 — "no devices found" empty state in the setup discovery step.
 *
 * Before this change the step rendered animated scanning-skeleton rows
 * whenever `discoveredDevices.length === 0`, with no `scanPhase` guard.
 * Those placeholders kept pulsing forever even after polling stopped with
 * zero results, so the customer couldn't tell whether the box was still
 * scanning or had simply found nothing.
 *
 * The fix:
 *   - Skeleton placeholders are gated on the *active* scanning phases
 *     (`active` / `downshifted`) — they stop animating once polling halts.
 *   - When discovery COMPLETES (phase `stopped`) with zero devices, a clear
 *     "no devices found" empty state is shown with retry guidance.
 *
 * Drive: render DiscoveryStep directly, return an empty device list from
 * the Matter poll, advance fake timers past the 5-minute auto-stop bound,
 * then read the DOM. (STOP_AFTER_TOTAL_SEC = 300.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { MatterGrouped } from "@/lib/types";

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

const fetchMatterDevicesMock = vi.fn(async () => emptyGrouped);
const fetchMatterCapabilitiesMock = vi.fn(async () => ({
  bleCommissioning: true,
}));
const commissionMatterDeviceMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: () => fetchMatterDevicesMock(),
  fetchMatterCapabilities: () => fetchMatterCapabilitiesMock(),
  commissionMatterDevice: (code: string) => commissionMatterDeviceMock(code),
}));

import { DiscoveryStep } from "./DiscoveryStep";

/** Advance fake timers far enough to cross the 5-minute auto-stop bound. */
async function driveToStopped() {
  for (let i = 0; i < 305; i++) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }
}

describe("DiscoveryStep zero-results empty state (WARP-937)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMatterDevicesMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders animated skeleton placeholders while actively scanning", async () => {
    render(<DiscoveryStep onContinue={() => {}} />);

    // Right after mount we're in the `active` phase with no devices yet — the
    // scanning skeletons should be present so the surface doesn't look empty.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("discovery-skeletons")).toBeInTheDocument();
    // No completed-empty state while still scanning.
    expect(screen.queryByTestId("discovery-empty")).not.toBeInTheDocument();
  });

  it("shows the 'no devices found' empty state when scanning stops with zero devices", async () => {
    render(<DiscoveryStep onContinue={() => {}} />);
    await driveToStopped();

    const empty = screen.getByTestId("discovery-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/didn't find any devices/i);
  });

  it("stops rendering the perpetual animated skeletons once scanning has stopped", async () => {
    render(<DiscoveryStep onContinue={() => {}} />);
    await driveToStopped();

    // The skeleton placeholders must NOT keep animating in the stopped state —
    // that's the bug WARP-937 fixes.
    expect(screen.queryByTestId("discovery-skeletons")).not.toBeInTheDocument();
  });

  it("offers a way to scan again from the empty state", async () => {
    render(<DiscoveryStep onContinue={() => {}} />);
    await driveToStopped();

    // The stopped surface (which now also carries the empty state) keeps the
    // "Scan again" affordance so a late-arriving device still has a path.
    const scanAgain = screen.getByRole("button", { name: /scan again/i });
    expect(scanAgain).toBeInTheDocument();
    expect(scanAgain.className).toMatch(/dp-btn-secondary/);
  });
});
