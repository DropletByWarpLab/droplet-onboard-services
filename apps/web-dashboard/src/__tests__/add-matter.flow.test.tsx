/**
 * /devices/add-matter — three-state flow test.
 *
 * Scan → commission → done, plus the failure branch back to scan with
 * an error banner. We mock @/lib/api and next/navigation; the scanner
 * component itself has dedicated tests, so here we just verify the
 * page wires onResult → commissionMatterDevice → success/error UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddMatterDevicePage from "@/app/devices/add-matter/page";
import { commissioningPhaseCopy } from "@/app/devices/add-matter/commissioning-copy";

// next/navigation: useRouter is the only piece consumed.
const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy }),
}));

// @zxing mocked at module scope — BrowserMultiFormatReader from
// @zxing/browser, NotFoundException from @zxing/library.
vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: class {
    reset = vi.fn();
    decodeFromVideoElement = vi.fn();
  },
}));
vi.mock("@zxing/library", () => ({
  NotFoundException: class extends Error {},
}));

// Spy on the API calls — commission drives the success vs. failure
// branches; capabilities (WARP-851/WARP-1035) drives notice + spinner copy.
const commissionSpy = vi.fn();
const capabilitiesSpy = vi.fn();
vi.mock("@/lib/api", () => ({
  commissionMatterDevice: (code: string) => commissionSpy(code),
  // WARP-851: the page probes capabilities at mount; without this stub
  // the probe's fail-soft catch silently masks a missing mock instead
  // of exercising a real resolution.
  fetchMatterCapabilities: () => capabilitiesSpy(),
}));

describe("AddMatterDevicePage — three-state flow", () => {
  beforeEach(() => {
    commissionSpy.mockReset();
    pushSpy.mockReset();
    capabilitiesSpy.mockReset();
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: true,
      apSsid: "Droplet",
    });
  });

  it("renders the scan phase initially with the manual-entry input", async () => {
    render(<AddMatterDevicePage />);
    expect(screen.getByText(/add a smart device/i)).toBeInTheDocument();
    // The scanner is lazy-loaded via next/dynamic (WARP-102), so the
    // manual-entry input lands a tick after first render — findBy, not getBy.
    expect(
      await screen.findByLabelText(/enter the pairing code/i),
    ).toBeInTheDocument();
  });

  it("submits a manually-entered code to commissionMatterDevice and shows success", async () => {
    // Delay the mock resolution so the test can observe the in-flight
    // progress UI before it transitions to success. Otherwise vitest
    // sees the resolved state on the next microtask and the progress
    // view never gets a chance to render.
    let resolveCommission!: (v: { nodeId: string }) => void;
    commissionSpy.mockReturnValueOnce(
      new Promise((res) => {
        resolveCommission = res;
      }),
    );
    render(<AddMatterDevicePage />);

    fireEvent.change(await screen.findByLabelText(/enter the pairing code/i), {
      target: { value: "3497-0112-332" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));

    // Hyphens stripped before submit
    expect(commissionSpy).toHaveBeenCalledWith("34970112332");

    // While in-flight, the progress view appears
    expect(
      await screen.findByText(/finding the device on your network/i),
    ).toBeInTheDocument();

    // Resolve and watch the success card replace the spinner
    resolveCommission({ nodeId: "12345" });
    expect(await screen.findByText(/device added/i)).toBeInTheDocument();
    expect(screen.getByText(/node 12345/i)).toBeInTheDocument();
  });

  it("returns to scan with an error banner when commissioning fails", async () => {
    commissionSpy.mockRejectedValueOnce(
      new Error("PASE failed: device not found"),
    );
    render(<AddMatterDevicePage />);

    fireEvent.change(await screen.findByLabelText(/enter the pairing code/i), {
      target: { value: "00000000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't reach that device/i);
    // Scanner is back so the user can retry
    expect(screen.getByLabelText(/enter the pairing code/i)).toBeInTheDocument();
  });

  it("Go to devices routes to /devices after success", async () => {
    commissionSpy.mockResolvedValueOnce({ nodeId: "1" });
    render(<AddMatterDevicePage />);
    fireEvent.change(await screen.findByLabelText(/enter the pairing code/i), {
      target: { value: "11111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    await screen.findByText(/device added/i);
    fireEvent.click(screen.getByRole("button", { name: /go to devices/i }));
    expect(pushSpy).toHaveBeenCalledWith("/devices");
  });

  // WARP-1035: "Sharing Wi-Fi credentials with the device…" was shown
  // unconditionally — a literal lie on a box whose AP PSK isn't plumbed
  // to the matter-controller. The 15-25s phase copy is now gated on the
  // wifiProvisioning capability.
  describe("spinner copy gated on wifiProvisioning (WARP-1035)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Renders, waits for the (real-timer) lazy scanner + capability
     * probe, then switches to fake timers and starts a never-resolving
     * commission so the 15-25s phase can be reached deterministically. */
    async function startPendingCommission() {
      commissionSpy.mockReturnValueOnce(new Promise(() => {}));
      render(<AddMatterDevicePage />);
      const input = await screen.findByLabelText(/enter the pairing code/i);
      fireEvent.change(input, { target: { value: "34970112332" } });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    }

    it("says 'Sharing Wi-Fi credentials…' at 15-25s when the box CAN hand the device Wi-Fi", async () => {
      await startPendingCommission();
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(
        screen.getByText(/sharing wi-fi credentials with the device/i),
      ).toBeInTheDocument();
    });

    // UX review (WARP-1035): PSK plumbed but BLE transport down — the
    // credential handoff can't occur (it rides the BLE pairing), so the
    // spinner must not claim it. Made common on single-box installs by
    // this very PR's PSK plumbing whenever the BLE adapter is down.
    it("says 'Waiting for the device to respond…' when BLE is down even if provisioning is plumbed", async () => {
      capabilitiesSpy.mockResolvedValue({
        bleCommissioning: false,
        wifiProvisioning: true,
        apSsid: "Droplet",
      });
      await startPendingCommission();
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(
        screen.getByText(/waiting for the device to respond/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/sharing wi-fi credentials/i),
      ).not.toBeInTheDocument();
    });

    it("says 'Waiting for the device to respond…' instead when it can NOT", async () => {
      capabilitiesSpy.mockResolvedValue({
        bleCommissioning: true,
        wifiProvisioning: false,
        apSsid: "Droplet",
      });
      await startPendingCommission();
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(
        screen.getByText(/waiting for the device to respond/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/sharing wi-fi credentials/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("commissioningPhaseCopy (pure helper)", () => {
    it("walks the elapsed-time phases with Wi-Fi provisioning available", () => {
      expect(commissioningPhaseCopy(0, true)).toMatch(/finding the device/i);
      expect(commissioningPhaseCopy(5, true)).toMatch(/secure pairing/i);
      expect(commissioningPhaseCopy(15, true)).toMatch(/sharing wi-fi credentials/i);
      expect(commissioningPhaseCopy(24, true)).toMatch(/sharing wi-fi credentials/i);
      expect(commissioningPhaseCopy(25, true)).toMatch(/almost done/i);
    });

    it("never claims to share Wi-Fi credentials when provisioning is unavailable", () => {
      expect(commissioningPhaseCopy(15, false)).toMatch(/waiting for the device to respond/i);
      expect(commissioningPhaseCopy(24, false)).toMatch(/waiting for the device to respond/i);
      for (const s of [0, 5, 15, 24, 25, 60]) {
        expect(commissioningPhaseCopy(s, false)).not.toMatch(/sharing wi-fi/i);
      }
    });
  });

  it("Add another goes back to the scan phase", async () => {
    commissionSpy.mockResolvedValueOnce({ nodeId: "1" });
    render(<AddMatterDevicePage />);
    fireEvent.change(await screen.findByLabelText(/enter the pairing code/i), {
      target: { value: "11111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    await screen.findByText(/device added/i);
    fireEvent.click(screen.getByRole("button", { name: /add another/i }));
    // Back to scan: manual-entry input visible again
    expect(
      await screen.findByLabelText(/enter the pairing code/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/device added/i)).not.toBeInTheDocument();
  });
});
