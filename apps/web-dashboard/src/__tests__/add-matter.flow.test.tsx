/**
 * /devices/add-matter — three-state flow test.
 *
 * Scan → commission → done, plus the failure branch back to scan with
 * an error banner. We mock @/lib/api and next/navigation; the scanner
 * component itself has dedicated tests, so here we just verify the
 * page wires onResult → commissionMatterDevice → success/error UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddMatterDevicePage from "@/app/devices/add-matter/page";

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

// Spy on the API call — drives the success vs. failure branches.
const commissionSpy = vi.fn();
vi.mock("@/lib/api", () => ({
  commissionMatterDevice: (code: string) => commissionSpy(code),
  // WARP-851: the page probes capabilities at mount; without this stub
  // the probe's fail-soft catch silently masks a missing mock instead
  // of exercising a real resolution.
  fetchMatterCapabilities: vi.fn().mockResolvedValue({ bleCommissioning: true }),
}));

describe("AddMatterDevicePage — three-state flow", () => {
  beforeEach(() => {
    commissionSpy.mockReset();
    pushSpy.mockReset();
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
