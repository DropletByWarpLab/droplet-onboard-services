/**
 * Onboarding Tour — motifs render LIVE box data, not static placeholders.
 *
 * The Done-step walkthrough originally shipped its beat motifs as hand-written
 * fixtures ("droplet-rack-1", "Wedding Photos · 482 GB", "Front door"). The
 * remote-access beat was already wired to a live signal (fetchVpnStatus →
 * ADR-023 FQDN); this proves the other four beats are too:
 *   - Recap   → fetchSystemHealth().status drives the online/degraded word;
 *   - Files   → fetchRecents() lists the owner's actual recent files;
 *   - AI      → fetchModelsPage().local[0].name shows the real on-device model;
 *   - Cameras → fetchCameras() renders the owner's configured cameras.
 *
 * Every fetch is best-effort: the second test proves that when the box can't be
 * reached, each motif degrades to an HONEST fallback (no fabricated data, no
 * crash) and the walkthrough copy still renders.
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

// The live-data seam. Each test re-stubs these with mockResolvedValue /
// mockRejectedValue before rendering.
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

const file = (name: string, size: number) => ({
  name,
  path: `/${name}`,
  isDirectory: false,
  size,
  mimeType: "application/octet-stream",
  modifiedAt: "2026-06-21T00:00:00Z",
});

const camera = (name: string, displayName: string) => ({
  name,
  displayName,
  manufacturer: null,
  model: null,
  ipAddress: "192.168.20.50",
  macAddress: null,
  enabled: true,
  autoDiscovered: true,
  status: "recording" as const,
  lastSeen: "2026-06-21T00:00:00Z",
  lastDetection: null,
});

beforeEach(() => {
  localStorage.clear();
  fetchVpnStatus.mockReset().mockResolvedValue({ publicFqdn: null });
  fetchSystemHealth.mockReset();
  fetchRecents.mockReset();
  fetchModelsPage.mockReset();
  fetchCameras.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ProductTour live motifs", () => {
  it("renders real box data across the beats", async () => {
    fetchSystemHealth.mockResolvedValue({
      status: "ok",
      components: [],
      uptime: 1,
      version: "1.0",
    });
    fetchRecents.mockResolvedValue([
      file("Quarterly Report.pdf", 482 * 1024),
      file("invoice.csv", 2 * 1024 * 1024),
    ]);
    fetchModelsPage.mockResolvedValue({
      local: [{ name: "qwen2.5:7b", family: "qwen", provider: "ollama", contextLength: 8192 }],
      cloud: [],
      gpu: null,
      avgLatencyMs: 0,
      cloudSpendUsd: 0,
    });
    fetchCameras.mockResolvedValue([camera("backyard", "Backyard"), camera("porch", "Front Porch")]);

    render(<ProductTour />);

    // Welcome / recap beat: live health word.
    expect(await screen.findByText("online")).toBeInTheDocument();

    // Files beat.
    fireEvent.click(screen.getByRole("button", { name: /Go to Files/i }));
    expect(await screen.findByText("Quarterly Report.pdf")).toBeInTheDocument();
    expect(screen.getByText("482 KB")).toBeInTheDocument();

    // AI beat: real on-device model name.
    fireEvent.click(screen.getByRole("button", { name: /Go to Private AI/i }));
    expect(await screen.findByText("qwen2.5:7b")).toBeInTheDocument();

    // Cameras beat: real camera label.
    fireEvent.click(screen.getByRole("button", { name: /Go to Cameras/i }));
    expect(await screen.findByText("Backyard")).toBeInTheDocument();

    // None of the old fixtures survive.
    expect(screen.queryByText(/droplet-rack-1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wedding Photos/i)).not.toBeInTheDocument();
  });

  it("falls back to honest empty states when the box is unreachable", async () => {
    fetchSystemHealth.mockRejectedValue(new Error("offline"));
    fetchRecents.mockRejectedValue(new Error("offline"));
    fetchModelsPage.mockRejectedValue(new Error("offline"));
    fetchCameras.mockRejectedValue(new Error("offline"));

    render(<ProductTour />);

    // Walkthrough copy still renders (no crash).
    expect(
      screen.getByRole("heading", { level: 1, name: /Your Droplet is live/i }),
    ).toBeInTheDocument();

    // AI beat keeps the generic label rather than inventing a model name.
    fireEvent.click(screen.getByRole("button", { name: /Go to Private AI/i }));
    expect(await screen.findByText("On-device model")).toBeInTheDocument();

    // Cameras beat shows an honest empty state, never fabricated cameras.
    fireEvent.click(screen.getByRole("button", { name: /Go to Cameras/i }));
    expect(await screen.findByText(/No cameras yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Front door/i)).not.toBeInTheDocument();
  });
});
