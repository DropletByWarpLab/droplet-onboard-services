/**
 * WARP-174 — Cameras step.
 *
 * Validates:
 *   1. Auto-skip when zero discovered cameras.
 *   2. Renders one card per discovered camera with manufacturer/model
 *      and IP shown.
 *   3. "Add these cameras" calls acceptDiscoveredCamera per camera and
 *      advances to done.
 *   4. "Skip for now" advances without calling acceptDiscoveredCamera.
 *   5. Singular/plural copy ("this camera" vs "these cameras").
 *
 * Mirrors the storage step's test shape — vi.mock at module-resolution,
 * advance through prior steps via the same helper, assert on DOM-visible
 * strings.
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

const fetchDiscoveredCamerasMock = vi.fn();
const acceptDiscoveredCameraMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  // WARP-979 — the reworked AddressStep imports these (this walk skips the step).
  checkBoxName: vi.fn(async () => ({
    available: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    authoritative: false,
  })),
  setBoxName: vi.fn(async () => ({
    ok: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
  })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: () => fetchDiscoveredCamerasMock(),
  acceptDiscoveredCamera: (id: string) => acceptDiscoveredCameraMock(id),
  // WARP-933 — the step no longer auto-skips, so its existing-cameras fetch
  // actually runs to render; stub it (and removeCamera) so it loads cleanly.
  fetchCameras: vi.fn(async () => []),
  removeCamera: vi.fn(async () => undefined),
  // VPN step is downstream; lands on preCheck (endpointConfigured: false)
  // so tests can navigate it with one extra Skip click.
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  // PR #381 — team slots after ai; TeamStep imports postTeamInvite.
  postTeamInvite: vi.fn(async () => ({
    ok: true, token: "tok", email: "x@acme.co", role: "family",
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

async function advanceToCameras() {
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
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Onboarding-Flow redesign — Internet split into Wi-Fi then Address. Skip both.
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
    // WARP-979 — the address step (Secured / name your box) → skip.
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  // WARP-933 — Storage now RENDERS (no silent auto-skip): skip it, then skip
  // the Discovery step, to reach Cameras.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Cameras step's fetch effect.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FIXTURE_TWO = [
  {
    id: "cam-1",
    name: "hikvision-45",
    ip: "192.168.100.45",
    mac: "aa:bb:cc:dd:ee:01",
    manufacturer: "Hikvision",
    model: "DS-2CD2143G2",
    discoveredAt: "2026-05-14T12:00:00Z",
  },
  {
    id: "cam-2",
    name: "reolink-62",
    ip: "192.168.100.62",
    mac: "aa:bb:cc:dd:ee:02",
    manufacturer: "Reolink",
    model: "RLC-810A",
    discoveredAt: "2026-05-14T12:01:00Z",
  },
];

describe("setup Cameras step (WARP-174)", () => {
  beforeEach(() => {
    fetchDiscoveredCamerasMock.mockReset();
    acceptDiscoveredCameraMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a visible empty state (no silent auto-skip) when zero cameras, and Continue advances (WARP-933)", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue([]);
    render(<SetupPage />);
    await advanceToCameras();

    // WARP-933 — the step is VISIBLE, not silently jumped past.
    expect(screen.getByText(/no cameras yet/i)).toBeInTheDocument();

    // Continue past cameras (nothing to add), then skip VPN, AI, Team → Done.
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    expect(acceptDiscoveredCameraMock).not.toHaveBeenCalled();
  });

  it("renders one card per discovered camera with manufacturer + IP", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue(FIXTURE_TWO);
    render(<SetupPage />);
    await advanceToCameras();

    expect(screen.getByText(/set up your cameras/i)).toBeInTheDocument();
    expect(
      screen.getByText(/we found 2 cameras on your network/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Hikvision DS-2CD2143G2/)).toBeInTheDocument();
    expect(screen.getByText(/Reolink RLC-810A/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.100\.45/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.100\.62/)).toBeInTheDocument();
  });

  it("uses singular copy with one camera", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue([FIXTURE_TWO[0]]);
    render(<SetupPage />);
    await advanceToCameras();

    expect(
      screen.getByText(/we found 1 camera on your network/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add this camera/i }),
    ).toBeInTheDocument();
  });

  it("Add these cameras → accept each + advance", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue(FIXTURE_TWO);
    acceptDiscoveredCameraMock.mockResolvedValue(undefined);
    render(<SetupPage />);
    await advanceToCameras();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add these cameras/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(acceptDiscoveredCameraMock).toHaveBeenCalledWith("cam-1");
    expect(acceptDiscoveredCameraMock).toHaveBeenCalledWith("cam-2");
    // Landed on Done.
    // Cameras step finished. Skip VPN preCheck, then AI, then Team (PR #381),
    // to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });

  it("Skip for now advances without calling acceptDiscoveredCamera", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue(FIXTURE_TWO);
    render(<SetupPage />);
    await advanceToCameras();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(acceptDiscoveredCameraMock).not.toHaveBeenCalled();
    // Cameras step finished. Skip VPN preCheck, then AI, then Team (PR #381),
    // to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });

  it("when every accept call fails, stays on step + shows error", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue(FIXTURE_TWO);
    acceptDiscoveredCameraMock.mockRejectedValue(new Error("boom"));
    render(<SetupPage />);
    await advanceToCameras();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add these cameras/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/couldn't add the cameras/i)).toBeInTheDocument();
    // Did NOT advance.
    expect(screen.queryByTestId("welcome-flourish")).not.toBeInTheDocument();
  });
});
