/**
 * WARP-174 — Internet step (DuckDNS).
 *
 * The wizard step that gives the Droplet a permanent address. Validates:
 *   1. Renders the "already set up" banner when DuckDNS is configured.
 *   2. Validates the subdomain client-side before hitting setDuckDnsConfig
 *      (lowercase letters / digits / hyphens; no leading/trailing hyphen).
 *   3. "Skip for now" advances without calling setDuckDnsConfig.
 *
 * Follows the existing setup-test pattern: vi.mock everything at module-
 * resolution level, render the page-level SetupPage, advance through
 * welcome + account, then exercise the Internet surface. Assertions on
 * DOM-visible strings only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchDuckDnsStatusMock = vi.fn();
const setDuckDnsConfigMock = vi.fn();

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "PyPortal lid display", online: true },
    supply_chain: {
      taa_compliant: true,
      ndaa_889_clear: true,
      summary: "Supply chain verified",
    },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: () => fetchDuckDnsStatusMock(),
  setDuckDnsConfig: (opts: unknown) => setDuckDnsConfigMock(opts),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [],
    switches: [],
    climate: [],
    sensors: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  })),
}));

import SetupPage from "@/app/setup/page";
import { passClaimStep } from "./helpers/claim-step";
import { passOrgStep } from "./helpers/org-step";

async function advanceToInternet() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  fireEvent.change(screen.getByPlaceholderText(/your-username/i), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/min\. 8 characters/i), {
    target: { value: "longenoughpw" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "longenoughpw" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → internet).
  await passOrgStep();
  // Let the Internet step's fetchDuckDnsStatus effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup Internet step (WARP-174)", () => {
  beforeEach(() => {
    fetchDuckDnsStatusMock.mockReset();
    setDuckDnsConfigMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the form with the duckdns.org suffix when unconfigured", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();

    expect(screen.getByPlaceholderText(/yourstudio/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/paste your duckdns token/i),
    ).toBeInTheDocument();
    // ".duckdns.org" appears both as the form's input suffix and inside the
    // LearnMoreCard body — getAllByText handles both. The contract is "the
    // domain is visible somewhere on the page".
    expect(screen.getAllByText(/\.duckdns\.org/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /save and continue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("surfaces an 'already set up' banner when DuckDNS is configured", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({
      configured: true,
      subdomain: "yourstudio",
      fullDomain: "yourstudio.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    render(<SetupPage />);
    await advanceToInternet();

    expect(screen.getByText(/already set up/i)).toBeInTheDocument();
    // The domain string appears in both the banner and the LearnMoreCard's
    // example — getAllByText handles both. The banner-specific assertion is
    // the "already set up" phrase above.
    expect(
      screen.getAllByText(/yourstudio\.duckdns\.org/).length,
    ).toBeGreaterThan(0);
    // The subdomain input is pre-filled.
    const subInput = screen.getByPlaceholderText(
      /yourstudio/i,
    ) as HTMLInputElement;
    expect(subInput.value).toBe("yourstudio");
    // Primary CTA reads "Continue" because no new token was typed.
    expect(
      screen.getByRole("button", { name: /^continue$/i }),
    ).toBeInTheDocument();
  });

  it("rejects an invalid subdomain client-side without hitting the API", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();

    fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
      target: { value: "-bad-" },
    });
    fireEvent.change(screen.getByPlaceholderText(/paste your duckdns token/i), {
      target: { value: "validtoken1234" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText(/can't start or end with a hyphen/i),
    ).toBeInTheDocument();
    expect(setDuckDnsConfigMock).not.toHaveBeenCalled();
  });

  it("Skip for now advances without calling setDuckDnsConfig", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(setDuckDnsConfigMock).not.toHaveBeenCalled();
    // Landed on discovery — its title is visible.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("saves and advances on valid submission", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    setDuckDnsConfigMock.mockResolvedValue({
      configured: true,
      subdomain: "yourstudio",
      fullDomain: "yourstudio.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    render(<SetupPage />);
    await advanceToInternet();

    fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
      target: { value: "yourstudio" },
    });
    fireEvent.change(screen.getByPlaceholderText(/paste your duckdns token/i), {
      target: { value: "validtoken1234" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDuckDnsConfigMock).toHaveBeenCalledWith({
      subdomain: "yourstudio",
      token: "validtoken1234",
      enabled: true,
    });
    // Advanced to discovery.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });
});
