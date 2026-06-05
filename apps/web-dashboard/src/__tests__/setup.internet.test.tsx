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
// WARP-657 — Home Wi-Fi section wired to the existing network endpoints.
const setWifiSsidMock = vi.fn();
const setWifiPasswordMock = vi.fn();
const confirmNetworkCommandMock = vi.fn();
const fetchNetworkOperationMock = vi.fn();

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
  // WARP-657 — Home Wi-Fi clients (POST /api/network/wifi/{ssid,password},
  // /command/confirm, /operations/:id). The password POST is Tier-2 and may
  // resolve to a 202 `confirmation_required` body that the step auto-confirms.
  setWifiSsid: (ssid: string) => setWifiSsidMock(ssid),
  setWifiPassword: (password: string) => setWifiPasswordMock(password),
  confirmNetworkCommand: (token: string, operation: string, entityId?: string) =>
    confirmNetworkCommandMock(token, operation, entityId),
  fetchNetworkOperation: (id: string) => fetchNetworkOperationMock(id),
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
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → …).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip to reach Internet (org → twofactor → internet).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Let the Internet step's fetchDuckDnsStatus effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * WARP-809 — the Home Wi-Fi section is now optional and collapsed by default
 * behind an "Add a Wi-Fi network" disclosure. Tests that exercise the Wi-Fi
 * SSID/password fields must open it first (the DuckDNS-only cases don't).
 */
async function openWifi() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /add a wi-fi network/i }),
    );
  });
}

describe("setup Internet step (WARP-174)", () => {
  beforeEach(() => {
    fetchDuckDnsStatusMock.mockReset();
    setDuckDnsConfigMock.mockReset();
    setWifiSsidMock.mockReset();
    setWifiPasswordMock.mockReset();
    confirmNetworkCommandMock.mockReset();
    fetchNetworkOperationMock.mockReset();
    // Sensible Tier-1 defaults so the DuckDNS-only cases don't have to wire
    // the Wi-Fi mocks. Cases that exercise the Wi-Fi path override these.
    setWifiSsidMock.mockResolvedValue({ status: "ok", tier: 1 });
    setWifiPasswordMock.mockResolvedValue({ status: "ok", tier: 1 });
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
    // WARP-657 — the Wi-Fi section is optional; leaving SSID blank must not
    // touch the network endpoints. Existing DuckDNS-only behavior unchanged.
    expect(setWifiSsidMock).not.toHaveBeenCalled();
    expect(setWifiPasswordMock).not.toHaveBeenCalled();
    // Advanced to discovery.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });
});

/**
 * WARP-657 — the network step can ALSO configure a Home Wi-Fi the Droplet
 * broadcasts. Section A = Home Wi-Fi (SSID + PSK), wired to POST
 * /api/network/wifi/{ssid,password}; Section B = the existing DuckDNS inputs.
 * Validation mirrors services/routing/schemas.py (SSID 1–32, PSK 8–63); the
 * password POST is Tier-2 and may return a 202 `confirmation_required` body the
 * step auto-confirms (the "Save and continue" click IS the consent).
 *
 * WARP-809 — the box does NOT have to be the home router; many deployments
 * coexist on an existing network. So Section A is OPTIONAL and collapsed by
 * default behind an "Add a Wi-Fi network" disclosure: these tests call
 * `openWifi()` to opt in before exercising the SSID/password path.
 */
describe("setup network step — Home Wi-Fi (WARP-657)", () => {
  beforeEach(() => {
    fetchDuckDnsStatusMock.mockReset();
    setDuckDnsConfigMock.mockReset();
    setWifiSsidMock.mockReset();
    setWifiPasswordMock.mockReset();
    confirmNetworkCommandMock.mockReset();
    fetchNetworkOperationMock.mockReset();
    setWifiSsidMock.mockResolvedValue({ status: "ok", tier: 1 });
    setWifiPasswordMock.mockResolvedValue({ status: "ok", tier: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the two-section step with the Home Wi-Fi section optional/collapsed (WARP-809) and DuckDNS visible", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();

    // New title + subtitle.
    expect(screen.getByText(/set up your network/i)).toBeInTheDocument();
    // Section A label present, but the section is OPTIONAL and COLLAPSED by
    // default (WARP-809): the Wi-Fi inputs are not mounted until the customer
    // opts in via the disclosure.
    // "Home Wi-Fi" appears in both the section label and the LearnMoreCard copy.
    expect(screen.getAllByText(/home wi-fi/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/^optional$/i)).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/studio fotonia/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/wi-fi password/i),
    ).not.toBeInTheDocument();
    // Section B label still present (DuckDNS) and its inputs visible up front —
    // the address is the primary, useful action of this step.
    expect(screen.getByText(/internet address/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/yourstudio/i)).toBeInTheDocument();

    // Opening the disclosure reveals both Wi-Fi inputs.
    await openWifi();
    expect(
      screen.getByPlaceholderText(/network name|studio fotonia/i),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/wi-fi password/i)).toBeInTheDocument();
  });

  it("rejects an SSID over 32 chars client-side without hitting the Wi-Fi API", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();
    await openWifi();

    fireEvent.change(
      screen.getByPlaceholderText(/network name|studio fotonia/i),
      { target: { value: "x".repeat(33) } },
    );
    fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
      target: { value: "abcdefgh" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText(/must be 32 characters or fewer/i),
    ).toBeInTheDocument();
    expect(setWifiSsidMock).not.toHaveBeenCalled();
    expect(setWifiPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects a Wi-Fi password under 8 chars client-side without hitting the API", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();
    await openWifi();

    fireEvent.change(
      screen.getByPlaceholderText(/network name|studio fotonia/i),
      { target: { value: "Studio Fotonia" } },
    );
    fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
      target: { value: "short" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText(/wi-fi password must be at least 8 characters/i),
    ).toBeInTheDocument();
    expect(setWifiSsidMock).not.toHaveBeenCalled();
    expect(setWifiPasswordMock).not.toHaveBeenCalled();
  });

  it("submits Wi-Fi (ssid then password) and then DuckDNS on a valid combined save", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    setDuckDnsConfigMock.mockResolvedValue({
      configured: true,
      subdomain: "studiofotonia",
      fullDomain: "studiofotonia.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    render(<SetupPage />);
    await advanceToInternet();
    await openWifi();

    fireEvent.change(
      screen.getByPlaceholderText(/network name|studio fotonia/i),
      { target: { value: "Studio Fotonia" } },
    );
    fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
      target: { value: "supersecret" },
    });
    fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
      target: { value: "studiofotonia" },
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
      await Promise.resolve();
    });

    expect(setWifiSsidMock).toHaveBeenCalledWith("Studio Fotonia");
    expect(setWifiPasswordMock).toHaveBeenCalledWith("supersecret");
    // SSID is submitted before the password.
    expect(setWifiSsidMock.mock.invocationCallOrder[0]).toBeLessThan(
      setWifiPasswordMock.mock.invocationCallOrder[0],
    );
    expect(setDuckDnsConfigMock).toHaveBeenCalledWith({
      subdomain: "studiofotonia",
      token: "validtoken1234",
      enabled: true,
    });
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("auto-confirms + polls when the password POST returns 202 confirmation_required", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    setDuckDnsConfigMock.mockResolvedValue({
      configured: true,
      subdomain: "studiofotonia",
      fullDomain: "studiofotonia.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    // The Tier-2 202 body the orchestrator returns for set_wifi_password.
    setWifiPasswordMock.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
      reason: "Changing the Wi-Fi password restarts the radio.",
      confirmationToken: "tok-657",
    });
    confirmNetworkCommandMock.mockResolvedValue({ operationId: "op-657" });
    fetchNetworkOperationMock.mockResolvedValue({
      id: "op-657",
      state: "applied",
      startedAt: 0,
      finishedAt: 1,
      reason: null,
    });
    render(<SetupPage />);
    await advanceToInternet();
    await openWifi();

    fireEvent.change(
      screen.getByPlaceholderText(/network name|studio fotonia/i),
      { target: { value: "Studio Fotonia" } },
    );
    fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
      target: { value: "supersecret" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setWifiPasswordMock).toHaveBeenCalledWith("supersecret");
    // The step confirms with (token, operation) — same 2-arg shape as the
    // network page; the optional entityId is left undefined.
    expect(confirmNetworkCommandMock).toHaveBeenCalledWith(
      "tok-657",
      "set_wifi_password",
      undefined,
    );
    expect(fetchNetworkOperationMock).toHaveBeenCalledWith("op-657");
  });

  it("shows the show/hide control for the Wi-Fi password", async () => {
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
    render(<SetupPage />);
    await advanceToInternet();
    await openWifi();

    const pwInput = screen.getByPlaceholderText(
      /wi-fi password/i,
    ) as HTMLInputElement;
    expect(pwInput.type).toBe("password");
    // The reveal toggle is labelled for assistive tech.
    const toggle = screen.getByRole("button", { name: /show.*password/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(pwInput.type).toBe("text");
  });
});
