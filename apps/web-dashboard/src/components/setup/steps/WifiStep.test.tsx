/**
 * Onboarding-Flow redesign — the single "Internet" step is split into a
 * dedicated Home Wi-Fi step and a web-address step. These tests
 * cover the Wi-Fi half: the WARP-808 disconnect warning, the optional/skippable
 * behaviour (WARP-809), and the calm error ladder (WARP-807) — all carried over
 * from the old InternetStep, adapted to the dedicated step.
 *
 * WARP-817 reintroduced the "Add a Wi-Fi network" disclosure #509 originally
 * shipped (removed by the #548 Wi-Fi/address split), now driven by the box's
 * topology instead of a static collapsed default — see
 * WifiStep.topology.test.tsx for the posture-driven default-expand coverage.
 * `getNetworkTopology()` isn't mocked here, so it best-effort-resolves to null
 * (no fetch mock in this file) and the fields stay at the collapsed default;
 * tests that exercise the fields open the disclosure first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WifiStep } from "./WifiStep";
import { RouterStatusError } from "@/lib/api";

const setWifiSsid = vi.fn();
const setWifiPassword = vi.fn();
const confirmNetworkCommand = vi.fn();
const fetchNetworkOperation = vi.fn();

vi.mock("@/lib/api", async () => {
  // Keep RouterStatusError + routerUnreachableNotice real; mock only the IO.
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setWifiSsid: (...a: unknown[]) => setWifiSsid(...a),
    setWifiPassword: (...a: unknown[]) => setWifiPassword(...a),
    confirmNetworkCommand: (...a: unknown[]) => confirmNetworkCommand(...a),
    fetchNetworkOperation: (...a: unknown[]) => fetchNetworkOperation(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const saveCta = () =>
  screen.getByRole("button", { name: /save and continue|continue/i });
const ssidInput = () => screen.getByPlaceholderText(/studio fotonia/i);
const pwInput = () => screen.getByPlaceholderText(/wi-fi password/i);
const openWifiDisclosure = () =>
  fireEvent.click(screen.getByRole("button", { name: /add a wi-?fi network/i }));

const DISCONNECT_RE = /disconnects every device/i;
const RECONNECT_RE = /rejoin with the new name/i;

describe("WifiStep — disconnect warning (WARP-808)", () => {
  it("does NOT show the disconnect warning before any Wi-Fi name is entered", () => {
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.queryByText(DISCONNECT_RE)).not.toBeInTheDocument();
  });

  it("shows a disconnect + reconnect warning once a Wi-Fi name is entered", async () => {
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    openWifiDisclosure();
    fireEvent.change(ssidInput(), { target: { value: "My Home Wi-Fi" } });

    const warning = await screen.findByText(DISCONNECT_RE);
    expect(warning).toBeInTheDocument();
    expect(warning.closest("[role='status']")).toHaveTextContent(RECONNECT_RE);
  });

  it("announces the warning to assistive tech without interrupting (role=status / aria-live polite)", async () => {
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    openWifiDisclosure();
    fireEvent.change(ssidInput(), { target: { value: "My Home Wi-Fi" } });
    await screen.findByText(DISCONNECT_RE);

    const region = screen.getByRole("status", { name: /wi-?fi change notice/i });
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});

describe("WifiStep — optional / skippable (WARP-809)", () => {
  it("shows the SSID + password fields once the disclosure is opened, with an optional framing", () => {
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    // Collapsed by default (WARP-817) until opened.
    expect(screen.queryByPlaceholderText(/studio fotonia/i)).not.toBeInTheDocument();
    openWifiDisclosure();
    expect(ssidInput()).toBeInTheDocument();
    expect(pwInput()).toBeInTheDocument();
    // The reframe that stops implying box-as-router and offers coexistence.
    expect(
      screen.getByText(/already on a home network\? skip this/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your droplet always runs a local network/i),
    ).toBeInTheDocument();
  });

  it("proceeds with NO Wi-Fi write when the SSID is left blank", async () => {
    const onComplete = vi.fn();
    render(<WifiStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.click(saveCta());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setWifiSsid).not.toHaveBeenCalled();
    expect(setWifiPassword).not.toHaveBeenCalled();
  });

  it("routes the footer Skip through onSkip", () => {
    const onSkip = vi.fn();
    render(<WifiStep onComplete={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip — i'll do this later/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe("WifiStep — calm error ladder (WARP-807/808)", () => {
  it("surfaces the router's revert reason when a UCI safe-apply rolls back (red alert)", async () => {
    setWifiSsid.mockResolvedValueOnce({ status: "ok" });
    setWifiPassword.mockResolvedValueOnce({
      status: "confirmation_required",
      confirmationToken: "tok-confirm",
      operation: "set_wifi_password",
    });
    confirmNetworkCommand.mockResolvedValueOnce({ operationId: "op-42" });
    fetchNetworkOperation.mockResolvedValueOnce({
      state: "rolled_back",
      reason: "Channel 149 is not permitted in your region — the router reverted.",
    });

    const onComplete = vi.fn();
    render(<WifiStep onComplete={onComplete} onSkip={vi.fn()} />);
    openWifiDisclosure();
    fireEvent.change(ssidInput(), { target: { value: "Studio Fotonia" } });
    fireEvent.change(pwInput(), { target: { value: "supersecret" } });
    fireEvent.click(saveCta());

    const err = await screen.findByText(/channel 149 is not permitted/i);
    expect(err).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /channel 149 is not permitted/i,
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows an actionable 'skip and set it later' notice (not a raw 500) on ROLLED_BACK", async () => {
    setWifiSsid.mockRejectedValueOnce(
      new RouterStatusError("ROLLED_BACK", "Set SSID: 500 Internal Server Error", 500),
    );
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<WifiStep onComplete={onComplete} onSkip={onSkip} />);
    openWifiDisclosure();
    fireEvent.change(ssidInput(), { target: { value: "Studio Fotonia" } });
    fireEvent.change(pwInput(), { target: { value: "supersecret" } });
    fireEvent.click(saveCta());

    const region = (
      await screen.findByText(/couldn.t set up the droplet.s wi-?fi right now/i)
    ).closest("[role='status']")!;
    const text = (region.textContent ?? "").replace(/’/g, "'");
    expect(text).toMatch(/couldn't set up the droplet's wi-fi right now/i);
    expect(text).toMatch(/skip this/i);
    expect(text).toMatch(/Network/);
    expect(screen.queryByText(/internal server error/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("surfaces the AP's actionable reason (red alert) on a 4xx validation refusal", async () => {
    setWifiSsid.mockResolvedValueOnce({ status: "ok" });
    setWifiPassword.mockRejectedValueOnce(
      new RouterStatusError("UNKNOWN", "Wi-Fi password must be 8-63 characters.", 422),
    );
    const onComplete = vi.fn();
    render(<WifiStep onComplete={onComplete} onSkip={vi.fn()} />);
    openWifiDisclosure();
    fireEvent.change(ssidInput(), { target: { value: "Studio Fotonia" } });
    fireEvent.change(pwInput(), { target: { value: "supersecret" } });
    fireEvent.click(saveCta());

    const err = await screen.findByText(/wi-fi password must be 8-63 characters/i);
    expect(err).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /wi-fi password must be 8-63 characters/i,
    );
    expect(onComplete).not.toHaveBeenCalled();
  });
});
