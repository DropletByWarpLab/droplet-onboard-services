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
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchDiscoveredCamerasMock = vi.fn();
const acceptDiscoveredCameraMock = vi.fn();

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
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: () => fetchDiscoveredCamerasMock(),
  acceptDiscoveredCamera: (id: string) => acceptDiscoveredCameraMock(id),
  // VPN step is downstream; lands on preCheck (endpointConfigured: false)
  // so tests can navigate it with one extra Skip click.
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

async function advanceToCameras() {
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
  // Internet → skip
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Storage auto-skip → Discovery → skip
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

  it("auto-skips when zero discovered cameras", async () => {
    fetchDiscoveredCamerasMock.mockResolvedValue([]);
    render(<SetupPage />);
    await advanceToCameras();
    // Skipped through to Done — WelcomeFlourish renders.
    // Cameras step finished. Skip VPN preCheck, then AI, to reach Done.
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
    // Cameras step finished. Skip VPN preCheck, then AI, to reach Done.
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
    // Cameras step finished. Skip VPN preCheck, then AI, to reach Done.
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
