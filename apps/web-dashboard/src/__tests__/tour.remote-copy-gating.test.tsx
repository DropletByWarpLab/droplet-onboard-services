/**
 * WARP-993 — ProductTour remote-access beat: honest away-from-home gating.
 *
 * The tour's remote beat used to promise "the same address in the office and away"
 * unconditionally, and upgraded to the FQDN/green-padlock story on
 * `publicFqdn` alone. But the FQDN is split-horizon only (ADR-023 §3 — no
 * public A record): until the ADR-025 relay lands, that address is a dead end
 * away from home. The beat now keys on the orchestrator's honest
 * `offLanReachable` boolean:
 *
 *   - false/missing → home-network wording + "secure relay — coming soon";
 *   - true, no FQDN → the generic away promise;
 *   - true + FQDN   → the full one-URL-everywhere green-padlock story.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/tour",
}));

const completeTourMock = vi.fn(async () => {});
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeTour: completeTourMock }),
}));

const fetchVpnStatus = vi.fn();
const fetchSystemHealth = vi.fn();
const fetchRecents = vi.fn();
const fetchModelsPage = vi.fn();
const fetchCameras = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
  fetchSystemHealth: (...a: unknown[]) => fetchSystemHealth(...a),
  fetchRecents: (...a: unknown[]) => fetchRecents(...a),
  fetchModelsPage: (...a: unknown[]) => fetchModelsPage(...a),
  fetchCameras: (...a: unknown[]) => fetchCameras(...a),
  getCameraSnapshotUrl: (name: string) => `/api/cameras/${name}/snapshot`,
}));

import { ProductTour } from "@/components/tour/ProductTour";

beforeEach(() => {
  localStorage.clear();
  fetchVpnStatus.mockReset();
  fetchSystemHealth.mockReset().mockRejectedValue(new Error("offline"));
  fetchRecents.mockReset().mockRejectedValue(new Error("offline"));
  fetchModelsPage.mockReset().mockRejectedValue(new Error("offline"));
  fetchCameras.mockReset().mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

function gotoRemoteBeat() {
  fireEvent.click(screen.getByRole("button", { name: /go to remote access/i }));
}

describe("ProductTour — remote beat honesty (WARP-993)", () => {
  it("shows honest home-network copy when offLanReachable is missing (legacy status shape)", async () => {
    fetchVpnStatus.mockResolvedValue({ publicFqdn: null });
    render(<ProductTour />);
    gotoRemoteBeat();

    expect(
      await screen.findByRole("heading", { level: 1, name: /remote access/i }),
    ).toBeInTheDocument();
    expect(screen.queryAllByText(/office and away/i)).toHaveLength(0);
    expect(screen.queryAllByText(/anywhere/i)).toHaveLength(0);
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });

  it("stays honest even when the box HAS its FQDN but the relay is not live", async () => {
    fetchVpnStatus.mockResolvedValue({
      publicFqdn: "casa.droplet-us.com",
      offLanReachable: false,
    });
    render(<ProductTour />);
    gotoRemoteBeat();

    expect(
      await screen.findByRole("heading", { level: 1, name: /remote access/i }),
    ).toBeInTheDocument();
    // No away promise, no "trusted in the office AND away" address-bar motif.
    expect(screen.queryAllByText(/office and away/i)).toHaveLength(0);
    expect(screen.queryAllByText(/anywhere/i)).toHaveLength(0);
    expect(screen.queryByText("casa.droplet-us.com")).not.toBeInTheDocument();
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });

  it("keeps the generic away promise when offLanReachable is true without an FQDN", async () => {
    fetchVpnStatus.mockResolvedValue({
      publicFqdn: null,
      offLanReachable: true,
    });
    render(<ProductTour />);
    gotoRemoteBeat();

    expect(
      await screen.findByText(/office and away/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
  });

  it("upgrades to the one-URL green-padlock story when offLanReachable is true with an FQDN", async () => {
    fetchVpnStatus.mockResolvedValue({
      publicFqdn: "casa.droplet-us.com",
      offLanReachable: true,
    });
    render(<ProductTour />);
    gotoRemoteBeat();

    expect(
      await screen.findByText("casa.droplet-us.com"),
    ).toBeInTheDocument();
    expect(
      screen.queryAllByText(/office and away/i).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
    // WARP-1810: the address-bar motif's caption is business-locative —
    // "on-site and away", never "at home and away".
    expect(
      screen.getByText(/same secure address on-site and away/i),
    ).toBeInTheDocument();
  });
});
