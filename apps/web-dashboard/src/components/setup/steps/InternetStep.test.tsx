/**
 * WARP-807 (K3): when the router/routing service is unreachable, the network
 * WRITE endpoints now return 503 + code UNREACHABLE (via RouterStatusError on
 * the client). The Internet step must render an actionable message
 * ("Your router isn't reachable yet — you can finish this from Network later")
 * rather than the raw error text or a dead "Internal server error", and must
 * keep the Skip affordance available.
 *
 * UX review (droplet-ui-ux, CHANGES_REQUESTED): the destination must be the
 * surface that actually owns this setting — Wi-Fi/DuckDNS live at /network
 * ("Network"), NOT Settings — and the soft notice must be announced to screen
 * readers (role="status" aria-live="polite").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InternetStep } from "./InternetStep";
import { RouterStatusError } from "@/lib/api";

const fetchDuckDnsStatus = vi.fn();
const setWifiSsid = vi.fn();
const setWifiPassword = vi.fn();
const setDuckDnsConfig = vi.fn();
const confirmNetworkCommand = vi.fn();
const fetchNetworkOperation = vi.fn();

vi.mock("@/lib/api", async () => {
  // Spread the real module so RouterStatusError + routerUnreachableNotice (the
  // reachability classifier the component calls) keep their real behavior, and
  // only the network-IO functions are replaced with mocks.
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDuckDnsStatus: (...a: unknown[]) => fetchDuckDnsStatus(...a),
    setWifiSsid: (...a: unknown[]) => setWifiSsid(...a),
    setWifiPassword: (...a: unknown[]) => setWifiPassword(...a),
    setDuckDnsConfig: (...a: unknown[]) => setDuckDnsConfig(...a),
    confirmNetworkCommand: (...a: unknown[]) => confirmNetworkCommand(...a),
    fetchNetworkOperation: (...a: unknown[]) => fetchNetworkOperation(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Unconfigured DuckDNS so the form renders fresh.
  fetchDuckDnsStatus.mockResolvedValue({ configured: false });
});

function fillDuckDns(subdomain: string, token: string) {
  fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
    target: { value: subdomain },
  });
  fireEvent.change(screen.getByPlaceholderText(/paste your duckdns token/i), {
    target: { value: token },
  });
}

const saveCta = () =>
  screen.getByRole("button", { name: /save and continue|continue/i });

/** The collapsed-by-default Home Wi-Fi disclosure trigger (WARP-809). */
const wifiExpander = () =>
  screen.getByRole("button", { name: /add a wi-fi network/i });

/** The SSID input — only mounted once the Wi-Fi section is expanded. */
const ssidInput = () => screen.queryByPlaceholderText(/studio fotonia/i);

describe("InternetStep — router unreachable (WARP-807)", () => {
  it("renders an actionable message (not the raw error) when a write returns UNREACHABLE", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    const onComplete = vi.fn();
    render(<InternetStep onComplete={onComplete} onSkip={vi.fn()} />);

    // Wait for the initial DuckDNS load to settle (button leaves disabled).
    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());

    const notice = await screen.findByText(/router isn't reachable yet/i);
    expect(notice).toBeInTheDocument();
    // Per-surface copy: the destination is "Network" (where Wi-Fi/DuckDNS live),
    // NOT "Settings". The raw RouterError message must not surface either.
    expect(notice).toHaveTextContent(/finish this from\s+Network later/i);
    expect(notice).not.toHaveTextContent(/Settings/i);
    expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal server error/i)).not.toBeInTheDocument();
    // The step did not advance.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("announces the soft notice to screen readers (role=status, aria-live=polite)", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());
    await screen.findByText(/router isn't reachable yet/i);

    // The amber "do this later" notice is non-urgent → status/polite, so a
    // screen reader hears it without interrupting (mirrors AccountStep + the
    // network/ dir). role="status" implies aria-live="polite".
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/router isn't reachable yet/i);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the Skip affordance available on an UNREACHABLE failure", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    const onSkip = vi.fn();
    render(<InternetStep onComplete={vi.fn()} onSkip={onSkip} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());
    await screen.findByText(/router isn't reachable yet/i);

    const skip = screen.getByRole("button", { name: /skip for now/i });
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the real validation message for an ordinary (non-router) failure", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(new Error("Subdomain already in use"));
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());

    const err = await screen.findByText(/subdomain already in use/i);
    expect(err).toBeInTheDocument();
    // An ordinary failure is urgent → role="alert" (assertive), not status.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /subdomain already in use/i,
    );
    // And it does NOT mislabel an ordinary failure as a reachability problem.
    expect(
      screen.queryByText(/router isn't reachable yet/i),
    ).not.toBeInTheDocument();
  });
});

describe("InternetStep — Home Wi-Fi is optional/skippable (WARP-809)", () => {
  it("renders the Home Wi-Fi section collapsed behind an 'Add a Wi-Fi network' expander, marked Optional", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    // Collapsed by default — the SSID/password fields are NOT mounted, so the
    // customer can't accidentally trigger the box's Wi-Fi write.
    expect(ssidInput()).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/wi-fi password/i),
    ).not.toBeInTheDocument();

    // The disclosure trigger is present and announces its collapsed state.
    const trigger = wifiExpander();
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // It is visibly optional.
    expect(screen.getByText(/^optional$/i)).toBeInTheDocument();
  });

  it("reframes the copy to stop implying box-as-router and drops 'the Droplet is your router now'", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    // The old router-assuming framing is gone from the whole step.
    expect(
      screen.queryByText(/the droplet is your router now/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/this becomes your home network/i),
    ).not.toBeInTheDocument();

    // The approved reframe is present: coexistence + skippable. (It appears in
    // both the section explainer and the LearnMoreCard, hence getAllByText.)
    expect(
      screen.getAllByText(/already on a home network\? skip this/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/your droplet always runs a local network/i).length,
    ).toBeGreaterThan(0);
  });

  it("expands to reveal the SSID + password fields when the customer opts in", async () => {
    render(<InternetStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    fireEvent.click(wifiExpander());

    expect(ssidInput()).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/wi-fi password/i)).toBeInTheDocument();
    expect(wifiExpander()).toHaveAttribute("aria-expanded", "true");
  });

  it("proceeds with NO Wi-Fi write when the section is left collapsed (skipped)", async () => {
    const onComplete = vi.fn();
    render(<InternetStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    // Provide a valid DuckDNS so Save has something to do, but never touch Wi-Fi.
    fillDuckDns("yourstudio", "tok1234567890");
    setDuckDnsConfig.mockResolvedValueOnce({ configured: true });

    fireEvent.click(saveCta());

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setWifiSsid).not.toHaveBeenCalled();
    expect(setWifiPassword).not.toHaveBeenCalled();
  });

  it("proceeds with NO Wi-Fi write when expanded but the SSID is left blank", async () => {
    const onComplete = vi.fn();
    render(<InternetStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    // Open the section but type nothing — still a skip.
    fireEvent.click(wifiExpander());
    fillDuckDns("yourstudio", "tok1234567890");
    setDuckDnsConfig.mockResolvedValueOnce({ configured: true });

    fireEvent.click(saveCta());

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setWifiSsid).not.toHaveBeenCalled();
  });

  it("shows an actionable 'skip and set it later' message (not a raw 500) when a Wi-Fi write fails with ROLLED_BACK", async () => {
    // WARP-808's hostapd write-fix is parked, so on single-box an SSID write
    // 500s with code ROLLED_BACK — which is NOT in ROUTER_UNREACHABLE_CODES, so
    // K3's routerUnreachableNotice does NOT catch it. The step must still render
    // a calm, actionable message rather than "Set SSID: 500 Internal Server
    // Error".
    setWifiSsid.mockRejectedValueOnce(
      new RouterStatusError(
        "ROLLED_BACK",
        "Set SSID: 500 Internal Server Error",
        500,
      ),
    );
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<InternetStep onComplete={onComplete} onSkip={onSkip} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    fireEvent.click(wifiExpander());
    fireEvent.change(ssidInput()!, { target: { value: "Studio Fotonia" } });
    fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
      target: { value: "supersecret" },
    });
    fireEvent.click(saveCta());

    // The notice text is split across an inline <span> (the monospaced
    // destination) and uses a typographic apostrophe (’), so assert on the
    // status region's normalized textContent rather than a single text node.
    const region = await screen.findByRole("status");
    const text = (region.textContent ?? "").replace(/’/g, "'");
    expect(text).toMatch(/couldn't set up the droplet's wi-fi right now/i);
    // Points the customer at where they can finish later, and says they can skip.
    expect(text).toMatch(/skip this/i);
    expect(text).toMatch(/Network/);
    // The raw 500 / server-error text must NOT surface.
    expect(screen.queryByText(/internal server error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Set SSID: 500/i)).not.toBeInTheDocument();
    // Calm amber notice (role=status), not an alarm-red alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The step did not advance, and Skip is still available.
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
