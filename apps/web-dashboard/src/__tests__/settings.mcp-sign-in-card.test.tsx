/**
 * WARP-3951 — the Settings page mounts the Atlassian sign-in card.
 * Harness mirrors settings.ai-providers.test.tsx; the card itself is stubbed
 * (it has its own tests) so only the mounting is asserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchUsersMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchPlaceLookupChannel: vi.fn().mockResolvedValue(null),
  setPlaceLookupChannel: vi.fn(),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
  fetchCapabilities: () => Promise.resolve({ claudeActivity: false, ragEval: false }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "admin", username: "admin", displayName: "Admin", role: "owner" },
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({ device: null, devices: [], health: null, isLoading: false, error: null }),
}));

vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

vi.mock("@/components/integrations/McpSignInCard", () => ({
  mcpSignInName: (provider: string) => (provider === "atlassian" ? "Atlassian" : provider),
  McpSignInCard: (p: { provider: string; displayName: string; admin?: boolean }) => (
    <div data-testid={`mcp-card-${p.provider}`} data-name={p.displayName} data-admin={String(Boolean(p.admin))} />
  ),
}));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  fetchUsersMock.mockResolvedValue({ users: [] });
});

describe("Settings mounts the Atlassian sign-in card", () => {
  it("renders the member-mode card for atlassian", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());
    const card = screen.getByTestId("mcp-card-atlassian");
    expect(card).toHaveAttribute("data-name", "Atlassian");
    expect(card).toHaveAttribute("data-admin", "false");
  });
});
