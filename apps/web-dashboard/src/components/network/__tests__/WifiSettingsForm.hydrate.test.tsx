/**
 * WARP-1714 — the Wi-Fi settings card must open showing the network it's about
 * to edit.
 *
 * Both fields used to start as `useState("")` and never hydrate, so the card
 * couldn't tell you your own SSID and the password you'd set visibly "went
 * away" on every reload.
 *
 * The source is resolved server-side (`/api/network/wifi/current`) because it
 * differs by deployment shape — on the edge-router shape the Droplet's own
 * radio hosts nothing and the SSID lives only on the approved AP. The case that
 * matters most here: when the box CAN'T read the Wi-Fi, the card must say why
 * rather than render the same two empty boxes it would show for "no Wi-Fi set".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import type { ReactNode } from "react";
import { WifiSettingsForm } from "../WifiSettingsForm";
import { fetchCurrentWifi } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchCurrentWifi: vi.fn(),
  setWifiSsid: vi.fn().mockResolvedValue({ status: "ok" }),
  setWifiPassword: vi.fn().mockResolvedValue({ status: "ok" }),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  RouterStatusError: class RouterStatusError extends Error {
    status = 0;
  },
  routerUnreachableNotice: vi.fn().mockReturnValue(false),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
    {children}
  </SWRConfig>
);

// Anchored: an unanchored /wi-fi password/ also matches the reveal button's
// aria-label ("Show Wi-Fi password").
const ssidField = () => screen.getByLabelText(/^network name/i) as HTMLInputElement;
const passwordField = () => screen.getByLabelText(/^wi-fi password$/i) as HTMLInputElement;

const ROUTER_WIFI = {
  ssid: "Droplet",
  key: "droplethome2026",
  source: "router" as const,
  detail: "Broadcast by this Droplet.",
  section: "default_radio0",
  radio: "radio0",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WifiSettingsForm hydration (WARP-1714)", () => {
  it("prefills the live SSID and password", async () => {
    vi.mocked(fetchCurrentWifi).mockResolvedValue(ROUTER_WIFI);
    render(<WifiSettingsForm />, { wrapper });

    await waitFor(() => expect(ssidField().value).toBe("Droplet"));
    expect(passwordField().value).toBe("droplethome2026");
  });

  it("prefills from the access point when this Droplet hosts no radio", async () => {
    // The edge-router shape: the router reports `interfaces: []`, so the only
    // place the household SSID exists is the AP.
    vi.mocked(fetchCurrentWifi).mockResolvedValue({
      ssid: "Studio Fotonia",
      key: "apside12345",
      source: "ap",
      detail: "Broadcast by Living-room AP.",
      section: "wifinet1",
      radio: null,
    });
    render(<WifiSettingsForm />, { wrapper });

    await waitFor(() => expect(ssidField().value).toBe("Studio Fotonia"));
    expect(passwordField().value).toBe("apside12345");
  });

  it("masks the password until the reveal toggle is pressed", async () => {
    vi.mocked(fetchCurrentWifi).mockResolvedValue(ROUTER_WIFI);
    render(<WifiSettingsForm />, { wrapper });

    await waitFor(() => expect(passwordField().value).toBe("droplethome2026"));
    expect(passwordField().type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show wi-fi password/i }));
    expect(passwordField().type).toBe("text");
  });

  it("explains WHY the fields are blank instead of just showing empty boxes", async () => {
    // The lab box's actual state: docker/secrets/ap_openwrt_password is empty,
    // so nothing can read the AP. Blank-and-silent would read as "no Wi-Fi set".
    vi.mocked(fetchCurrentWifi).mockResolvedValue({
      ssid: null,
      key: null,
      source: null,
      detail:
        "Can't read the current Wi-Fi: this Droplet has no access-point credential configured.",
      section: null,
      radio: null,
    });
    render(<WifiSettingsForm />, { wrapper });

    await waitFor(() =>
      expect(screen.getByText(/no access-point credential configured/i)).toBeInTheDocument(),
    );
    expect(ssidField().value).toBe("");
  });

  it("stays quiet while the read is still in flight", async () => {
    vi.mocked(fetchCurrentWifi).mockReturnValue(new Promise(() => {}));
    render(<WifiSettingsForm />, { wrapper });
    // No answer yet is not the same as "couldn't read it" — don't alarm.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(ssidField().value).toBe("");
  });

  it("does not clobber an in-progress edit when the poll re-delivers", async () => {
    vi.mocked(fetchCurrentWifi).mockResolvedValue(ROUTER_WIFI);
    const { rerender } = render(<WifiSettingsForm />, { wrapper });
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));

    fireEvent.change(ssidField(), { target: { value: "Studio Fotonia" } });
    rerender(<WifiSettingsForm />);

    expect(ssidField().value).toBe("Studio Fotonia");
  });

  it("adopts a change made elsewhere before the user touched anything", async () => {
    vi.mocked(fetchCurrentWifi).mockResolvedValueOnce(ROUTER_WIFI).mockResolvedValue({
      ...ROUTER_WIFI,
      ssid: "Droplet-New",
      key: "rotated12345",
    });

    // The global `mutate` binds to SWR's default cache, not this wrapper's
    // provider — so reach the right mutate from inside the tree.
    let revalidate!: () => Promise<unknown>;
    function MutateProbe() {
      const { mutate } = useSWRConfig();
      revalidate = () => mutate("/api/network/wifi/current");
      return null;
    }

    render(
      <>
        <MutateProbe />
        <WifiSettingsForm />
      </>,
      { wrapper },
    );
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));

    // Drive the revalidation the 30s poll would.
    await act(async () => {
      await revalidate();
    });

    await waitFor(() => expect(ssidField().value).toBe("Droplet-New"));
    expect(passwordField().value).toBe("rotated12345");
  });

  it("re-reads from the box after a successful save", async () => {
    vi.mocked(fetchCurrentWifi).mockResolvedValue(ROUTER_WIFI);
    render(<WifiSettingsForm />, { wrapper });
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));
    const callsBefore = vi.mocked(fetchCurrentWifi).mock.calls.length;

    fireEvent.change(ssidField(), { target: { value: "Studio Fotonia" } });
    fireEvent.click(screen.getByRole("button", { name: /save wi-fi settings/i }));
    await screen.findByText(/wi-fi updated/i);

    // Trust the box, not the echo of what we just sent.
    await waitFor(() =>
      expect(vi.mocked(fetchCurrentWifi).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
