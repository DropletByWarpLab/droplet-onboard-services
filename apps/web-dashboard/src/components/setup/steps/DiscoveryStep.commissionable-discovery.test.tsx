/**
 * WARP-1281 — the setup wizard's Devices step never found factory-new
 * Matter devices because it only polled GET /api/matter/devices (the
 * ALREADY-COMMISSIONED list). A commissionable (not-yet-paired) device
 * can never appear there, so a real smart light sat invisible for the
 * whole 5-minute scan window.
 *
 * The fix threads GET /api/matter/discover (the active mDNS
 * commissionable-device browse) through the same scan lifecycle:
 *
 *   1. While scanning (active + downshifted phases) the step ALSO runs
 *      discovery — serially, one browse in flight at a time (each is an
 *      active ~15s mDNS browse server-side), chained with a pause and
 *      bounded by the WARP-298 scan lifecycle + React cleanup.
 *   2. Commissionable devices render as "ready to pair" cards guiding
 *      the customer to the pairing-code input (Matter cannot
 *      auto-commission without the code).
 *   3. Discovery answering 503 ("Matter controller not started") — or
 *      discovery/commissioned-poll failing 3+ times in a row — replaces
 *      the fake scanning skeletons with an explicit "smart home isn't
 *      available" state that keeps quietly retrying so it self-heals.
 *
 * Harness mirrors DiscoveryStep.empty-state.test.tsx (fake timers +
 * module mock); async timer advances flush the promise chain so the
 * serial browse scheduling is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { MatterDiscoveredDevice, MatterGrouped } from "@/lib/types";

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
const discoverMatterDevicesMock = vi.fn(
  async (): Promise<{ devices: MatterDiscoveredDevice[]; count: number }> => ({
    devices: [],
    count: 0,
  }),
);

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: () => fetchMatterDevicesMock(),
  fetchMatterCapabilities: () => fetchMatterCapabilitiesMock(),
  commissionMatterDevice: (code: string) => commissionMatterDeviceMock(code),
  discoverMatterDevices: () => discoverMatterDevicesMock(),
}));

import { DiscoveryStep } from "./DiscoveryStep";

const smartBulb = {
  deviceIdentifier: "A1B2C3D4E5F6",
  discriminator: 3840,
  vendorId: 4660,
  productId: 22,
  deviceName: "Smart Bulb",
  deviceType: 257,
  commissioningMode: 1,
  addresses: [{ ip: "192.168.20.57", port: 5540, type: "ipv4" }],
};

const controllerDown503 = () =>
  Object.assign(new Error("Failed to discover devices: 503"), {
    status: 503,
  });

/** Flush pending microtasks (resolve mocked fetches) inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("DiscoveryStep commissionable-device discovery (WARP-1281)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMatterDevicesMock.mockReset();
    fetchMatterDevicesMock.mockImplementation(async () => emptyGrouped);
    discoverMatterDevicesMock.mockReset();
    discoverMatterDevicesMock.mockImplementation(async () => ({
      devices: [],
      count: 0,
    }));
    fetchMatterCapabilitiesMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders devices found by the commissionable browse as 'ready to pair' cards with pairing-code guidance", async () => {
    discoverMatterDevicesMock.mockImplementation(async () => ({
      devices: [smartBulb],
      count: 1,
    }));
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    const readyList = screen.getByTestId("discovery-ready-to-pair");
    expect(readyList).toBeInTheDocument();
    expect(readyList).toHaveTextContent("Smart Bulb");
    // The pairing-code input stays the add path — the card must say so.
    expect(readyList).toHaveTextContent(/pairing code printed on it below/i);
    // Real content on the surface — no scanning skeletons alongside it.
    expect(
      screen.queryByTestId("discovery-skeletons"),
    ).not.toBeInTheDocument();
  });

  it("falls back to a generic device name when mDNS doesn't advertise one", async () => {
    discoverMatterDevicesMock.mockImplementation(async () => ({
      devices: [{ ...smartBulb, deviceName: undefined }],
      count: 1,
    }));
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    expect(screen.getByTestId("discovery-ready-to-pair")).toHaveTextContent(
      /matter device/i,
    );
  });

  it("replaces the scanning skeletons with the unavailable state when discovery answers 503", async () => {
    discoverMatterDevicesMock.mockImplementation(async () => {
      throw controllerDown503();
    });
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    // Explicit "service down" state, not an endless fake scan.
    const unavailable = screen.getByTestId("discovery-unavailable");
    expect(unavailable).toBeInTheDocument();
    expect(unavailable).toHaveTextContent(/isn't available/i);
    // A11y (VpnStep convention): polite live region — the state is
    // non-urgent and self-healing, so role="status", never "alert".
    expect(unavailable).toHaveAttribute("role", "status");
    expect(unavailable).toHaveAttribute("aria-live", "polite");
    expect(
      screen.queryByTestId("discovery-skeletons"),
    ).not.toBeInTheDocument();

    // Recovery affordances stay reachable: Scan again (with the
    // dp-btn-secondary token) plus the wizard's Continue / Skip.
    const scanAgain = screen.getByRole("button", { name: /scan again/i });
    expect(scanAgain.className).toMatch(/dp-btn-secondary/);
    expect(
      screen.getByRole("button", { name: /continue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("keeps quietly retrying while unavailable and recovers to scanning once the controller comes back", async () => {
    let calls = 0;
    discoverMatterDevicesMock.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw controllerDown503();
      return { devices: [], count: 0 };
    });
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    expect(screen.getByTestId("discovery-unavailable")).toBeInTheDocument();

    // The browse chain keeps running in the background (self-heal) —
    // advance past the retry gap and observe another attempt.
    await advance(3_500);
    expect(discoverMatterDevicesMock.mock.calls.length).toBeGreaterThan(1);

    // Next attempt succeeds → back to the honest scanning surface.
    await advance(3_500);
    expect(
      screen.queryByTestId("discovery-unavailable"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("discovery-skeletons")).toBeInTheDocument();
  });

  it("trips the unavailable state after 3 consecutive non-503 discovery failures (not before)", async () => {
    discoverMatterDevicesMock.mockImplementation(async () => {
      throw new Error("network flake");
    });
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    // One failure is not a verdict — still scanning.
    expect(
      screen.queryByTestId("discovery-unavailable"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("discovery-skeletons")).toBeInTheDocument();

    // Second failure — still scanning.
    await advance(3_500);
    expect(
      screen.queryByTestId("discovery-unavailable"),
    ).not.toBeInTheDocument();

    // Third consecutive failure — the step stops pretending.
    await advance(3_500);
    expect(screen.getByTestId("discovery-unavailable")).toBeInTheDocument();
    expect(
      screen.queryByTestId("discovery-skeletons"),
    ).not.toBeInTheDocument();
  });

  it("trips the unavailable state when the commissioned-device poll fails 3+ times in a row", async () => {
    fetchMatterDevicesMock.mockImplementation(async () => {
      throw new Error("orchestrator unreachable");
    });
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    // Poll cadence is 3s — three consecutive failures land by ~9s.
    await advance(10_000);
    expect(screen.getByTestId("discovery-unavailable")).toBeInTheDocument();
  });

  it("keeps the unavailable verdict while the commissioned poll returns 200-empty (poll success must NOT clear it)", async () => {
    // Regression pin for the original WARP-1281 masking bug: GET
    // /matter/devices answers 200-with-empty-groups even when the
    // controller is down, so a succeeding poll proves nothing — only a
    // discovery SUCCESS may clear the verdict. The browse 503s once and
    // then HANGS (never settles): if a poll-200 cleared the verdict,
    // nothing could re-trip it before the assertions below, so a
    // regression restoring the masking behavior fails here — unlike the
    // plain 503 test, where the next 503 in the chain could re-trip the
    // state between the poll settle and the assertion.
    let discoverCalls = 0;
    discoverMatterDevicesMock.mockImplementation(() => {
      discoverCalls += 1;
      if (discoverCalls === 1) return Promise.reject(controllerDown503());
      // In flight forever — no further discovery settle can influence
      // the verdict.
      return new Promise<{ devices: MatterDiscoveredDevice[]; count: number }>(
        () => {},
      );
    });
    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();
    expect(screen.getByTestId("discovery-unavailable")).toBeInTheDocument();

    // Drive several 3s poll cycles — each commissioned poll succeeds
    // with empty groups. The verdict must hold through every one.
    for (let i = 0; i < 4; i++) {
      await advance(3_000);
      expect(screen.getByTestId("discovery-unavailable")).toBeInTheDocument();
      expect(
        screen.queryByTestId("discovery-skeletons"),
      ).not.toBeInTheDocument();
    }
    // Guard against passing vacuously: the polls really did keep
    // running and succeeding while the verdict held.
    expect(fetchMatterDevicesMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("runs discovery serially — never two browses in flight, next kicks only after the previous settles", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    discoverMatterDevicesMock.mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<{ devices: MatterDiscoveredDevice[]; count: number }>(
        (resolve) => {
          pending.push(() => {
            inFlight -= 1;
            resolve({ devices: [], count: 0 });
          });
        },
      );
    });

    render(<DiscoveryStep onContinue={() => {}} />);
    await flush();
    expect(discoverMatterDevicesMock).toHaveBeenCalledTimes(1);

    // A browse is a slow (~15s) server-side operation. While one is in
    // flight NO second request may be issued, no matter how much time
    // passes.
    await advance(30_000);
    expect(discoverMatterDevicesMock).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    // Settle the first browse → the next one kicks after the retry gap.
    await act(async () => {
      pending.shift()?.();
      await Promise.resolve();
    });
    await advance(3_500);
    expect(discoverMatterDevicesMock).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it("stops the discovery chain at the scan lifecycle bound (phase 'stopped') and on unmount", async () => {
    const { unmount } = render(<DiscoveryStep onContinue={() => {}} />);
    await flush();

    // Drive past the 5-minute auto-stop (STOP_AFTER_TOTAL_SEC = 300).
    await advance(305_000);
    expect(screen.getByTestId("discovery-stopped")).toBeInTheDocument();

    const callsAtStop = discoverMatterDevicesMock.mock.calls.length;
    await advance(30_000);
    expect(discoverMatterDevicesMock.mock.calls.length).toBe(callsAtStop);

    // Unmount mid-anything must leave no scheduled browse behind.
    unmount();
    await advance(30_000);
    expect(discoverMatterDevicesMock.mock.calls.length).toBe(callsAtStop);
  });
});
