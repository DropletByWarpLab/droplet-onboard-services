/**
 * WARP-1271 (T19a) — per-user usage settings on the People (/users) page.
 *
 * Covers the Edit dialog's Usage section (storage limit + upload cap +
 * read-only used meter) and the roster's "used / limit" column. Harness
 * mirrors users.local-account.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const listInvitesMock = vi.fn();
const fetchUserUsageMock = vi.fn();
const updateUserUsageMock = vi.fn();
const updateUserMock = vi.fn();
const fetchAdminFilesUsageMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: (...a: any[]) => updateUserMock(...a),
  setUserEnabled: vi.fn(),
  createInvite: vi.fn(),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: vi.fn(),
  fetchUserUsage: (...a: any[]) => fetchUserUsageMock(...a),
  updateUserUsage: (...a: any[]) => updateUserUsageMock(...a),
  fetchAdminFilesUsage: (...a: any[]) => fetchAdminFilesUsageMock(...a),
  // WARP-1341: the invite modal's department section fetches on mount
  // (admin-gated). Empty here — this file exercises the usage settings.
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  // ShellPage status chip pulls device + health hooks — keep them callable.
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

// WARP-1341: business-only build — useWorkspace() is a static context.
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: "business",
    isBusiness: true,
  }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="invite-qr" data-value={value} />,
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import UsersPage from "@/app/users/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  listInvitesMock.mockReset();
  fetchUserUsageMock.mockReset();
  updateUserUsageMock.mockReset();
  updateUserMock.mockReset();
  fetchAdminFilesUsageMock.mockReset();

  fetchUsersMock.mockResolvedValue({
    users: [
      { id: "alice", userId: "u1", username: "alice", displayName: "Alice" },
    ],
  });
  listInvitesMock.mockResolvedValue({ invites: [] });
  fetchAdminFilesUsageMock.mockResolvedValue({
    users: [{ userId: "u1", displayName: "Alice", quota: "5000000000", used: "4200000000", free: "800000000" }],
    departments: [],
  });
  fetchUserUsageMock.mockResolvedValue({
    policy: null,
    usedBytes: "4200000000",
  });
  updateUserUsageMock.mockResolvedValue({
    policy: {
      userId: "u1",
      storageQuotaBytes: "5000000000",
      quotaSyncState: "synced",
      maxUploadSizeMb: null,
      updatedBy: "admin-uuid",
      updatedAt: new Date().toISOString(),
    },
  });
});

async function openEditDialog() {
  render(<UsersPage />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /edit user alice/i })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /edit user alice/i }));
  return screen.getByRole("dialog");
}

describe("Users page — roster used/limit column (WARP-1271)", () => {
  it("shows a mono used/limit column sourced from the admin usage roster", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(fetchAdminFilesUsageMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/3\.9 GB \/ 4\.7 GB/)).toBeInTheDocument();
    });
  });

  it("degrades quietly (no column) when the usage-roster fetch fails", async () => {
    fetchAdminFilesUsageMock.mockRejectedValueOnce(new Error("nc down"));
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /edit user alice/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/ \/ /)).toBeNull();
  });
});

describe("Users page — Edit dialog Usage section (WARP-1271)", () => {
  it("loads the current policy + used-bytes on open", async () => {
    fetchUserUsageMock.mockResolvedValueOnce({
      policy: {
        userId: "u1",
        storageQuotaBytes: String(2 * 1024 ** 3), // 2 GB
        quotaSyncState: "synced",
        maxUploadSizeMb: 250,
        updatedBy: "admin-uuid",
        updatedAt: new Date().toISOString(),
      },
      usedBytes: "4200000000",
    });
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalledWith("u1"));

    const storageInput = within(dialog).getByLabelText(/storage limit$/i) as HTMLInputElement;
    await waitFor(() => expect(storageInput.value).toBe("2"));
    const uploadInput = within(dialog).getByLabelText(/upload cap in megabytes/i) as HTMLInputElement;
    expect(uploadInput.value).toBe("250");
    expect(dialog.textContent).toMatch(/used/i);
  });

  it("empty storage value means No limit (placeholder), never a fabricated 0", async () => {
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalled());
    const storageInput = within(dialog).getByLabelText(/storage limit$/i) as HTMLInputElement;
    expect(storageInput.value).toBe("");
    expect(storageInput.placeholder).toMatch(/no limit/i);
  });

  it("saving a storage value + unit sends the correct byte string", async () => {
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalled());

    fireEvent.change(within(dialog).getByLabelText(/storage limit$/i), {
      target: { value: "5" },
    });
    fireEvent.change(within(dialog).getByLabelText(/storage limit unit/i), {
      target: { value: "GB" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updateUserUsageMock).toHaveBeenCalledTimes(1));
    expect(updateUserUsageMock).toHaveBeenCalledWith("u1", {
      storageQuotaBytes: String(5 * 1024 ** 3),
      maxUploadSizeMb: null,
    });
  });

  it("clearing the storage field back to empty sends storageQuotaBytes: null (explicit no-limit)", async () => {
    fetchUserUsageMock.mockResolvedValueOnce({
      policy: {
        userId: "u1",
        storageQuotaBytes: String(2 * 1024 ** 3),
        quotaSyncState: "synced",
        maxUploadSizeMb: null,
        updatedBy: "admin-uuid",
        updatedAt: new Date().toISOString(),
      },
      usedBytes: null,
    });
    const dialog = await openEditDialog();
    const storageInput = within(dialog).getByLabelText(/storage limit$/i) as HTMLInputElement;
    await waitFor(() => expect(storageInput.value).toBe("2"));

    fireEvent.change(storageInput, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updateUserUsageMock).toHaveBeenCalledTimes(1));
    expect(updateUserUsageMock).toHaveBeenCalledWith("u1", {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
    });
  });

  it("shows an em dash when used bytes is unknown (never fabricates 0)", async () => {
    fetchUserUsageMock.mockResolvedValueOnce({ policy: null, usedBytes: null });
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalled());
    expect(dialog.textContent).toMatch(/— used/);
  });

  it("shows the sync-state transition (Applying to storage… -> Applied) after save", async () => {
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalled());

    fireEvent.change(within(dialog).getByLabelText(/storage limit$/i), {
      target: { value: "5" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(within(dialog).getByText("Applying to storage…")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Applied")).toBeInTheDocument();
    });
  });

  it("rejects a non-positive upload cap without saving", async () => {
    const dialog = await openEditDialog();
    await waitFor(() => expect(fetchUserUsageMock).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText(/upload cap in megabytes/i), {
      target: { value: "0" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/positive whole number/i)).toBeInTheDocument();
    });
    expect(updateUserUsageMock).not.toHaveBeenCalled();
  });
});
