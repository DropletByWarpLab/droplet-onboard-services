/**
 * WARP-1533 (RBAC v2 T9) — invite modal role picker grows custom roles
 * (design brief §7, Surface D).
 *
 *   - Options group as `Your roles` ABOVE `Built-in`; the built-in group
 *     offers Admin / Staff / Guest only — NEVER Owner or Service.
 *   - Picking a custom role sends `accessRoleId` + the role's startingPoint
 *     as the tier (the identical value scheme the person editor uses).
 *   - Default = the most-restrictive sensible role (built-in Guest), sent
 *     as the CANONICAL enum value (retiring the legacy "user" alias).
 *   - Degraded mode: roles that can't load ⇒ built-in tiers only, with an
 *     honest caption — never a silently absent group.
 *
 * Harness mirrors users.invite.test.tsx (wholesale @/lib/api mock).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";
import type { AccessRole } from "@/lib/types";

const fetchUsersMock = vi.fn();
const createInviteMock = vi.fn();
const listInvitesMock = vi.fn();
const listAccessRolesMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  createInvite: (...a: any[]) => createInviteMock(...a),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: vi.fn(),
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  fetchDevices: vi.fn().mockResolvedValue([]),
  fetchHealth: vi.fn().mockResolvedValue({}),
  // The UX-note N1 guard test drives the edit-dialog save path (the page's
  // one in-session roles-refetch trigger), which touches the usage surface.
  fetchAdminFilesUsage: vi.fn().mockResolvedValue({ users: [], departments: [] }),
  fetchUserUsage: vi.fn().mockResolvedValue({ policy: null, usedBytes: null }),
  updateUserUsage: vi.fn().mockResolvedValue({}),
  listAccessRoles: (...a: any[]) => listAccessRolesMock(...a),
  createAccessRole: vi.fn(),
  updateAccessRole: vi.fn(),
  deleteAccessRole: vi.fn(),
  duplicateAccessRole: vi.fn(),
  archiveAccessRole: vi.fn(),
  assignAccessRole: vi.fn(),
  setPersonAccess: vi.fn().mockResolvedValue({ syncState: "pending" }),
  putAccessExceptions: vi.fn().mockResolvedValue({ exceptions: [] }),
  fetchEffectiveAccess: vi.fn().mockRejectedValue(new Error("not merged yet")),
}))

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "admin", username: "admin", displayName: "Admin", role: "owner" },
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

import UsersPage from "@/app/users/page";

function roleFixture(over: Partial<AccessRole> = {}): AccessRole {
  return {
    id: "ar-fin",
    name: "Finance",
    slug: "finance",
    description: null,
    startingPoint: "family",
    state: "active",
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    createdBy: "u-owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    peopleCount: 0,
    featureGrants: [],
    toolGrants: [],
    connectorGrants: [],
    ...over,
  };
}

const FINANCE = roleFixture();
const OPS = roleFixture({ id: "ar-ops", name: "Ops lead", slug: "ops-lead", startingPoint: "admin" });

async function openInviteModal() {
  render(<UsersPage />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /invite user/i }));
  return screen.getByLabelText(/^role$/i) as HTMLSelectElement;
}

beforeEach(() => {
  fetchUsersMock.mockReset();
  createInviteMock.mockReset();
  listInvitesMock.mockReset();
  listAccessRolesMock.mockReset();
  fetchUsersMock.mockResolvedValue({
    users: [{ id: "alice", username: "alice", displayName: "Alice" }],
  });
  listInvitesMock.mockResolvedValue({ invites: [] });
  listAccessRolesMock.mockResolvedValue({ roles: [FINANCE, OPS] });
});

describe("Users page — invite modal access-role picker (WARP-1533)", () => {
  it("groups custom roles under 'Your roles' above 'Built-in' (Admin / Staff / Guest — never Owner or Service)", async () => {
    const select = await openInviteModal();

    await waitFor(() => {
      expect(within(select).getAllByRole("group")).toHaveLength(2);
    });
    const groups = within(select).getAllByRole("group");
    expect(groups[0]).toHaveAttribute("label", "Your roles");
    expect(groups[1]).toHaveAttribute("label", "Built-in");

    // Custom roles render by name inside the first group.
    expect(within(groups[0]!).getByRole("option", { name: "Finance" })).toBeInTheDocument();
    expect(within(groups[0]!).getByRole("option", { name: "Ops lead" })).toBeInTheDocument();

    // Built-in group: Admin / Staff (the family relabel, §0.1) / Guest.
    expect(within(groups[1]!).getByRole("option", { name: "Admin" })).toBeInTheDocument();
    expect(within(groups[1]!).getByRole("option", { name: "Staff" })).toBeInTheDocument();
    expect(within(groups[1]!).getByRole("option", { name: "Guest" })).toBeInTheDocument();

    // NEVER Owner or Service — anywhere in the picker.
    expect(within(select).queryByRole("option", { name: /owner/i })).toBeNull();
    expect(within(select).queryByRole("option", { name: /service/i })).toBeNull();
  });

  it("sends accessRoleId + the role's tier when a custom role is picked", async () => {
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const select = await openInviteModal();
    await waitFor(() => {
      expect(within(select).queryByRole("option", { name: "Finance" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "reception@acme.co" },
    });
    fireEvent.change(select, { target: { value: `role:${FINANCE.id}` } });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => expect(createInviteMock).toHaveBeenCalledTimes(1));
    const callArg = createInviteMock.mock.calls[0][0];
    expect(callArg.role).toBe("family"); // Finance is family-based
    expect(callArg.accessRoleId).toBe(FINANCE.id);
  });

  it("defaults to the most-restrictive sensible role (Guest) and sends the canonical value", async () => {
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const select = await openInviteModal();
    expect(select.value).toBe("tier:guest");

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "visitor@acme.co" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => expect(createInviteMock).toHaveBeenCalledTimes(1));
    const callArg = createInviteMock.mock.calls[0][0];
    expect(callArg.role).toBe("guest"); // canonical enum value, not the legacy "user"
    expect(callArg.accessRoleId).toBeUndefined();
  });

  it("degrades to built-in tiers with an honest caption when roles can't load", async () => {
    listAccessRolesMock.mockRejectedValue(new Error("orchestrator unreachable"));

    const select = await openInviteModal();

    // Built-in group only — no fabricated "Your roles" group.
    expect(within(select).getAllByRole("group")).toHaveLength(1);
    expect(within(select).getAllByRole("group")[0]).toHaveAttribute("label", "Built-in");
    expect(within(select).getByRole("option", { name: "Staff" })).toBeInTheDocument();

    // The honest caption names the degradation — the admin is told, not
    // left to wonder where their roles went.
    expect(
      screen.getByText(/couldn't load your custom roles/i),
    ).toBeInTheDocument();

    // Inviting still works on a built-in tier.
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "staffer@acme.co" },
    });
    fireEvent.change(select, { target: { value: "tier:family" } });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );
    await waitFor(() => expect(createInviteMock).toHaveBeenCalledTimes(1));
    expect(createInviteMock.mock.calls[0][0].role).toBe("family");
    expect(createInviteMock.mock.calls[0][0].accessRoleId).toBeUndefined();
  });

  it("does not show the degraded caption when roles load fine", async () => {
    await openInviteModal();
    await waitFor(() => {
      expect(screen.queryByText(/couldn't load your custom roles/i)).toBeNull();
    });
  });

  it("resets a stale custom-role selection to Guest when the roles refetch fails (UX note N1)", async () => {
    // First read succeeds (the admin can pick a custom role); the refetch
    // after an access-changing save fails. Without the guard, the picker
    // would keep a role:<id> value whose option no longer exists — a blank
    // select under the degraded caption, and a submit that walks into the
    // server's ROLE_TIER_MISMATCH 400.
    listAccessRolesMock.mockReset();
    listAccessRolesMock
      .mockResolvedValueOnce({ roles: [FINANCE] })
      .mockRejectedValueOnce(new Error("orchestrator restarting"));
    // The refetch trigger is the person editor's access-changing save
    // (page.tsx: `if (accessChanged) reloadAccessRoles()`), so Alice needs
    // the local-row fields the access section keys on.
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "alice", username: "alice", displayName: "Alice", userId: "u-alice", role: "family" },
      ],
    });
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const select = await openInviteModal();
    await waitFor(() => {
      expect(within(select).queryByRole("option", { name: "Finance" })).toBeInTheDocument();
    });
    fireEvent.change(select, { target: { value: `role:${FINANCE.id}` } });
    expect(select.value).toBe(`role:${FINANCE.id}`);

    // Drive the real refetch path: open the person editor (jsdom has no
    // hit-testing, so the overlay doesn't block the row button), change the
    // assigned role, save. The save path awaits two 700ms sync beats.
    fireEvent.click(screen.getByRole("button", { name: /edit user alice/i }));
    const editDialog = await screen.findByRole("dialog", { name: /edit alice/i });
    fireEvent.change(within(editDialog).getByLabelText("Assigned role"), {
      target: { value: "tier:guest" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(listAccessRolesMock).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });

    // The guard: selection falls back to the default (Guest), the degraded
    // caption renders, and the picker shows built-ins only.
    await waitFor(() => {
      expect(select.value).toBe("tier:guest");
    });
    expect(screen.getByText(/couldn't load your custom roles/i)).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "Finance" })).toBeNull();

    // A submit now sends the plain tier — never the vanished role id.
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "reception@acme.co" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );
    await waitFor(() => expect(createInviteMock).toHaveBeenCalledTimes(1));
    expect(createInviteMock.mock.calls[0][0].role).toBe("guest");
    expect(createInviteMock.mock.calls[0][0].accessRoleId).toBeUndefined();
  }, 15000);

  it("resets a selection whose role was ARCHIVED mid-session (review F3 — success branch)", async () => {
    // Same bug class as N1, opposite branch: the refetch SUCCEEDS but the
    // selected role is now archived, so it's filtered out of `accessRoles`
    // and its <option> disappears while state still holds role:<id>. The
    // native select then displays the first option (Admin!) while a submit
    // sends the archived id — a ROLE_TIER_MISMATCH 400 the operator can't
    // explain, having just seen "Admin" in the box.
    listAccessRolesMock.mockReset();
    listAccessRolesMock
      .mockResolvedValueOnce({ roles: [FINANCE] })
      .mockResolvedValueOnce({ roles: [{ ...FINANCE, state: "archived" }] });
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "alice", username: "alice", displayName: "Alice", userId: "u-alice", role: "family" },
      ],
    });
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const select = await openInviteModal();
    await waitFor(() => {
      expect(within(select).queryByRole("option", { name: "Finance" })).toBeInTheDocument();
    });
    fireEvent.change(select, { target: { value: `role:${FINANCE.id}` } });
    expect(select.value).toBe(`role:${FINANCE.id}`);

    // Same real refetch trigger as N1: a person-access save.
    fireEvent.click(screen.getByRole("button", { name: /edit user alice/i }));
    const editDialog = await screen.findByRole("dialog", { name: /edit alice/i });
    fireEvent.change(within(editDialog).getByLabelText("Assigned role"), {
      target: { value: "tier:guest" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(listAccessRolesMock).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });

    // The guard: the vanished selection falls back to the default.
    await waitFor(() => {
      expect(select.value).toBe("tier:guest");
    });
    expect(within(select).queryByRole("option", { name: "Finance" })).toBeNull();
    // The read SUCCEEDED, so this is NOT the degraded state — no caption.
    expect(screen.queryByText(/couldn't load your custom roles/i)).toBeNull();

    // Submit sends the plain tier, never the archived role id.
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "reception@acme.co" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );
    await waitFor(() => expect(createInviteMock).toHaveBeenCalledTimes(1));
    expect(createInviteMock.mock.calls[0][0].role).toBe("guest");
    expect(createInviteMock.mock.calls[0][0].accessRoleId).toBeUndefined();
  }, 15000);

  it("keeps a still-valid custom-role selection across a successful refetch (no over-reset)", async () => {
    // The guard must reconcile ONLY vanished selections — a role that
    // survives the refetch keeps the admin's pick.
    listAccessRolesMock.mockReset();
    listAccessRolesMock
      .mockResolvedValueOnce({ roles: [FINANCE, OPS] })
      .mockResolvedValueOnce({ roles: [FINANCE, OPS] });
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "alice", username: "alice", displayName: "Alice", userId: "u-alice", role: "family" },
      ],
    });

    const select = await openInviteModal();
    await waitFor(() => {
      expect(within(select).queryByRole("option", { name: "Finance" })).toBeInTheDocument();
    });
    fireEvent.change(select, { target: { value: `role:${FINANCE.id}` } });

    fireEvent.click(screen.getByRole("button", { name: /edit user alice/i }));
    const editDialog = await screen.findByRole("dialog", { name: /edit alice/i });
    fireEvent.change(within(editDialog).getByLabelText("Assigned role"), {
      target: { value: "tier:guest" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(listAccessRolesMock).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    expect(select.value).toBe(`role:${FINANCE.id}`);
  }, 15000);
});

/**
 * WARP-1566 — the pending-invites row must name the role the invitee will
 * actually land in.
 *
 * The invite modal has been able to GRANT a custom role since T9. The list
 * below it was still rendering
 *
 *     {i.role === "admin" ? "admin" : "user"}
 *
 * — a ternary written against the legacy `InviteRole = "user" | "admin"`
 * type, which was never what the server sent: `UserInvite.role` is the
 * Prisma `Role` enum. So every non-admin invite read "user" regardless of
 * whether it was Staff, Guest, or a custom Finance role, and the one screen
 * that exists to review pending grants could not review them.
 *
 * The row now resolves the same way the roster does (`roleLabelFor`):
 * custom-role name when one is assigned and the catalog has it, else the
 * built-in tier label.
 */
describe("Users page — pending-invite role label (WARP-1566)", () => {
  function pendingInvite(over: Record<string, unknown> = {}) {
    return {
      token: "z".repeat(43),
      username: "diana",
      displayName: "Diana",
      email: null,
      role: "family",
      accessRoleId: null,
      createdBy: "admin",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      ...over,
    };
  }

  /** The pending-invite row's secondary line ("<username> · <role> · invited by …"). */
  async function inviteSubline(): Promise<string> {
    render(<UsersPage />);
    const name = await screen.findByText("Diana");
    const sub = name.parentElement?.querySelector(".sub");
    expect(sub).not.toBeNull();
    return sub!.textContent ?? "";
  }

  it("names the custom role when the invite carries one", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [pendingInvite({ role: "family", accessRoleId: FINANCE.id })],
    });

    const text = await inviteSubline();
    expect(text).toContain("Finance");
    expect(text).not.toMatch(/\buser\b/);
  });

  it("shows the built-in tier label for a plain-tier invite — never the legacy 'user'", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [pendingInvite({ role: "family", accessRoleId: null })],
    });

    const text = await inviteSubline();
    // `family` displays as "Staff" (§0.1) — the same relabel the roster uses.
    expect(text).toContain("Staff");
    expect(text).not.toMatch(/\buser\b/);
  });

  it("distinguishes guest from staff — the legacy ternary collapsed both to 'user'", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [pendingInvite({ role: "guest", accessRoleId: null })],
    });

    const text = await inviteSubline();
    expect(text).toContain("Guest");
    expect(text).not.toContain("Staff");
  });

  it("falls back to the tier label when the role catalog does not have the id", async () => {
    // Degraded, not fabricated: the roles read can fail (the page already
    // tracks that separately) or the role can have been deleted. Rendering
    // a raw UUID at the operator would be worse than the honest tier.
    listInvitesMock.mockResolvedValue({
      invites: [pendingInvite({ role: "admin", accessRoleId: "ar-vanished" })],
    });

    const text = await inviteSubline();
    expect(text).toContain("Admin");
    expect(text).not.toContain("ar-vanished");
  });
});
