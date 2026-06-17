/**
 * Onboarding-Flow redesign — the network split's INTEGRATION contract.
 *
 * The old single `internet` step was split into two ordered client-only steps,
 * `wifi` (Home Wi-Fi the box broadcasts) then `address` (the DuckDNS web
 * address). This file used to be `setup.internet.test.tsx` and exercised the
 * single combined step in-flow; the per-component behaviour (validation, the
 * WARP-807/808/809 ladders, field shapes) now lives in
 * `components/setup/steps/WifiStep.test.tsx` + `AddressStep.test.tsx`.
 *
 * What ONLY the page-level wiring can prove — and so what this file keeps — is
 * that the split is threaded into the state machine correctly:
 *   1. after `twofactor` the wizard lands on WifiStep ("Set up your home Wi-Fi");
 *   2. advancing the Wi-Fi step (Continue/skip) lands on AddressStep ("Give your
 *      box a web address", with the `.duckdns.org` suffix visible);
 *   3. advancing/skipping the address step lands on `storage` (→ discovery);
 *   4. both sub-steps persist as the existing `internet` SetupStep — the Prisma
 *      enum is deliberately NOT migrated for a presentation-only split
 *      (`persistedStep` in app/setup/page.tsx), so `patchSetupStep("internet")`
 *      fires when the wizard advances ONTO `wifi` and onto `address`.
 *
 * Same Vitest + JSDOM + assert-on-DOM-strings pattern as the rest of the setup
 * tests: vi.mock at module-resolution, render the page-level SetupPage, walk
 * through the prior steps via the shared claim/org helpers.
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
  useAuth: () => ({ completeSetup: vi.fn(), setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

// Spy the persist call so we can assert the wifi/address sub-steps map to the
// single `internet` SetupStep. The rest of the surface is stubbed so any step
// we land on mounts quietly.
const patchSetupStepMock = vi.fn(async (_setupStep: string) => undefined);
const fetchDuckDnsStatusMock = vi.fn(async () => ({ configured: false }));

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: (setupStep: string) => patchSetupStepMock(setupStep),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: {
      taa_compliant: true,
      ndaa_889_clear: true,
      summary: "Supply chain verified",
    },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg. The backend
  // shape still reports `internet` as the next step — the split is client-only.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  // AddressStep calls fetchDuckDnsStatus on mount; WifiStep does not load.
  fetchDuckDnsStatus: () => fetchDuckDnsStatusMock(),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  // WARP-657 Wi-Fi clients — present so WifiStep's import resolves; the split
  // tests skip Wi-Fi (blank → Continue) so these are never actually called.
  setWifiSsid: vi.fn(async () => ({ status: "ok", tier: 1 })),
  setWifiPassword: vi.fn(async () => ({ status: "ok", tier: 1 })),
  confirmNetworkCommand: vi.fn(async () => ({ operationId: "op" })),
  fetchNetworkOperation: vi.fn(async () => ({ id: "op", state: "applied" })),
  // Storage auto-skips on an empty drive list — let it pass straight through
  // so "advancing past address reaches storage→discovery" is observable.
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
  postTeamInvite: vi.fn(async () => ({
    ok: true,
    token: "tok",
    email: "x@acme.co",
    role: "family",
    expires_at: "2026-06-04T00:00:00.000Z",
  })),
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

/** Walk welcome → claim → account → org → twofactor(skip) so the wizard lands
 *  on the first network sub-step, `wifi`. */
async function advanceToWifi() {
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
  // PR #380 — pass through the org step (account → org → twofactor).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
}

/** Skip the Wi-Fi step (blank SSID → no write) to land on `address`. The
 *  Address step's fetchDuckDnsStatus effect resolves before we read it. */
async function skipWifiToAddress() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup network split — wifi → address integration (Onboarding-Flow redesign)", () => {
  beforeEach(() => {
    patchSetupStepMock.mockClear();
    fetchDuckDnsStatusMock.mockClear();
    fetchDuckDnsStatusMock.mockResolvedValue({ configured: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Wi-Fi step after twofactor", async () => {
    render(<SetupPage />);
    await advanceToWifi();

    // First sub-step: Home Wi-Fi (component behaviour covered in WifiStep.test).
    expect(screen.getByText(/set up your home wi-fi/i)).toBeInTheDocument();
    // Its skip uses the redesign's dedicated label, not "Skip for now".
    expect(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    ).toBeInTheDocument();
  });

  it("advancing the Wi-Fi step (skip) lands on the Address step", async () => {
    render(<SetupPage />);
    await advanceToWifi();
    await skipWifiToAddress();

    expect(
      screen.getByText(/give your box a web address/i),
    ).toBeInTheDocument();
    // The DuckDNS suffix + dedicated skip label confirm we're on AddressStep.
    expect(screen.getAllByText(/\.duckdns\.org/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /skip — no remote access/i }),
    ).toBeInTheDocument();
  });

  it("advancing the Wi-Fi step with Continue (blank SSID) also lands on Address", async () => {
    render(<SetupPage />);
    await advanceToWifi();

    // Blank SSID → the primary CTA reads "Continue" and writes nothing.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(/give your box a web address/i),
    ).toBeInTheDocument();
  });

  it("skipping the Address step advances past it to storage → discovery", async () => {
    render(<SetupPage />);
    await advanceToWifi();
    await skipWifiToAddress();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /skip — no remote access/i }),
      );
    });
    // storage auto-skips on an empty drive list → discovery surface is shown.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("persists both sub-steps as the existing `internet` SetupStep", async () => {
    render(<SetupPage />);
    await advanceToWifi();
    // Advancing ONTO `wifi` (from twofactor) persists `internet`.
    expect(patchSetupStepMock).toHaveBeenCalledWith("internet");

    patchSetupStepMock.mockClear();
    await skipWifiToAddress();
    // Advancing ONTO `address` (from wifi) persists `internet` again — never a
    // `wifi`/`address` key the backend's SetupStep enum doesn't have.
    expect(patchSetupStepMock).toHaveBeenCalledWith("internet");
    expect(patchSetupStepMock).not.toHaveBeenCalledWith("wifi");
    expect(patchSetupStepMock).not.toHaveBeenCalledWith("address");
  });
});
