/**
 * WARP-2871 — the Settings "AI providers" section no longer hosts the cloud
 * key forms (WARP-872 provider parity is moot: the Models page is the one
 * place for cloud models). Settings keeps the on-device inference card and
 * ONE link row that points owners/admins at /models.
 *
 * Harness mirrors settings.create-user-temp-password.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchUsersMock = vi.fn();
const createUserMock = vi.fn();
const deleteUserMock = vi.fn();

vi.mock("@/lib/api", () => ({
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

vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  createUserMock.mockReset();
  deleteUserMock.mockReset();
  fetchUsersMock.mockResolvedValue({ users: [] });
});

describe("Settings AI providers — cloud keys live on /models (WARP-2871)", () => {
  it("renders one link row to the Models page instead of per-provider key forms", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());

    const link = screen.getByRole("link", { name: /cloud model keys/i });
    expect(link).toHaveAttribute("href", "/models");
    expect(link).toHaveTextContent("Managed on the Models page by owners and admins");
    // No key inputs on Settings any more.
    expect(screen.queryByPlaceholderText(/api key|paste the key/i)).toBeNull();
    expect(screen.queryByText(/gemini/i)).toBeNull();
  });
});
