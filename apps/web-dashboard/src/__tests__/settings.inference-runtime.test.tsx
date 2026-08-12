/**
 * WARP-1926 — Settings must name the runtime the box ACTUALLY serves from.
 *
 * This row hardcoded the string "Ollama (on-device)". Docker Model Runner has
 * been the shipped default since WARP-1870, so on every default box the
 * Settings page told its owner it was running a daemon that is not installed
 * — while `docker ps` showed `droplet-dmr` and no ollama container at all.
 *
 * Harness mirrors settings.ai-providers.test.tsx, but `useDevice` is a
 * mutable mock so each case can supply a different /api/health payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { HealthResponse } from "@/lib/types";

const fetchUsersMock = vi.fn();
const listProviderKeysMock = vi.fn();

/** Mutated per-test, read by the useDevice mock below. */
let healthValue: HealthResponse | null = null;

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "admin", username: "admin", displayName: "Admin", role: "owner" },
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: null,
    devices: [],
    health: healthValue,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/components/ProviderKeyForm", () => ({
  ProviderKeyForm: ({ provider }: { provider: string }) => (
    <div data-testid={`provider-key-${provider}`} />
  ),
}));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import SettingsPage from "@/app/settings/page";

function health(runtime?: "dmr" | "ollama"): HealthResponse {
  return {
    status: "ok",
    uptime: 42,
    version: "0.1.0",
    ...(runtime ? { inferenceRuntime: runtime } : {}),
    services: {
      db: true,
      redis: true,
      aiGateway: true,
      matter: true,
      router: true,
      frigate: true,
      switch: true,
      display: true,
    },
  } as HealthResponse;
}

beforeEach(() => {
  healthValue = null;
  fetchUsersMock.mockReset();
  listProviderKeysMock.mockReset();
  listProviderKeysMock.mockResolvedValue([]);
  fetchUsersMock.mockResolvedValue({ users: [] });
});

describe("Settings — on-device runtime label (WARP-1926)", () => {
  it("names Docker Model Runner on a DMR box, and never says Ollama", async () => {
    healthValue = health("dmr");
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("Docker Model Runner (on-device)")).toBeInTheDocument(),
    );
    // The actual regression: the old hardcoded string must be gone.
    expect(screen.queryByText("Ollama (on-device)")).not.toBeInTheDocument();
  });

  it("still names Ollama on a box that genuinely runs it", async () => {
    healthValue = health("ollama");
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("Ollama (on-device)")).toBeInTheDocument(),
    );
  });

  it("falls back to a generic truth rather than guessing a daemon", async () => {
    // An older orchestrator does not send the field. Naming either engine here
    // would be a coin-flip presented as fact.
    healthValue = health(undefined);
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("On-device runtime (on-device)")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Ollama (on-device)")).not.toBeInTheDocument();
  });
});
