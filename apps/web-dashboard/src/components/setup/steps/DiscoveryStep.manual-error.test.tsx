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

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: () => fetchMatterDevicesMock(),
  fetchMatterCapabilities: () => fetchMatterCapabilitiesMock(),
  commissionMatterDevice: (code: string) => commissionMatterDeviceMock(code),
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
