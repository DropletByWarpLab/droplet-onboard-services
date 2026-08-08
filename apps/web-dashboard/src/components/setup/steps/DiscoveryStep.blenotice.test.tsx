/**
 * WARP-851 — honest BLE notice in the setup wizard's discovery step.
 *
 * The box has no Bluetooth commissioning path (matter.js: "BLE is not
 * enabled on this platform"), so devices that need BLE for first-time
 * setup can never pair, no matter how many times the customer retries.
 * When GET /api/matter/capabilities reports bleCommissioning=false, the
 * step shows a plain notice near the pairing-code input. Capability
 * unknown (fetch failed / controller booting) shows nothing — we don't
 * scare the customer on a guess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
const fetchMatterCapabilitiesMock = vi.fn();
const commissionMatterDeviceMock = vi.fn();
// WARP-1281: the step also runs the commissionable-device browse while
// scanning. Stub it healthy-and-empty — with the module mocked, a missing
// export would make every browse throw and (by design) trip the
// service-unavailable state under enough fake-timer advancement.
const discoverMatterDevicesMock = vi.fn(async () => ({
  devices: [],
  count: 0,
}));

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: () => fetchMatterDevicesMock(),
  fetchMatterCapabilities: () => fetchMatterCapabilitiesMock(),
  commissionMatterDevice: (code: string) => commissionMatterDeviceMock(code),
  discoverMatterDevices: () => discoverMatterDevicesMock(),
}));

import { DiscoveryStep } from "./DiscoveryStep";

describe("DiscoveryStep BLE-unavailable notice (WARP-851)", () => {
  beforeEach(() => {
    fetchMatterDevicesMock.mockClear();
    fetchMatterCapabilitiesMock.mockReset();
    commissionMatterDeviceMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the notice near the pairing-code input when BLE commissioning is unavailable", async () => {
    fetchMatterCapabilitiesMock.mockResolvedValue({ bleCommissioning: false });
    render(<DiscoveryStep onContinue={() => {}} />);

    const notice = await screen.findByTestId("ble-unavailable-notice");
    expect(notice).toHaveTextContent(/already on your workspace wi-?fi/i);
    expect(notice).toHaveTextContent(
      /bluetooth for first-time setup aren't supported yet/i,
    );
    // It must live alongside the manual pairing-code entry.
    expect(screen.getByLabelText(/have a pairing code/i)).toBeInTheDocument();
  });

  it("shows no notice when BLE commissioning is available", async () => {
    fetchMatterCapabilitiesMock.mockResolvedValue({ bleCommissioning: true });
    render(<DiscoveryStep onContinue={() => {}} />);

    await waitFor(() =>
      expect(fetchMatterCapabilitiesMock).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId("ble-unavailable-notice"),
    ).not.toBeInTheDocument();
  });

  it("shows no notice when the capability probe fails (unknown ≠ unavailable)", async () => {
    fetchMatterCapabilitiesMock.mockRejectedValue(new Error("controller booting"));
    render(<DiscoveryStep onContinue={() => {}} />);

    await waitFor(() =>
      expect(fetchMatterCapabilitiesMock).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId("ble-unavailable-notice"),
    ).not.toBeInTheDocument();
  });
});
