/**
 * WARP-2984 — the roster lists every account (local, SSO, SCIM,
 * Nextcloud-only), tagged by source, and actions that don't apply to a
 * source are replaced by the reason rather than left to 409.
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
  fetchUserUsage: vi.fn().mockResolvedValue({ policy: {}, used: "0" }),
  updateUserUsage: vi.fn(),
  fetchAdminFilesUsage: vi.fn().mockResolvedValue({ users: [] }),
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


const SSO_ROW = {
  id: "dana.chen",
  username: "dana.chen",
  displayName: "Dana Chen",
  userId: "u-dana",
  role: "family",
  enabled: true,
  source: "sso",
  hasStorage: false,
};
const LOCAL_ROW = {
  id: "alice",
  username: "alice",
  displayName: "Alice Martin",
  userId: "u-alice",
  role: "family",
  enabled: true,
  source: "local",
  hasStorage: true,
};

describe("Users roster — every account, tagged by source (WARP-2984)", () => {
  it("renders an SSO-only account with its source chip", async () => {
    fetchUsersMock.mockResolvedValue({ users: [LOCAL_ROW, SSO_ROW] });
    render(<UsersPage />);

    expect(await screen.findByText("Dana Chen")).toBeInTheDocument();
    expect(screen.getByText("SSO")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
  });

  it("the SSO row's Disable reaches the API under the row's roster id", async () => {
    fetchUsersMock.mockResolvedValue({ users: [SSO_ROW] });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /disable user Dana Chen/i }));
    // Disabling cuts a person off, so the page confirms first.
    const confirm = await screen.findAllByRole("button", { name: /^disable/i });
    fireEvent.click(confirm[confirm.length - 1]!);

    await waitFor(() => expect(setUserEnabledMock).toHaveBeenCalledWith("dana.chen", false));
  });

  it("edit dialog on an SSO account: no password field, no storage limits — the reasons instead", async () => {
    fetchUsersMock.mockResolvedValue({ users: [SSO_ROW] });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /edit user Dana Chen/i }));

    expect(await screen.findByText(/signs in through your identity provider/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/set new password/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no file storage/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Storage limit")).not.toBeInTheDocument();
  });

  it("edit dialog on a local account keeps both (control)", async () => {
    fetchUsersMock.mockResolvedValue({ users: [LOCAL_ROW] });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /edit user Alice Martin/i }));

    expect(await screen.findByLabelText(/set new password/i)).toBeInTheDocument();
    expect(await screen.findByLabelText("Storage limit")).toBeInTheDocument();
  });
});
