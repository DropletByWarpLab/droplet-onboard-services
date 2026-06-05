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
