/**
 * WARP-1270 (T18) — "People" / "Departments & teams" tab on the Users page
 * (design brief §3/§4). WARP-1341: business-only build, so the tab strip is
 * always present.
 *
 * Covers:
 *   - Tab strip presence + switching.
 *   - Invite modal's collapsed "Add to a department" section, expand, and
 *     the multi-select payload it feeds createInvite (brief §4).
 *
 * DepartmentsPanel itself (list/detail/rights/create/archive) has its own
 * dedicated test file — this file only covers the /users page's tab
 * behaviour and invite-modal-extension seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const listInvitesMock = vi.fn();
const createInviteMock = vi.fn();
const listDepartmentsMock = vi.fn();
const getDepartmentMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  createInvite: (...a: any[]) => createInviteMock(...a),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: vi.fn(),
  fetchUserUsage: vi.fn(),
  updateUserUsage: vi.fn(),
  fetchAdminFilesUsage: vi.fn().mockResolvedValue({ users: [], departments: [] }),
  listDepartments: (...a: any[]) => listDepartmentsMock(...a),
  getDepartment: (...a: any[]) => getDepartmentMock(...a),
  createDepartment: vi.fn(),
  createTeam: vi.fn(),
  archiveDepartment: vi.fn(),
  restoreDepartment: vi.fn(),
  addDepartmentMember: vi.fn(),
  updateDepartmentMemberRight: vi.fn(),
  removeDepartmentMember: vi.fn(),
  fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  fetchDevices: vi.fn().mockResolvedValue([]),
  fetchHealth: vi.fn().mockResolvedValue({}),
  // WARP-1532 (T8): the page now pulls the access-roles surface — resolve
  // benign empties so this file keeps exercising its own concern only.
  listAccessRoles: vi.fn().mockResolvedValue({ roles: [] }),
  // WARP-2738 role templates. Panel-mounting suites need BOTH: a named
  // export missing from this factory throws the moment the component reads
  // it, so the mock has to move with the imports.
  listRoleTemplates: vi.fn().mockResolvedValue({ roleTemplates: [], enforcedModuleIds: [] }),
  createRoleFromTemplate: vi.fn(),
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

// WARP-1532 (T8): the page loads configured connectors for the role builder.
vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "admin-uuid", username: "admin", displayName: "Admin", role: "owner" },
  }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="invite-qr" data-value={value} />,
}));

// WARP-1341: business-only build — useWorkspace() is a static context.
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: "business",
    isBusiness: true,
  }),
}));

import UsersPage from "@/app/users/page";

const FINANCE = {
  id: "d1",
  name: "Finance",
  slug: "finance",
  kind: "DEPARTMENT" as const,
  parentId: null,
  description: null,
  state: "active" as const,
  quotaBytes: null,
  aclVersion: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archivedAt: null,
  memberCount: 2,
  teamCount: 0,
  myRight: "manager" as const,
  usedBytes: null,
};

beforeEach(() => {
  fetchUsersMock.mockReset();
  listInvitesMock.mockReset();
  createInviteMock.mockReset();
  listDepartmentsMock.mockReset();
  getDepartmentMock.mockReset();
  fetchUsersMock.mockResolvedValue({ users: [{ id: "alice", username: "alice", displayName: "Alice" }] });
  listInvitesMock.mockResolvedValue({ invites: [] });
  listDepartmentsMock.mockResolvedValue({ departments: [FINANCE] });
});

describe("Users page — Departments & teams tab", () => {
  it("tab strip renders with People active by default, switching shows the Departments panel", async () => {
    getDepartmentMock.mockResolvedValue({
      department: FINANCE,
      usedBytes: null,
      members: [],
      teams: [],
    });
    render(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^people$/i })).toBeInTheDocument();
    });
    const peopleTab = screen.getByRole("tab", { name: /^people$/i });
    const deptTab = screen.getByRole("tab", { name: /departments.*teams/i });
    expect(peopleTab).toHaveAttribute("aria-selected", "true");
    expect(deptTab).toHaveAttribute("aria-selected", "false");

    fireEvent.click(deptTab);
    await waitFor(() => {
      expect(deptTab).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => {
      expect(listDepartmentsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId("departments-panel")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Finance").length).toBeGreaterThan(0);
  });
});

describe("Users page — invite modal 'Add to a department' (design brief §4)", () => {
  it("expands to a checkbox row per department, feeding the invite payload", async () => {
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    // Collapsed behind "+ Add to a department".
    const collapseBtn = await screen.findByText(/add to a department/i);
    fireEvent.click(collapseBtn);

    // Expanded: the department renders as a checkbox row, defaulting
    // unchecked (no grant) with a Contributor-default right select.
    await waitFor(() => {
      expect(screen.getAllByText("Finance").length).toBeGreaterThan(0);
    });
    const checkbox = document.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox as Element);

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(createInviteMock).toHaveBeenCalledTimes(1);
    });
    const payload = createInviteMock.mock.calls[0][0];
    expect(payload.departments).toEqual([{ departmentId: "d1", right: "contributor" }]);
  });

  it("does not send a departments array when nothing is checked", async () => {
    createInviteMock.mockResolvedValueOnce({
      token: "y".repeat(43),
      url: "http://droplet.local/invite/" + "y".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "carol@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(createInviteMock).toHaveBeenCalledTimes(1);
    });
    expect(createInviteMock.mock.calls[0][0].departments).toBeUndefined();
  });
});
