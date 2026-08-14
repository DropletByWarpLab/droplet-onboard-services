/**
 * WARP-1715 — the coverage AP is part of the household network.
 *
 * Before the join, an approved AP appeared in the Devices grid as an anonymous
 * DHCP lease ("Unknown vendor", generic icon), and every station on its radios
 * was indistinguishable from a wired device — no signal, no attribution.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceCard } from "../DeviceCard";
import type { EnrichedNetworkDevice } from "@/lib/types";

vi.mock("@/lib/hooks/useDeviceBlockMutation", () => ({
  useDeviceBlockMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/useDeviceMutations", () => ({ toastForError: vi.fn() }));

function device(over: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: "AA:BB:CC:00:00:01",
    displayName: null,
    icon: null,
    notes: null,
    vendor: null,
    hostname: null,
    lastIp: "192.168.9.183",
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    isBlocked: false,
    manualBlock: false,
    online: true,
    groups: [],
    ...over,
  };
}

describe("DeviceCard — access points (WARP-1715)", () => {
  it("describes an AP by what it is instead of 'Unknown vendor'", () => {
    render(
      <DeviceCard
        device={device({
          displayName: "Living-room AP",
          isAccessPoint: true,
          apModel: "NWA50BE",
        })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Living-room AP")).toBeInTheDocument();
    expect(screen.getByText(/NWA50BE/)).toBeInTheDocument();
    expect(screen.queryByText(/Unknown vendor/)).not.toBeInTheDocument();
  });

  it("falls back to 'Access point' when the model is unknown", () => {
    render(
      <DeviceCard
        device={device({ displayName: "Upstairs", isAccessPoint: true, apModel: null })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/Access point/)).toBeInTheDocument();
  });

  it("attributes a station to the AP it joined through", () => {
    render(
      <DeviceCard
        device={device({ displayName: "Stefan's phone", viaAp: "Living-room AP" })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("via Living-room AP")).toBeInTheDocument();
  });

  it("says nothing about an AP for a device on the router's own radio", () => {
    render(<DeviceCard device={device({ displayName: "Desk PC" })} onOpen={vi.fn()} />);
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
  });

  it("still shows the vendor for an ordinary device", () => {
    render(
      <DeviceCard device={device({ displayName: "Desk PC", vendor: "Dell" })} onOpen={vi.fn()} />,
    );
    expect(screen.getByText(/Dell/)).toBeInTheDocument();
  });
});
