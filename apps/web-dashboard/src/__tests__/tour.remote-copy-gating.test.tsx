/** The tour describes direct WireGuard and the internal DNS hostname. */
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

describe("ProductTour — direct WireGuard and internal DNS", () => {
  it("describes WireGuard prerequisites without automatic relay promises", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: null });
    render(<ProductTour />);
    gotoRemoteBeat();
    expect(await screen.findByRole("heading", { level: 1, name: /remote access uses WireGuard/i })).toBeInTheDocument();
    expect(screen.getByText(/Install WireGuard on your device/i)).toBeInTheDocument();
    expect(screen.queryAllByText(/coming soon|green padlock|turn on Connect/i)).toHaveLength(0);
  });
  it("shows the internal name even when a legacy public name is returned", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: "droplet-ai.lan", publicFqdn: "old.example.com", offLanReachable: false });
    render(<ProductTour />);
    gotoRemoteBeat();
    expect(await screen.findByText("https://droplet-ai.lan")).toBeInTheDocument();
    expect(screen.queryByText(/old.example.com/)).not.toBeInTheDocument();
    expect(screen.getByText(/set up a direct endpoint for away access/i)).toBeInTheDocument();
  });
  it("reports direct away configuration as needing verification", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: "box.lan", offLanReachable: true });
    render(<ProductTour />);
    gotoRemoteBeat();
    expect(await screen.findByText(/Direct away endpoint configured · verify from another network/i)).toBeInTheDocument();
    expect(screen.queryAllByText(/anywhere|trusted|coming soon/i)).toHaveLength(0);
  });
});
