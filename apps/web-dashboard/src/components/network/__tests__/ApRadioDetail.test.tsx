/**
 * ApRadioDetail — the AP as inspectable infrastructure (WARP-1712).
 *
 * Pins that an operator sees what they need (model/firmware/uptime, per-radio
 * band, channel, width and connected devices) and that unknowns read as
 * "not reported" rather than a fabricated default — the RadioDetailCard
 * honesty contract. A failed detail read must degrade to nothing, never blank
 * the extender card it lives inside.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchApWirelessDetail: vi.fn(),
}));

import { fetchApWirelessDetail } from "@/lib/api";
import { ApRadioDetail } from "../ApRadioDetail";

const mockFetch = fetchApWirelessDetail as ReturnType<typeof vi.fn>;
const MAC = "AA:BB:CC:DD:EE:01";

function radio(over: Record<string, unknown> = {}) {
  return {
    section: "default_radio0",
    radio: "radio0",
    band: "2g",
    ssid: "Droplet",
    encryption: "psk2+ccmp",
    channel: "auto",
    htmode: "HE20",
    disabled: false,
    primary: true,
    ifname: "phy0-ap0",
    up: true,
    live_channel: 6,
    live_htmode: "HE20",
    clients: 3,
    ...over,
  };
}

function renderDetail() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApRadioDetail mac={MAC} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({
    mac: MAC,
    supported: true,
    radios: [radio()],
    device: {
      model: "Zyxel NWA50BE",
      firmware: "OpenWrt 25.12",
      hostname: "droplet-ap",
      uptime_seconds: 93_784,
    },
  });
});

describe("operator-facing detail", () => {
  it("shows firmware and a whole-unit uptime", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText(/OpenWrt 25\.12/)).toBeTruthy());
    // 93784s ≈ 1.08 days — an operator wants "1 day", not "1d 2h 3m 4s".
    expect(screen.getByText(/up 1 day/)).toBeTruthy();
  });

  it("labels the band and reports the LIVE channel, width and client count", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText("2.4 GHz")).toBeTruthy());
    expect(screen.getByText(/Channel 6 · HE20 · 3 devices/)).toBeTruthy();
  });

  it("prefers the live channel over a configured 'auto'", async () => {
    mockFetch.mockResolvedValue({
      mac: MAC,
      supported: true,
      radios: [radio({ channel: "auto", live_channel: 44, band: "5g" })],
      device: {},
    });
    renderDetail();
    // 'auto' carries no information — never render it as if it were a channel.
    await waitFor(() => expect(screen.getByText(/Channel 44/)).toBeTruthy());
    expect(screen.queryByText(/auto/i)).toBeNull();
  });

  it("says 'Not reported' rather than inventing values", async () => {
    mockFetch.mockResolvedValue({
      mac: MAC,
      supported: true,
      radios: [
        radio({ channel: "auto", live_channel: null, htmode: null, live_htmode: null, clients: null }),
      ],
      device: {},
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Not reported")).toBeTruthy());
  });

  it("renders a disabled radio as Off", async () => {
    mockFetch.mockResolvedValue({
      mac: MAC,
      supported: true,
      radios: [radio({ disabled: true })],
      device: {},
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Off")).toBeTruthy());
  });

  it("uses the singular for a single connected device", async () => {
    mockFetch.mockResolvedValue({
      mac: MAC,
      supported: true,
      radios: [radio({ clients: 1 })],
      device: {},
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText(/1 device$/)).toBeTruthy());
  });

  it("lists every radio the AP reports", async () => {
    mockFetch.mockResolvedValue({
      mac: MAC,
      supported: true,
      radios: [
        radio(),
        radio({ section: "default_radio1", radio: "radio1", band: "5g", live_channel: 44 }),
      ],
      device: {},
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("2.4 GHz")).toBeTruthy());
    expect(screen.getByText("5 GHz")).toBeTruthy();
  });
});

describe("degradation", () => {
  it("renders nothing when the AP cannot report wireless", async () => {
    mockFetch.mockResolvedValue({ mac: MAC, supported: false, radios: [] });
    const { container } = renderDetail();
    await waitFor(() => expect(container.textContent).not.toMatch(/Reading radios/));
    expect(container.textContent).toBe("");
  });

  it("renders nothing — never an error banner — when the read fails", async () => {
    mockFetch.mockRejectedValue(new Error("AP unreachable"));
    const { container } = renderDetail();
    await waitFor(() => expect(container.textContent).not.toMatch(/Reading radios/));
    // The status, model and controls in the card above stay useful.
    expect(container.textContent).toBe("");
  });
});
