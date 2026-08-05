/**
 * WARP-1726 — the Devices grid must not collapse while it is still loading.
 *
 * Two things made the reload loop violent rather than merely annoying. The
 * empty state was gated on SWR's `isLoading`, which is true only for the very
 * FIRST request of a key — so the moment a cold load failed (a 401 during a
 * token rotation) or a retry started, the tab asserted "Your router hasn't seen
 * any devices yet" about a network full of devices. And the loading state was a
 * bare centred spinner, so the page briefly became a few hundred pixels tall;
 * the browser then clamped the restored scroll offset to the bottom of that
 * short page, which is the "scroll jumps to the bottom" half of the report.
 *
 * Same fixture shape as network.device-search-empty.test.tsx: only the two data
 * hooks matter, so the grid sections and coverage panel are stubbed out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useNetworkDevicesMock = vi.fn();
const useNetworkGroupsMock = vi.fn();

vi.mock("@/lib/hooks/useNetworkDevices", () => ({
  useNetworkDevices: (...a: any[]) => useNetworkDevicesMock(...a),
}));
vi.mock("@/lib/hooks/useNetworkGroups", () => ({
  useNetworkGroups: (...a: any[]) => useNetworkGroupsMock(...a),
}));
vi.mock("@/components/network/CoverageExtendersPanel", () => ({
  CoverageExtendersPanel: () => null,
}));
vi.mock("@/components/network/DeviceGridSection", () => ({
  DeviceGridSection: () => <div data-testid="device-grid" />,
}));

import { DevicesTab } from "@/components/network/DevicesTab";

const EMPTY_STATE_COPY = /hasn['’]t seen any devices yet/i;

beforeEach(() => {
  useNetworkDevicesMock.mockReset();
  useNetworkGroupsMock.mockReset();
  useNetworkGroupsMock.mockReturnValue({ data: { groups: [] }, mutate: vi.fn() });
});

describe("Devices tab — no false empty state while loading (WARP-1726)", () => {
  it("hides the empty state during the first load", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.queryByText(EMPTY_STATE_COPY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // The regression that actually bit: SWR reports `isLoading` for the first
  // request only. A retry after a failed cold load is `isValidating` with no
  // data — which read as "loaded, and there are zero devices".
  it("hides the empty state while a retry is in flight with no data yet", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: true,
      error: new Error("401"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.queryByText(EMPTY_STATE_COPY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("reserves a stable height while loading so the page cannot collapse", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    const skeleton = screen.getByRole("status");
    expect(parseInt(skeleton.style.minHeight, 10)).toBeGreaterThanOrEqual(300);
  });

  it("still shows the empty state once a response confirms zero devices", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: { devices: [] },
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByText(EMPTY_STATE_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // A load that failed and is NOT being retried keeps its existing fallback —
  // the card with the Retry affordance — rather than rendering nothing at all,
  // which would collapse the page even harder than the state we are fixing.
  it("keeps a retry affordance when a failed load has settled", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: false,
      error: new Error("500"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
