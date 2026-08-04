import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";
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
    manualBlock: false,
    lastAppliedBlocked: null,
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

  it("invokes onOpen with the device when the card wrapper is clicked", () => {
    const onOpen = vi.fn();
    const device = makeDevice();
    render(<DeviceCard device={device} onOpen={onOpen} />);
    // The card wrapper has aria-label "Open <name> details" — the inner
    // Block button has its own distinct label so it no longer shadows.
    fireEvent.click(screen.getByRole("button", { name: /Open .* details/ }));
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

  it("renders a colored dot next to group name when color is set", () => {
    const device = makeDevice({ groups: [{ id: "g1", name: "Living Room", color: "#FF0000" }] });
    const { container } = render(<DeviceCard device={device} onOpen={vi.fn()} />);
    const chip = Array.from(container.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("Living Room"),
    );
    expect(chip).toBeDefined();
    // Chip should have the shell's inner-surface background (readable), NOT g.color as background
    expect(chip!.className).toContain("bg-[var(--card-inner)]");
    // The colored dot should exist with the group color as backgroundColor inline style
    const dot = chip!.querySelector("span[style]");
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.backgroundColor).toMatch(/rgb|#/);
  });

  it("renders 30 sparkline bars when given 30 presence days", () => {
    const presenceDays: DevicePresenceDay[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      seenMinutes: 120,
    }));
    render(<DeviceCard device={makeDevice({ presenceDays })} onOpen={() => {}} />);
    expect(screen.getAllByTestId("sparkline-bar")).toHaveLength(30);
  });

  // --- WARP-98: Quick Schedule hover action ---

  it("renders a Quick Schedule button in the hover action row", () => {
    render(<DeviceCard device={makeDevice()} onOpen={() => {}} />);
    expect(
      screen.getByRole("button", { name: /quick schedule/i }),
    ).toBeInTheDocument();
  });

  it("clicking Quick Schedule does NOT fire onOpen (stopPropagation)", () => {
    const onOpen = vi.fn();
    // Wrap in SWRConfig because the popover (mounted on click) uses SWR.
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DeviceCard device={makeDevice()} onOpen={onOpen} />
      </SWRConfig>,
    );
    fireEvent.click(screen.getByRole("button", { name: /quick schedule/i }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  // --- WARP-292: always-visible row actions ---

  it("Quick Schedule + Block action row is not hidden behind opacity-0 hover", () => {
    render(<DeviceCard device={makeDevice()} onOpen={() => {}} />);
    const quick = screen.getByRole("button", { name: /quick schedule/i });
    // The action-row container holds both buttons. After WARP-292 it must
    // not start at opacity-0 — touch + keyboard users need to see them.
    const actionRow = quick.closest("div")?.parentElement;
    expect(actionRow?.className ?? "").not.toMatch(/opacity-0/);
  });

  it("Block button aria-label names the device (displayName ?? hostname ?? vendor)", () => {
    render(
      <DeviceCard
        device={makeDevice({ displayName: "Romain's MacBook" })}
        onOpen={() => {}}
      />,
    );
    // Block button currently uses the generic "Block device" / "Unblock
    // device". WARP-292 sharpens that to include the row identifier so
    // SR users hear which device is being toggled.
    expect(
      screen.getByRole("button", { name: /block .*romain's macbook/i }),
    ).toBeInTheDocument();
  });
});
