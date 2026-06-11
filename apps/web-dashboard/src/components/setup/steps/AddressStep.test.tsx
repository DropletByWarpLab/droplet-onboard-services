/**
 * Onboarding-Flow redesign — the DuckDNS half of the old "Internet" step, now
 * its own "Internet address" step. These tests carry over the WARP-807 calm
 * error ladder (unreachable router → actionable "finish from Network later"
 * notice, role=status/polite; ordinary failure → red alert) and add the split's
 * own behaviour: a blank subdomain skips with no write, and the explanatory
 * chain diagram renders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddressStep } from "./AddressStep";
import { RouterStatusError } from "@/lib/api";

const fetchDuckDnsStatus = vi.fn();
const setDuckDnsConfig = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDuckDnsStatus: (...a: unknown[]) => fetchDuckDnsStatus(...a),
    setDuckDnsConfig: (...a: unknown[]) => setDuckDnsConfig(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchDuckDnsStatus.mockResolvedValue({ configured: false });
});

const saveCta = () =>
  screen.getByRole("button", { name: /save and continue|continue/i });

function fillDuckDns(subdomain: string, token: string) {
  fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
    target: { value: subdomain },
  });
  fireEvent.change(screen.getByPlaceholderText(/paste your duckdns token/i), {
    target: { value: token },
  });
}

describe("AddressStep — router unreachable (WARP-807)", () => {
  it("renders an actionable message (not the raw error) when the write returns UNREACHABLE", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());

    const notice = await screen.findByText(/router isn't reachable yet/i);
    expect(notice).toHaveTextContent(/finish this from\s+Network later/i);
    expect(notice).not.toHaveTextContent(/Settings/i);
    expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("announces the soft notice to screen readers (role=status, aria-live=polite)", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());
    await screen.findByText(/router isn't reachable yet/i);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the Skip affordance available on an UNREACHABLE failure", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "DuckDNS update: fetch failed", 503),
    );
    const onSkip = vi.fn();
    render(<AddressStep onComplete={vi.fn()} onSkip={onSkip} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());
    await screen.findByText(/router isn't reachable yet/i);

    fireEvent.click(screen.getByRole("button", { name: /skip — no remote access/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the real validation message for an ordinary (non-router) failure", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(new Error("Subdomain already in use"));
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(saveCta()).toBeEnabled());
    fillDuckDns("yourstudio", "tok1234567890");
    fireEvent.click(saveCta());

    expect(await screen.findByText(/subdomain already in use/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/subdomain already in use/i);
    expect(screen.queryByText(/router isn't reachable yet/i)).not.toBeInTheDocument();
  });
});

describe("AddressStep — split behaviour", () => {
  it("proceeds with NO DuckDNS write when the subdomain is left blank (skip remote access)", async () => {
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());

    fireEvent.click(saveCta());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setDuckDnsConfig).not.toHaveBeenCalled();
  });

  it("renders the Home Wi-Fi → Internet address → Remote access chain diagram", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(saveCta()).toBeEnabled());
    expect(
      screen.getByRole("img", {
        name: /home wi-?fi.*internet address.*remote access/i,
      }),
    ).toBeInTheDocument();
  });
});

/**
 * WARP-869 — the write-failure ladder rung WifiStep already had. The live
 * field case (2026-06-11 wizard run): the DuckDNS set ROLLED_BACK while rpcd
 * denied the routing service (WARP-868), and this step rendered the raw
 * "DuckDNS set: 500 Internal Server Error" in red on a first-run screen.
 * A routing-layer write failure that isn't customer-fixable must read as the
 * calm amber "skip and finish later" notice, never raw server text.
 */
describe("AddressStep — write failure surfaces the calm notice (WARP-869)", () => {
  it("maps a ROLLED_BACK 500 onto the amber finish-later notice, not the raw message", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError(
        "ROLLED_BACK",
        "DuckDNS set: 500 Internal Server Error",
        500,
      ),
    );
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchDuckDnsStatus).toHaveBeenCalled());

    fillDuckDns("mystudio", "a-valid-duckdns-token");
    fireEvent.click(saveCta());

    // Calm amber notice (role=status), naming where to finish later.
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/couldn't save the web address/i);
    expect(notice).toHaveTextContent(/network/i);
    expect(notice).toHaveTextContent(/later/i);
    // The raw server text never reaches the customer.
    expect(
      screen.queryByText(/500 internal server error/i),
    ).not.toBeInTheDocument();
    // And the step did not advance — the customer chooses skip or retry.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps a 400 validation refusal red and verbatim (customer-fixable)", async () => {
    setDuckDnsConfig.mockRejectedValueOnce(
      new RouterStatusError(
        "ROLLED_BACK",
        "Subdomain must be lowercase letters, digits, or hyphens (no leading/trailing hyphen, no dots).",
        400,
      ),
    );
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchDuckDnsStatus).toHaveBeenCalled());

    fillDuckDns("mystudio", "a-valid-duckdns-token");
    fireEvent.click(saveCta());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/lowercase letters, digits, or hyphens/i);
  });
});
