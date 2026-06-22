/**
 * WARP-872 — the Settings AI-providers section must offer a key form for every
 * cloud provider the Models page advertises (Anthropic, OpenAI, Gemini). The
 * orchestrator's models summary always returns all three, and each Models-page
 * row points the user to Settings to enable it — so a missing Gemini form is a
 * dead-end.
 *
 * Harness mirrors settings.create-user-temp-password.test.tsx, but mocks
 * ProviderKeyForm to echo its props so we can assert which providers render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchUsersMock = vi.fn();
const listProviderKeysMock = vi.fn();
const createUserMock = vi.fn();
const deleteUserMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: (...a: any[]) => createUserMock(...a),
  deleteUser: (...a: any[]) => deleteUserMock(...a),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "admin", username: "admin", displayName: "Admin", role: "owner" },
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({ device: null, devices: [], health: null, isLoading: false, error: null }),
}));

vi.mock("@/components/ProviderKeyForm", () => ({
  ProviderKeyForm: ({ provider, label }: { provider: string; label: string }) => (
    <div data-testid={`provider-key-${provider}`}>{label}</div>
  ),
}));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  listProviderKeysMock.mockReset();
  createUserMock.mockReset();
  deleteUserMock.mockReset();
  listProviderKeysMock.mockResolvedValue([]);
  fetchUsersMock.mockResolvedValue({ users: [] });
});

describe("Settings AI providers — provider parity (WARP-872)", () => {
  it("renders a key form for Anthropic, OpenAI, and Gemini", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());

    expect(screen.getByTestId("provider-key-anthropic")).toBeInTheDocument();
    expect(screen.getByTestId("provider-key-openai")).toBeInTheDocument();
    expect(screen.getByTestId("provider-key-gemini")).toHaveTextContent(
      "Gemini (Google)",
    );
  });
});
