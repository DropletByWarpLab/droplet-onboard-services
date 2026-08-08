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
    expect(notice).toHaveTextContent(/already on your workspace wi-?fi/i);
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

  // WARP-1035: BLE transport up, but the Droplet AP's PSK isn't plumbed
  // to the matter-controller — a BLE-paired device would have no network
  // to join. Say so instead of hiding every notice.
  it("shows the Wi-Fi-provisioning notice when BLE works but the box can't hand devices Wi-Fi", async () => {
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: false,
      apSsid: "Droplet",
    });
    render(<AddMatterDevicePage />);

    const notice = await screen.findByTestId(
      "wifi-provisioning-unavailable-notice",
    );
    expect(notice).toHaveTextContent(/can see bluetooth devices/i);
    expect(notice).toHaveTextContent(/already on your wi-?fi/i);
    expect(
      screen.queryByTestId("ble-unavailable-notice"),
    ).not.toBeInTheDocument();
  });

  // UX review (WARP-1035): the missing quadrant — the AP PSK is plumbed
  // (wifiProvisioning true) but the BLE transport is down. The Bluetooth
  // handoff can't happen, so the pre-flight copy must not promise it;
  // only the WARP-851 BLE notice shows.
  it("does not promise the Bluetooth/Wi-Fi handoff when BLE is down even if provisioning is plumbed", async () => {
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: false,
      wifiProvisioning: true,
      apSsid: "Droplet-AP7",
    });
    render(<AddMatterDevicePage />);

    const notice = await screen.findByTestId("ble-unavailable-notice");
    expect(notice).toHaveTextContent(
      /bluetooth for first-time setup aren't supported yet/i,
    );
    expect(
      screen.queryByTestId("wifi-provisioning-unavailable-notice"),
    ).not.toBeInTheDocument();

    const preflight = screen.getByText(/the droplet does the pairing/i);
    expect(preflight).not.toHaveTextContent(/droplet's own wi-?fi/i);
    expect(preflight).not.toHaveTextContent("Droplet-AP7");
    expect(preflight).toHaveTextContent(
      /already on your wi-?fi are added in place/i,
    );
  });

  it("shows neither notice when BLE and Wi-Fi provisioning are both available", async () => {
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: true,
      apSsid: "Droplet",
    });
    render(<AddMatterDevicePage />);

    await waitFor(() => expect(capabilitiesSpy).toHaveBeenCalled());
    expect(
      screen.queryByTestId("ble-unavailable-notice"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("wifi-provisioning-unavailable-notice"),
    ).not.toBeInTheDocument();
  });

  // WARP-1035: pre-flight copy — the page must say up front which network
  // matters (the Droplet does the pairing; the user's own device only
  // needs to reach the dashboard), naming the real AP SSID.
  it("names the Droplet AP in the pre-flight copy when Wi-Fi provisioning works", async () => {
    // Resolve on a real tick, not an instant microtask — the page paints
    // the generic copy first, so the test must genuinely wait for the
    // post-fetch render (this test flaked on CI when it didn't).
    capabilitiesSpy.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                bleCommissioning: true,
                wifiProvisioning: true,
                apSsid: "Droplet-AP7",
              }),
            0,
          ),
        ),
    );
    render(<AddMatterDevicePage />);

    // Anchor on copy that only exists AFTER the capabilities fetch lands —
    // "the droplet does the pairing" is also in the pre-fetch generic copy,
    // so awaiting it races the fetch (the WARP-851 CI flake).
    const preflight = await screen.findByText(/droplet's own wi-?fi/i);
    expect(preflight).toHaveTextContent(/the droplet does the pairing/i);
    expect(preflight).toHaveTextContent("Droplet-AP7");
    expect(preflight).toHaveTextContent(/already on your wi-?fi are added in place/i);
  });

  it("keeps the pre-flight copy honest (no own-Wi-Fi promise) when provisioning is unavailable", async () => {
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: false,
      apSsid: "Droplet",
    });
    render(<AddMatterDevicePage />);

    // The honest copy is identical before and after the fetch, so wait for
    // the fetch to land — otherwise the negative assertion runs against the
    // pre-fetch render and proves nothing.
    await waitFor(() => expect(capabilitiesSpy).toHaveBeenCalled());
    const preflight = await screen.findByText(
      /the droplet does the pairing/i,
    );
    expect(preflight).not.toHaveTextContent(/droplet's own wi-?fi/i);
    expect(preflight).toHaveTextContent(/already on your wi-?fi are added in place/i);
  });

  // UX review (WARP-1035): the pre-flight paragraph is load-bearing
  // instructional copy, not incidental metadata — it must use the
  // Readable secondary token, not a dim tertiary one (the 0.3-alpha
  // tertiary measures ~2:1 over white and fails WCAG 1.4.3 at 13 px; see
  // the WARP-611 precedent).
  //
  // WARP-1411 re-pointed this at the indigo ramp's `--text-muted`, which
  // the rest of the devices surface uses. Measured against the tokens in
  // shell/indigo-tokens.css: 4.53:1 light (#6b7180 on --bg #f5f6fb) and
  // 5.52:1 dark (#8a8a94 on --bg #0f1117) — both clear AA. The light
  // figure is only 0.03 above the 4.5 threshold, so this guard is load-
  // bearing: darkening the page background or lightening --text-muted
  // drops the pre-flight copy below AA.
  it("renders the pre-flight copy with readable-contrast secondary label token", async () => {
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: true,
      apSsid: "Droplet-AP7",
    });
    render(<AddMatterDevicePage />);

    const preflight = await screen.findByText(
      /the droplet does the pairing/i,
    );
    expect(preflight).toHaveClass("text-[var(--text-muted)]");
    expect(preflight).not.toHaveClass("text-label-tertiary");
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
