import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeviceCard } from "../DeviceCard";
import type { EnrichedNetworkDevice, DevicePresenceDay } from "@/lib/types";

function makeDevice(overrides: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: "aa:bb:cc:dd:ee:01",
    displayName: "Romain's MacBook",
    icon: null,
    notes: null,
    vendor: "Apple",
    hostname: "romain-mbp",
    lastIp: "192.168.1.42",
    firstSeen: new Date(Date.now() - 86_400_000 * 10).toISOString(),
    lastSeen: new Date().toISOString(),
    isBlocked: false,
    online: true,
    groups: [],
    presenceDays: [],
    ...overrides,
  };
}

describe("DeviceCard", () => {
  it("renders displayName when present", () => {
    render(<DeviceCard device={makeDevice()} onOpen={() => {}} />);
    expect(screen.getByText("Romain's MacBook")).toBeInTheDocument();
  });

  it("falls back to hostname, then vendor, then 'Device'", () => {
    const { rerender } = render(
      <DeviceCard device={makeDevice({ displayName: null })} onOpen={() => {}} />,
    );
    expect(screen.getByText("romain-mbp")).toBeInTheDocument();

    rerender(
      <DeviceCard
        device={makeDevice({ displayName: null, hostname: null })}
        onOpen={() => {}}
      />,
    );
    // Vendor appears both as the displayName and in the subtitle; ensure at least one match.
    expect(screen.getAllByText(/Apple/).length).toBeGreaterThan(0);

    rerender(
      <DeviceCard
        device={makeDevice({ displayName: null, hostname: null, vendor: null })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Device")).toBeInTheDocument();
  });

  it("shows the online dot when online = true", () => {
    render(<DeviceCard device={makeDevice({ online: true })} onOpen={() => {}} />);
    expect(screen.getByLabelText("online")).toBeInTheDocument();
  });

  it("shows 'last seen Xh ago' when offline", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    render(
      <DeviceCard
        device={makeDevice({ online: false, lastSeen: threeHoursAgo })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/last seen 3h ago/)).toBeInTheDocument();
  });

  it("invokes onOpen with the device when clicked", () => {
    const onOpen = vi.fn();
    const device = makeDevice();
    render(<DeviceCard device={device} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(device);
  });

  it("renders group chips", () => {
    render(
      <DeviceCard
        device={makeDevice({
          groups: [
            { id: "g1", name: "Work" },
            { id: "g2", name: "Kids" },
          ],
        })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Kids")).toBeInTheDocument();
  });

  it("renders 30 sparkline bars when given 30 presence days", () => {
    const presenceDays: DevicePresenceDay[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      seenMinutes: 120,
    }));
    render(<DeviceCard device={makeDevice({ presenceDays })} onOpen={() => {}} />);
    expect(screen.getAllByTestId("sparkline-bar")).toHaveLength(30);
  });
});
