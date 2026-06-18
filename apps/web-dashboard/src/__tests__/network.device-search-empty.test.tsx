/**
 * WARP-873 — when the device search matches nothing, the Devices tab rendered a
 * blank area (the only empty state checked the RAW device count, so a non-empty
 * device list with zero matches fell through to a grid of empty sections). It
 * should instead show a "no devices match" state with a clear-search affordance.
 *
 * DevicesTab pulls only useNetworkDevices + useNetworkGroups; the grid sections
 * and coverage panel are stubbed so the test stays focused on the search branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

import { DevicesTab } from "@/app/network/page";

const DEVICES = [
  { mac: "aa", displayName: "Living Room TV", hostname: "tv", vendor: "Samsung", lastIp: "192.168.1.5", groups: [] },
  { mac: "bb", displayName: "Office Laptop", hostname: "laptop", vendor: "Dell", lastIp: "192.168.1.6", groups: [] },
];

beforeEach(() => {
  useNetworkDevicesMock.mockReset();
  useNetworkGroupsMock.mockReset();
  useNetworkDevicesMock.mockReturnValue({
    data: { devices: DEVICES },
    isLoading: false,
    mutate: vi.fn(),
  });
  useNetworkGroupsMock.mockReturnValue({
    data: { groups: [] },
    mutate: vi.fn(),
  });
});

describe("Network Devices tab — no-match search state (WARP-873)", () => {
  it("renders the grid when devices are present", () => {
    render(<DevicesTab />);
    expect(screen.queryAllByTestId("device-grid").length).toBeGreaterThan(0);
  });

  it("shows a no-match empty state when the search matches no device", () => {
    render(<DevicesTab />);
    fireEvent.change(screen.getByLabelText("Search devices"), {
      target: { value: "zzz-no-such-device" },
    });
    expect(screen.queryAllByTestId("device-grid")).toHaveLength(0);
    expect(screen.getByText(/no devices match/i)).toBeInTheDocument();
  });

  it("restores the grid when the search is cleared via the affordance", () => {
    render(<DevicesTab />);
    fireEvent.change(screen.getByLabelText("Search devices"), {
      target: { value: "zzz-no-such-device" },
    });
    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(screen.queryAllByTestId("device-grid").length).toBeGreaterThan(0);
    expect(screen.queryByText(/no devices match/i)).not.toBeInTheDocument();
  });
});
