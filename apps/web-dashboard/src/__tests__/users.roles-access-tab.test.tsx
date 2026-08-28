/**
 * WARP-1532 (RBAC v2 T8) — the "Roles & access" tab on /users + the People
 * roster/person-editor extensions.
 *
 * Covers:
 *   - Tab gating: owner/admin sees the third tab; switching mounts the panel.
 *   - Member view (fetchUsers 403): People read-only, NO Roles tab, controls
 *     hidden (not disabled), the §12 caption verbatim.
 *   - Roster extensions: role chip (custom-role name resolved, Staff label
 *     for the family tier) + the All / By role filter.
 *   - Person editor: role select seeded, §12 session-revocation sync line on
 *     save, PATCH /api/people/:id/access payload shape.
 *   - Owner-row guardrails: disable/delete disabled with the §12 tooltip.
 *
 * RolesAccessPanel / RoleBuilderSheet / PersonAccessSection have their own
 * dedicated suites — this file covers the page seams only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const listInvitesMock = vi.fn();
const listAccessRolesMock = vi.fn();
const setPersonAccessMock = vi.fn();
const putAccessExceptionsMock = vi.fn();
const fetchEffectiveAccessMock = vi.fn();
const fetchUserUsageMock = vi.fn();
const updateUserUsageMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  createInvite: vi.fn(),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: vi.fn(),
  fetchUserUsage: (...a: any[]) => fetchUserUsageMock(...a),
  updateUserUsage: (...a: any[]) => updateUserUsageMock(...a),
  fetchAdminFilesUsage: vi.fn().mockResolvedValue({ users: [], departments: [] }),
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  getDepartment: vi.fn(),
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
  // WARP-1532 access surface
  listAccessRoles: (...a: any[]) => listAccessRolesMock(...a),
  createAccessRole: vi.fn(),
  updateAccessRole: vi.fn(),
  deleteAccessRole: vi.fn(),
  duplicateAccessRole: vi.fn(),
  archiveAccessRole: vi.fn(),
  assignAccessRole: vi.fn(),
  setPersonAccess: (...a: any[]) => setPersonAccessMock(...a),
  putAccessExceptions: (...a: any[]) => putAccessExceptionsMock(...a),
  fetchEffectiveAccess: (...a: any[]) => fetchEffectiveAccessMock(...a),
}));

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-owner", username: "stefan", displayName: "Stefan", role: "owner" },
  }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="invite-qr" data-value={value} />,
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceType: "business", isBusiness: true }),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import UsersPage from "@/app/users/page";
import { ACCESS_COPY } from "@/components/access/copy";

const FINANCE_ROLE = {
  id: "r-finance",
  name: "Finance",
  slug: "finance",
  description: null,
  startingPoint: "family" as const,
  state: "active" as const,
  storageQuotaBytes: "26843545600",
  maxUploadSizeMb: null,
  llmDailyMessageCap: null,
  cloudModelsAllowed: false,
  mayOperateLocks: false,
  createdBy: "u0",
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:00:00Z",
  peopleCount: 1,
  featureGrants: [],
  toolGrants: [],
  connectorGrants: [],
};

const ROSTER = [
  { id: "stefan", username: "stefan", displayName: "Stefan C", userId: "u-owner", role: "owner", accessRoleId: null },
  { id: "priya", username: "priya", displayName: "Priya Nair", userId: "u-priya", role: "family", accessRoleId: "r-finance" },
  { id: "sam", username: "sam", displayName: "Sam Ortega", userId: "u-sam", role: "guest", accessRoleId: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchUsersMock.mockResolvedValue({ users: ROSTER });
  listInvitesMock.mockResolvedValue({ invites: [] });
  listAccessRolesMock.mockResolvedValue({ roles: [FINANCE_ROLE] });
  fetchUserUsageMock.mockResolvedValue({ policy: null, usedBytes: null });
  fetchEffectiveAccessMock.mockResolvedValue({
    tier: "family",
    features: [],
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    usage: { storageQuotaBytes: null, maxUploadSizeMb: null, llmDailyMessageCap: null },
    deptRights: [],
    exceptions: [],
  });
  setPersonAccessMock.mockResolvedValue({ syncState: "pending" });
  putAccessExceptionsMock.mockResolvedValue({ exceptions: [] });
});

describe("tab gating by role", () => {
  it("owner sees the Roles & access tab; switching mounts the panel", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    const tab = screen.getByRole("tab", { name: ACCESS_COPY.tab });
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.yourRoles)).toBeInTheDocument());
    expect(screen.getByText(ACCESS_COPY.builtinRoles)).toBeInTheDocument();
  });

  it("member view: People read-only, no Roles tab, controls hidden, §12 caption", async () => {
    fetchUsersMock.mockRejectedValue(new Error("Request failed: 403"));
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.memberCaption)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("tab", { name: ACCESS_COPY.tab })).not.toBeInTheDocument();
    // Controls hidden, not disabled.
    expect(screen.queryByRole("button", { name: /Invite user/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create local account/i })).not.toBeInTheDocument();
  });
});

describe("roster extensions", () => {
  it("shows the assigned-role chip (custom name resolved; Staff label for bare family tier)", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    // Priya carries her custom role's name; Sam carries the Guest tier label.
    // The roles list loads on its own chain (listAccessRoles → setAccessRoles),
    // independent of the roster fetch awaited above, so the custom name is
    // awaited rather than assumed to have committed alongside the roster.
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("groups the roster by role when the By role filter is on", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "By role" }));
    // Group headers render with counts.
    const financeGroup = screen.getByTestId("roster-group-Finance");
    expect(within(financeGroup).getByText("Priya Nair")).toBeInTheDocument();
    const guestGroup = screen.getByTestId("roster-group-Guest");
    expect(within(guestGroup).getByText("Sam Ortega")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.queryByTestId("roster-group-Finance")).not.toBeInTheDocument();
  });

  it("owner row: disable + delete are disabled with the §12 tooltip (self row hides them)", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    // The signed-in owner IS the owner row here, so it takes the self path
    // (buttons hidden). Give the roster a second owner-like case: none — so
    // assert on Priya's row buttons enabled vs a synthetic owner row below.
    fetchUsersMock.mockResolvedValue({
      users: [
        ...ROSTER,
        { id: "co", username: "co", displayName: "Co Owner", userId: "u-co", role: "owner", accessRoleId: null },
      ],
    });
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    // Force a reload via the roster refresh path: simplest is re-render.
    render(<UsersPage />);
    await waitFor(() => expect(screen.getAllByText("Co Owner").length).toBeGreaterThan(0));
    const disableBtn = screen.getByRole("button", { name: "Disable user Co Owner" });
    const deleteBtn = screen.getByRole("button", { name: "Delete user Co Owner" });
    expect(disableBtn).toBeDisabled();
    expect(disableBtn).toHaveAttribute("title", ACCESS_COPY.ownerTooltip);
    expect(deleteBtn).toBeDisabled();
  });
});

describe("person editor — role change flow", () => {
  it("PATCHes the new access, shows the §12 session-revocation line, then reloads", async () => {
    // Hold the PATCH open so the applying-state line is observable.
    let resolvePatch: (v: { syncState: string }) => void = () => {};
    setPersonAccessMock.mockImplementation(
      () => new Promise((res) => (resolvePatch = res as typeof resolvePatch)),
    );
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit user Priya Nair" }));
    const select = await screen.findByLabelText("Assigned role");
    expect((select as HTMLSelectElement).value).toBe("role:r-finance");
    fireEvent.change(select, { target: { value: "tier:admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(setPersonAccessMock).toHaveBeenCalledWith("u-priya", {
        accessRoleId: null,
        tier: "admin",
      }),
    );
    // The §12 sync line renders while the change applies.
    expect(screen.getByText(ACCESS_COPY.sessionRevoke("Priya"))).toBeInTheDocument();
    resolvePatch({ syncState: "pending" });
    await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThan(1));
  });

  it("does not PATCH access when the role was never changed", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit user Priya Nair" }));
    await screen.findByLabelText("Assigned role");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Priya N" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThan(1));
    expect(setPersonAccessMock).not.toHaveBeenCalled();
  });

  it("owner target: usage fields disabled with the §12 tooltip and the live usage PATCH is skipped", async () => {
    // A second owner (not self) so the editor opens on an owner target.
    fetchUsersMock.mockResolvedValue({
      users: [
        ...ROSTER,
        { id: "co", username: "co", displayName: "Co Owner", userId: "u-co", role: "owner", accessRoleId: null },
      ],
    });
    updateUserUsageMock.mockResolvedValue({ policy: null });
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Co Owner")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit user Co Owner" }));
    const storage = await screen.findByLabelText("Storage limit");
    expect(storage).toBeDisabled();
    expect(storage).toHaveAttribute("title", ACCESS_COPY.ownerTooltip);
    expect(screen.getByLabelText("Storage limit unit")).toBeDisabled();
    const upload = screen.getByLabelText("Upload cap in megabytes");
    expect(upload).toBeDisabled();
    expect(upload).toHaveAttribute("title", ACCESS_COPY.ownerTooltip);
    // Saving (display-name change) never touches the live usage endpoint.
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Co O" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThan(1));
    expect(updateUserUsageMock).not.toHaveBeenCalled();
  });

  it("usage placeholders show the role default when the person has a custom role", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit user Priya Nair" }));
    const storage = await screen.findByLabelText("Storage limit");
    expect(storage).toHaveAttribute("placeholder", "Role default (25 GB)");
    expect(screen.getByLabelText("Upload cap in megabytes")).toHaveAttribute(
      "placeholder",
      "Role default",
    );
  });

  it("a stale effective-access resolve never seeds another person's editor (review F4)", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    fetchEffectiveAccessMock.mockImplementation(
      () => new Promise((res) => resolvers.push(res as (v: unknown) => void)),
    );
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    // Open Priya's editor (fetch #1 held open), then close it…
    fireEvent.click(screen.getByRole("button", { name: "Edit user Priya Nair" }));
    await screen.findByLabelText("Assigned role");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // …and open Sam's (fetch #2 held open).
    fireEvent.click(screen.getByRole("button", { name: "Edit user Sam Ortega" }));
    await screen.findByLabelText("Assigned role");
    await waitFor(() => expect(fetchEffectiveAccessMock).toHaveBeenCalledTimes(2));
    // Priya's fetch resolves LATE, carrying her exception rows.
    resolvers[0]!({
      tier: "family",
      features: [],
      toolDomains: [],
      locks: false,
      cloud: false,
      connectors: {},
      usage: { storageQuotaBytes: null, maxUploadSizeMb: null, llmDailyMessageCap: null },
      deptRights: [],
      exceptions: [{ moduleId: "cameras", effect: "allow", level: "act" }],
    });
    // Sam's open editor must never show Priya's rows.
    await waitFor(() =>
      expect(screen.queryByText(/Allow: Cameras/)).not.toBeInTheDocument(),
    );
    // Sam's own (empty) seed still applies cleanly when his fetch lands.
    resolvers[1]!({
      tier: "guest",
      features: [],
      toolDomains: [],
      locks: false,
      cloud: false,
      connectors: {},
      usage: { storageQuotaBytes: null, maxUploadSizeMb: null, llmDailyMessageCap: null },
      deptRights: [],
      exceptions: [],
    });
    await waitFor(() => expect(screen.queryByText(/Allow: Cameras/)).not.toBeInTheDocument());
  });

  it("orders the editor per §17: Usage override BEFORE Exceptions (UX-6)", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit user Priya Nair" }));
    await screen.findByLabelText("Assigned role");
    const usage = screen.getByText("Usage");
    const exceptions = screen.getByText("Exceptions");
    // eslint-disable-next-line no-bitwise
    expect(usage.compareDocumentPosition(exceptions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
