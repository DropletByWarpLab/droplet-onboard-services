/**
 * WARP-824 — Settings create-user form gains a "require password change on
 * first login" checkbox (default ON). When the admin creates a user, the
 * checkbox state is passed to createUser() as `mustChangePassword`.
 *
 * Harness mirrors settings.row-actions.test.tsx.
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
  // ShellPage's status chip reads /api/orchestrator/health via this fetcher.
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
  createUserMock.mockResolvedValue(undefined);
});

async function openAddUserForm() {
  render(<SettingsPage />);
  await waitFor(() => expect(fetchUsersMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /add user/i }));
}

function fillForm() {
  fireEvent.change(screen.getByPlaceholderText(/you@company.com/i), {
    target: { value: "kid@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: STRONG },
  });
}

describe("Settings create-user — temp-password / forced-change checkbox", () => {
  it("renders the 'require password change on first login' checkbox, checked by default", async () => {
    await openAddUserForm();
    const checkbox = screen.getByRole("checkbox", { name: /change.*first login/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it("passes mustChangePassword=true to createUser when left checked (default)", async () => {
    await openAddUserForm();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock).toHaveBeenCalledWith("kid@warp.test", STRONG, undefined, true);
  });

  it("passes mustChangePassword=false when the admin unchecks it", async () => {
    await openAddUserForm();
    fillForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /change.*first login/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock).toHaveBeenCalledWith("kid@warp.test", STRONG, undefined, false);
  });
});
