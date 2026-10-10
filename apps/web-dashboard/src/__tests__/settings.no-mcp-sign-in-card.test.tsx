/**
 * WARP-3951 mounted the Atlassian sign-in card on Settings; WARP-3965 moved it
 * to the connector's page under Connectors. Harness mirrors
 * settings.ai-providers.test.tsx; the card is stubbed so only the (absent)
 * mounting is asserted.
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

describe("Settings no longer mounts the Atlassian sign-in card", () => {
  // WARP-3965: Connectors is the one place to connect an MCP server.
  it("renders no sign-in card for atlassian", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());
    expect(screen.queryByTestId("mcp-card-atlassian")).toBeNull();
  });
});
