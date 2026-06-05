/**
 * WARP-808 (AC7): the resolved flow decision is "rename mid-onboarding WITH a
 * clear warning" — saving the Home Wi-Fi name/password reconfigures the AP, which
 * disconnects every device currently on it (the box IS the router). The Internet
 * step must warn the customer of that BEFORE they save and tell them how to get
 * back on (rejoin with the new name + password).
 *
 * The warning is contextual: it only shows once the customer is actually setting
 * a Home Wi-Fi name (an SSID is entered) — an empty Wi-Fi section means nothing
 * will change, so there's nothing to warn about.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InternetStep } from "./InternetStep";

const fetchDuckDnsStatus = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDuckDnsStatus: (...a: unknown[]) => fetchDuckDnsStatus(...a),
    setWifiSsid: vi.fn(),
    setWifiPassword: vi.fn(),
    setDuckDnsConfig: vi.fn(),
    confirmNetworkCommand: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchDuckDnsStatus.mockResolvedValue({ configured: false });
});

const saveCta = () =>
  screen.getByRole("button", { name: /save and continue|continue/i });

// The warning's distinctive consequence phrase. Kept narrow so it can't collide
// with the word "Droplet" elsewhere in the step copy.
const DISCONNECT_RE = /disconnects every device/i;
const RECONNECT_RE = /rejoin with the new name/i;

describe("InternetStep — Home Wi-Fi disconnect warning (WARP-808)", () => {
  it("does NOT show the disconnect warning before any Wi-Fi name is entered", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());
    // No SSID typed yet → nothing will change → no warning.
    expect(screen.queryByText(DISCONNECT_RE)).not.toBeInTheDocument();
  });

  it("shows a disconnect + reconnect warning once a Wi-Fi name is entered", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    // #509 collapses Home Wi-Fi behind an "Add a Wi-Fi network" disclosure; the
    // SSID field is only mounted once it's expanded (mirrors InternetStep.test).
    fireEvent.click(screen.getByRole("button", { name: /add a wi-fi network/i }));
    fireEvent.change(screen.getByPlaceholderText(/studio fotonia/i), {
      target: { value: "My Home Wi-Fi" },
    });

    // The warning must say (a) saving disconnects current devices and
    // (b) how to get back on — rejoin with the new name + password.
    const warning = await screen.findByText(DISCONNECT_RE);
    expect(warning).toBeInTheDocument();
    const warningRegion = warning.closest("[role='status']");
    expect(warningRegion).toHaveTextContent(RECONNECT_RE);
  });

  it("announces the warning to assistive tech without interrupting (role=status / aria-live polite)", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());
    // #509: expand the collapsed Home Wi-Fi disclosure before the SSID mounts.
    fireEvent.click(screen.getByRole("button", { name: /add a wi-fi network/i }));
    fireEvent.change(screen.getByPlaceholderText(/studio fotonia/i), {
      target: { value: "My Home Wi-Fi" },
    });
    await screen.findByText(DISCONNECT_RE);

    // It's advisory, not an error — a polite live region (mirrors the WARP-807
    // unreachable notice), so a screen reader hears it without an alert.
    const region = screen.getByRole("status", { name: /wi-?fi change notice/i });
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});
