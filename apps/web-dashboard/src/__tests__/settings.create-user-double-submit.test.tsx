/**
 * WARP-874 — the Settings "Create user" action must not double-submit. With no
 * in-flight guard, an Enter-then-click or a rapid double-click fires createUser
 * twice (duplicate POST + a confusing second error). The Create button should
 * disable while the request is outstanding.
 *
 * Harness mirrors settings.create-user-temp-password.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

vi.mock("@/components/ProviderKeyForm", () => ({ ProviderKeyForm: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import SettingsPage from "@/app/settings/page";

const STRONG = "Temp-secret123";

beforeEach(() => {
  fetchUsersMock.mockReset();
  listProviderKeysMock.mockReset();
  createUserMock.mockReset();
  deleteUserMock.mockReset();
  listProviderKeysMock.mockResolvedValue([]);
  fetchUsersMock.mockResolvedValue({ users: [] });
  // A request that stays in flight for the whole test window, so the guard is
  // what (and only what) prevents the second submission.
  createUserMock.mockImplementation(() => new Promise<void>(() => {}));
});

async function openAndFill() {
  render(<SettingsPage />);
  await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /add user/i }));
  fireEvent.change(screen.getByPlaceholderText(/you@company.com/i), {
    target: { value: "kid@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: STRONG },
  });
}

describe("Settings create-user — double-submit guard (WARP-874)", () => {
  it("calls createUser only once when Create is clicked twice rapidly", async () => {
    await openAndFill();
    const createBtn = screen.getByRole("button", { name: /^create/i });
    fireEvent.click(createBtn);
    fireEvent.click(createBtn);

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock).toHaveBeenCalledTimes(1);
  });

  it("disables the Create button while the request is in flight", async () => {
    await openAndFill();
    const createBtn = screen.getByRole("button", { name: /^create/i });
    fireEvent.click(createBtn);

    await waitFor(() => expect(createBtn).toBeDisabled());
  });
});
