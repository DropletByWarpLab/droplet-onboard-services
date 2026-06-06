/**
 * WARP-816 — WifiScanPanel: distinguish "scanning unavailable while the Droplet
 * broadcasts its own Wi-Fi" (typed SCAN_UNSUPPORTED signal off the orchestrator)
 * from a genuine "no networks found" empty scan.
 *
 * On the single-box the scan radio is in AP mode and can't station-scan; the
 * orchestrator returns a typed RouterStatusError (code SCAN_UNSUPPORTED) instead
 * of an empty list. The panel must render calm copy + disable the Scan control,
 * never leak the raw code (consistent with WARP-807). A genuine empty scan on a
 * scannable radio still renders the normal empty state with Scan enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { WifiScanPanel } from "../WifiScanPanel";
import { scanWifiNetworks, RouterStatusError } from "@/lib/api";
import type { WirelessScanResult } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // keep the real RouterStatusError class so `instanceof` checks hold
    scanWifiNetworks: vi.fn(),
  };
});

const scanMock = vi.mocked(scanWifiNetworks);

function net(overrides: Partial<WirelessScanResult> = {}): WirelessScanResult {
  return {
    ssid: "HomeNet",
    bssid: "AA:BB:CC:DD:EE:FF",
    channel: 6,
    signal: -42,
    quality: 60,
    quality_max: 70,
    encryption: { enabled: true },
    ...overrides,
  };
}

beforeEach(() => {
  scanMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("WifiScanPanel", () => {
  it("starts idle with an enabled Scan control and a prompt", () => {
    render(<WifiScanPanel />);
    const scan = screen.getByRole("button", { name: /scan/i });
    expect(scan).toBeEnabled();
    expect(screen.getByText(/click scan/i)).toBeInTheDocument();
  });

  it("renders the results list after a successful scan", async () => {
    scanMock.mockResolvedValue([net({ ssid: "HomeNet" }), net({ ssid: "Guest", bssid: "11:22:33:44:55:66" })]);
    render(<WifiScanPanel />);

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    expect(await screen.findByText("HomeNet")).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
    // Scan stays available for a re-scan.
    expect(screen.getByRole("button", { name: /scan/i })).toBeEnabled();
  });

  it("renders the normal empty state (Scan still enabled) when a scannable radio finds nothing", async () => {
    scanMock.mockResolvedValue([]);
    render(<WifiScanPanel />);

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    expect(await screen.findByText(/no networks found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scan/i })).toBeEnabled();
  });

  it("on the typed SCAN_UNSUPPORTED signal: shows calm 'broadcasting' copy and disables Scan — no empty list", async () => {
    scanMock.mockRejectedValue(
      new RouterStatusError(
        "SCAN_UNSUPPORTED",
        "Scanning isn't available while your Droplet is broadcasting its own Wi-Fi network.",
        409,
      ),
    );
    render(<WifiScanPanel />);

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    // Calm, explanatory copy — keyed on "broadcasting", not on the raw code.
    expect(await screen.findByText(/broadcasting/i)).toBeInTheDocument();
    // The "found nothing" empty state must NOT be what the user sees here.
    expect(screen.queryByText(/no networks found/i)).not.toBeInTheDocument();
    // Scan control is disabled (or removed) — re-scanning can't help on this shape.
    expect(screen.queryByRole("button", { name: /^scan$/i })).toBeNull();
  });

  it("never leaks the raw SCAN_UNSUPPORTED code to the UI", async () => {
    scanMock.mockRejectedValue(
      new RouterStatusError("SCAN_UNSUPPORTED", "Scanning isn't available while broadcasting.", 409),
    );
    const { container } = render(<WifiScanPanel />);

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    await screen.findByText(/broadcasting/i);
    expect(container.textContent).not.toContain("SCAN_UNSUPPORTED");
    expect(container.textContent).not.toContain("409");
  });

  it("a non-unsupported error shows a calm retryable message and keeps Scan enabled", async () => {
    scanMock.mockRejectedValue(new Error("network blip"));
    render(<WifiScanPanel />);

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    expect(await screen.findByText(/couldn't scan|could not scan|try again/i)).toBeInTheDocument();
    // A transient failure is recoverable — Scan stays enabled so the user can retry.
    expect(screen.getByRole("button", { name: /scan/i })).toBeEnabled();
    // And it isn't mislabeled as the AP-mode unavailable state.
    expect(screen.queryByText(/broadcasting/i)).not.toBeInTheDocument();
  });
});
