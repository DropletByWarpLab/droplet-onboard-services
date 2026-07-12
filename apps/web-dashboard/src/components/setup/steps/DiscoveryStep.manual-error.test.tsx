/**
 * WARP-856 (item 2) — the wizard's manual pairing path must never render
 * `e.message` verbatim. A non-JSON error body from the commissioning route
 * yields "Failed to commission device: 502" — raw transport text on a
 * first-run screen. The catch now routes through `translateError(e,
 * "device")`, so the curated 502/503/504 commissioning copy (or the calm
 * generic fallback) is what the customer reads.
 *
 * Harness mirrors DiscoveryStep.blenotice.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

async function submitPairingCode(code: string) {
  const input = await screen.findByLabelText(/have a pairing code/i);
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: /add device/i }));
}

describe("DiscoveryStep manual pairing — friendly errors (WARP-856)", () => {
  beforeEach(() => {
    fetchMatterDevicesMock.mockClear();
    fetchMatterCapabilitiesMock.mockClear();
    commissionMatterDeviceMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a raw 502 transport message onto the curated discovery copy", async () => {
    commissionMatterDeviceMock.mockRejectedValueOnce(
      Object.assign(new Error("Failed to commission device: 502"), {
        status: 502,
      }),
    );
    render(<DiscoveryStep onContinue={() => {}} />);
    await submitPairingCode("749701123365521327694");

    expect(
      await screen.findByText(/couldn't find the device on the network/i),
    ).toBeInTheDocument();
    // The raw transport text never reaches the customer.
    expect(
      screen.queryByText(/failed to commission device: 502/i),
    ).not.toBeInTheDocument();
  });

  it("maps the 503 controller-starting message onto the still-starting copy", async () => {
    commissionMatterDeviceMock.mockRejectedValueOnce(
      Object.assign(new Error("Matter controller not started"), {
        status: 503,
      }),
    );
    render(<DiscoveryStep onContinue={() => {}} />);
    await submitPairingCode("749701123365521327694");

    expect(
      await screen.findByText(/smart-home service is still starting up/i),
    ).toBeInTheDocument();
    // The controller jargon never reaches the customer.
    expect(
      screen.queryByText(/matter controller not started/i),
    ).not.toBeInTheDocument();
  });

  it("maps the 504 timeout onto the pairing-mode retry copy", async () => {
    commissionMatterDeviceMock.mockRejectedValueOnce(
      Object.assign(new Error("Failed to commission device: 504"), {
        status: 504,
      }),
    );
    render(<DiscoveryStep onContinue={() => {}} />);
    await submitPairingCode("749701123365521327694");

    expect(
      await screen.findByText(/pairing mode again/i),
    ).toBeInTheDocument();
  });
});
