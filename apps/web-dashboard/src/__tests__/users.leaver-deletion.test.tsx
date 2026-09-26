/**
 * WARP-3113 — the People roster's Delete: it schedules a 30-day retention
 * (the box keeps the leaver's files, then deletes the account), and a
 * pending deletion shows its date and a Cancel instead of Delete/Enable.
 * Harness mirrors users.enable-disable.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const setUserEnabledMock = vi.fn();
const deleteUserMock = vi.fn();
const cancelUserDeletionMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  setUserEnabled: (...a: any[]) => setUserEnabledMock(...a),
  createUser: vi.fn(),
  deleteUser: (...a: any[]) => deleteUserMock(...a),
  cancelUserDeletion: (...a: any[]) => cancelUserDeletionMock(...a),
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

const LEAVER = { id: "tomas.w", username: "tomas.w", displayName: "Tomas Weber", enabled: true };

beforeEach(() => {
  fetchUsersMock.mockReset();
  deleteUserMock.mockReset();
  cancelUserDeletionMock.mockReset();
  deleteUserMock.mockResolvedValue({ deletionDueAt: "2026-10-26T03:50:00.000Z" });
  cancelUserDeletionMock.mockResolvedValue(undefined);
});

describe("Users roster — Delete keeps files for 30 days (WARP-3113)", () => {
  it("the dialog says the files are kept, and confirming schedules the deletion", async () => {
    fetchUsersMock.mockResolvedValue({ users: [LEAVER] });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /delete user Tomas Weber/i }));
    expect(await screen.findByText(/files are kept for 30 days/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /keep for 30 days, then delete/i }));

    await waitFor(() =>
      expect(deleteUserMock).toHaveBeenCalledWith("tomas.w", { recipientId: undefined }),
    );
  });

  it("a pending deletion shows its state and offers Cancel, not Delete or Enable", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        { ...LEAVER, enabled: false, deletionStatus: "PENDING", deletionDueAt: "2026-10-26T03:50:00.000Z" },
      ],
    });
    render(<UsersPage />);

    const cancel = await screen.findByRole("button", { name: /cancel deletion of Tomas Weber/i });
    expect(screen.getByText(/^Deletion on /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete user Tomas Weber/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable user Tomas Weber/i })).not.toBeInTheDocument();

    fireEvent.click(cancel);
    await waitFor(() => expect(cancelUserDeletionMock).toHaveBeenCalledWith("tomas.w"));
  });

  it("WARP-3169: the picker offers only active owners, admins and members, and hands over", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        { ...LEAVER, userId: "u-tomas", role: "family" },
        { id: "anna", userId: "u-anna", username: "anna", displayName: "Anna Berg", role: "family", enabled: true },
        { id: "gus", userId: "u-gus", username: "gus", displayName: "Gus Guest", role: "guest", enabled: true },
        { id: "dan", userId: "u-dan", username: "dan", displayName: "Dan Gone", role: "family", enabled: false },
        { id: "pat", userId: "u-pat", username: "pat", displayName: "Pat Pending", role: "admin", enabled: false, deletionStatus: "PENDING" },
        { id: "nolocal", userId: null, username: "nolocal", displayName: "No Local Row", role: "family", enabled: true },
      ],
    });
    deleteUserMock.mockResolvedValue({ status: "deleted", folder: "transferred from tomas.w on 2026-09-25" });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /delete user Tomas Weber/i }));
    const picker = (await screen.findByRole("combobox", { name: /hand files to/i })) as HTMLSelectElement;
    const offered = Array.from(picker.options).map((o) => o.value);
    expect(offered).toEqual(["", "u-anna"]);

    fireEvent.change(picker, { target: { value: "u-anna" } });
    fireEvent.click(screen.getByRole("button", { name: /hand over files, then delete/i }));

    await waitFor(() =>
      expect(deleteUserMock).toHaveBeenCalledWith("tomas.w", { recipientId: "u-anna" }),
    );
  });
});
