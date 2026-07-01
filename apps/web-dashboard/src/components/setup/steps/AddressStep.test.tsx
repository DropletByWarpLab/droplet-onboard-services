/**
 * Onboarding-Flow redesign — the web-address half of the old "Internet" step,
 * now its own informational "Web address" step (ADR-023 / ADR-025). Remote
 * access is automatic: the box already has its own publicly-trusted web address
 * and reaches you through an outbound relay, so there is nothing to configure
 * here — no dynamic-DNS account, no subdomain or token. These tests cover the
 * two behaviours that matter: the step advances cleanly via Continue/Skip, and
 * it shows the box's real address when the box has learned one (else a generic
 * description).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddressStep } from "./AddressStep";

const fetchVpnStatus = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchVpnStatus.mockResolvedValue({ configured: true, endpointConfigured: true });
});

describe("AddressStep — informational web-address step", () => {
  it("advances via Continue without writing anything", async () => {
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("skips via the footer Skip action", async () => {
    const onSkip = vi.fn();
    render(<AddressStep onComplete={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("renders the Home Wi-Fi → Web address → Remote access chain diagram", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(
      screen.getByRole("img", {
        name: /home wi-?fi.*web address.*remote access/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows the box's real web address once it has learned one from HQ", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      publicFqdn: "home.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    expect(
      await screen.findByText("home.droplet-us.com"),
    ).toBeInTheDocument();
  });

  it("falls back to a generic description when no address is available yet", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      publicFqdn: null,
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    // The generic copy is present; no dynamic-DNS form or token field exists.
    await waitFor(() =>
      expect(
        screen.getByText(/its own secure web address/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("explains that remote access turns on with the app's Connect toggle", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    // The help card mentions the automatic Connect flow (no account to sign up).
    expect(
      screen.getByText(/open the Droplet app and turn on/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Connect/).length).toBeGreaterThan(0);
  });
});
