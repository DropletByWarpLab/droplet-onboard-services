/**
 * The People (/users) roster's account-state affordance.
 *
 * `performEnable` and the server's POST /auth/users/:username/enable have
 * both existed for a long time, but nothing in the dashboard ever called
 * `handleSetEnabled(u, true)` — the row rendered an unconditional Disable
 * button. An admin could cut a person off and had no way, on any screen, to
 * let them back in. The roster could not even show who was deactivated,
 * because `ncListUsers` dropped Nextcloud's `enabled` flag before the route
 * ever saw it.
 *
 * These tests pin the row's two states and the back-compat default.
 * Harness mirrors users.local-account.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const setUserEnabledMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  setUserEnabled: (...a: any[]) => setUserEnabledMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  createInvite: vi.fn(),
  listInvites: vi.fn().mockResolvedValue({ invites: [] }),
  revokeInvite: vi.fn(),
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  fetchDevices: vi.fn().mockResolvedValue([]),
  fetchHealth: vi.fn().mockResolvedValue({}),
  listAccessRoles: vi.fn().mockResolvedValue({ roles: [] }),
  createAccessRole: vi.fn(),
  updateAccessRole: vi.fn(),
  deleteAccessRole: vi.fn(),
  duplicateAccessRole: vi.fn(),
  archiveAccessRole: vi.fn(),
  assignAccessRole: vi.fn(),
  setPersonAccess: vi.fn().mockResolvedValue({ syncState: "pending" }),
  putAccessExceptions: vi.fn().mockResolvedValue({ exceptions: [] }),
  fetchEffectiveAccess: vi.fn().mockRejectedValue(new Error("not merged yet")),
}));

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "admin",
      username: "admin",
      displayName: "Admin",
      role: "owner",
    },
  }),
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceType: "business", isBusiness: true }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="invite-qr" data-value={value} />
  ),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import UsersPage from "@/app/users/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  setUserEnabledMock.mockReset();
  setUserEnabledMock.mockResolvedValue(undefined);
});

describe("Users roster — enable / disable a person", () => {
  it("offers Enable, not Disable, on a deactivated row", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        {
          id: "tomas.w",
          username: "tomas.w",
          displayName: "Tomas Weber",
          enabled: false,
        },
      ],
    });

    render(<UsersPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /enable user Tomas Weber/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /disable user Tomas Weber/i }),
    ).not.toBeInTheDocument();
  });

  it("Enable calls through with enabled=true — the call nothing used to make", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        {
          id: "tomas.w",
          username: "tomas.w",
          displayName: "Tomas Weber",
          enabled: false,
        },
      ],
    });

    render(<UsersPage />);
    const btn = await screen.findByRole("button", {
      name: /enable user Tomas Weber/i,
    });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(setUserEnabledMock).toHaveBeenCalledWith("tomas.w", true),
    );
  });

  it("names the state on the row, so the roster does not look uniform", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        {
          id: "tomas.w",
          username: "tomas.w",
          displayName: "Tomas Weber",
          enabled: false,
        },
      ],
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByText(/deactivated/i)).toBeInTheDocument(),
    );
  });

  it("offers Disable on an active row", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "maya.o", username: "maya.o", displayName: "Maya Okonkwo", enabled: true },
      ],
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /disable user Maya Okonkwo/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /enable user Maya Okonkwo/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/deactivated/i)).not.toBeInTheDocument();
  });

  it("treats a missing `enabled` as active, so an older orchestrator does not deactivate the roster", async () => {
    // A box whose orchestrator predates the roster carrying `enabled` sends
    // no such field. Reading that as "disabled" would paint every row
    // Deactivated and replace every Disable button with Enable.
    fetchUsersMock.mockResolvedValue({
      users: [{ id: "maya.o", username: "maya.o", displayName: "Maya Okonkwo" }],
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /disable user Maya Okonkwo/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/deactivated/i)).not.toBeInTheDocument();
  });
});
