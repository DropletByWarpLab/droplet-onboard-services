/**
 * WARP-851 — /devices/add-matter honesty.
 *
 * 1. When the box has no BLE commissioning path, the page shows the same
 *    plain notice as the wizard: devices already on the home network can
 *    be added; Bluetooth first-time setup isn't supported yet.
 * 2. When commissioning fails with the orchestrator's 502 discovery
 *    failure, the error banner surfaces the network-discovery copy —
 *    never factory-reset advice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddMatterDevicePage from "@/app/devices/add-matter/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: class {
    reset = vi.fn();
    decodeFromVideoElement = vi.fn();
  },
}));
vi.mock("@zxing/library", () => ({
  NotFoundException: class extends Error {},
}));

const commissionSpy = vi.fn();
const capabilitiesSpy = vi.fn();
vi.mock("@/lib/api", () => ({
  commissionMatterDevice: (code: string) => commissionSpy(code),
  fetchMatterCapabilities: () => capabilitiesSpy(),
}));

describe("AddMatterDevicePage — BLE-unavailable notice (WARP-851)", () => {
  beforeEach(() => {
    commissionSpy.mockReset();
    capabilitiesSpy.mockReset();
  });

  it("shows the notice when BLE commissioning is unavailable", async () => {
    capabilitiesSpy.mockResolvedValue({ bleCommissioning: false });
    render(<AddMatterDevicePage />);

    const notice = await screen.findByTestId("ble-unavailable-notice");
    expect(notice).toHaveTextContent(/already on your home wi-?fi/i);
    expect(notice).toHaveTextContent(
      /bluetooth for first-time setup aren't supported yet/i,
    );
  });

  it("shows no notice when BLE commissioning is available", async () => {
    capabilitiesSpy.mockResolvedValue({ bleCommissioning: true });
    render(<AddMatterDevicePage />);

    await waitFor(() => expect(capabilitiesSpy).toHaveBeenCalled());
    expect(
      screen.queryByTestId("ble-unavailable-notice"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the network-discovery copy (not factory-reset advice) on a 502 discovery failure", async () => {
    capabilitiesSpy.mockResolvedValue({ bleCommissioning: false });
    // What commissionMatterDevice throws after the orchestrator's
    // WARP-851 mapping: server copy as message + HTTP status attached.
    commissionSpy.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.",
        ),
        { status: 502 },
      ),
    );
    render(<AddMatterDevicePage />);

    fireEvent.change(await screen.findByLabelText(/enter the pairing code/i), {
      target: { value: "1602-004-8090" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/couldn't find the device on the network/i);
    expect(alert).not.toHaveTextContent(/factory[- ]reset/i);
  });
});
