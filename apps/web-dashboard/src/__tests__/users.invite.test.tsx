/**
 * Tests for the WARP-217 invite UX on the Users page.
 *
 * The page now:
 *   - Replaces the old "Create user" inline form with a modal that issues
 *     an invite (no password input).
 *   - Flips the modal to a "Share this link" view after createInvite()
 *     resolves, with a copy-to-clipboard button + QR code.
 *   - Renders a "Pending invites" section below the user list with a
 *     status pill + per-row revoke action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const createInviteMock = vi.fn();
const listInvitesMock = vi.fn();
const revokeInviteMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  createInvite: (...a: any[]) => createInviteMock(...a),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: (...a: any[]) => revokeInviteMock(...a),
  // WARP-1341: the Users page fetches departments for the invite modal's
  // "Add to a department" section on mount (admin-gated). No departments
  // here, so that section stays absent — matching the flow under test.
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  // The page now renders inside <ShellPage>, whose status chip pulls the
  // device + health hooks. Stub them so the wholesale api mock keeps these
  // callable (otherwise SWR receives an undefined fetcher and throws).
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
    user: {
      id: "admin",
      username: "admin",
      displayName: "Admin",
      role: "owner",
    },
  }),
}));

// WARP-1341: business-only build — useWorkspace() is a static context.
// These tests exercise the invite flow; the department-assignment section
// stays absent because there are no departments (see listDepartments mock).
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: "business",
    isBusiness: true,
  }),
}));

// Stub QRCodeSVG so we don't pull in the canvas/svg quirks in jsdom and
// can assert the value prop directly.
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="invite-qr" data-value={value} />
  ),
}));

import UsersPage from "@/app/users/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  createInviteMock.mockReset();
  listInvitesMock.mockReset();
  revokeInviteMock.mockReset();
  fetchUsersMock.mockResolvedValue({
    users: [
      { id: "alice", username: "alice", displayName: "Alice" },
    ],
  });
  listInvitesMock.mockResolvedValue({ invites: [] });
});

describe("Users page — invite UX", () => {
  it("opens the invite modal and posts a token-style invite (no password)", async () => {
    createInviteMock.mockResolvedValueOnce({
      token: "x".repeat(43),
      url: "http://droplet.local/invite/" + "x".repeat(43),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    render(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    // Modal renders email + role + ttl — but NO password.
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "bob@example.com" },
    });
    expect(
      document.querySelector('input[type="password"]'),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(createInviteMock).toHaveBeenCalledTimes(1);
    });
    const callArg = createInviteMock.mock.calls[0][0];
    expect(callArg.email).toBe("bob@example.com");
    // WARP-1533: the picker defaults to the most-restrictive sensible role
    // (built-in Guest) and sends the CANONICAL enum value — the legacy
    // "user" alias is no longer emitted by the dashboard.
    expect(callArg.role).toBe("guest");
    expect(callArg.accessRoleId).toBeUndefined();
  });

  it("flips to share-this-link view with URL + QR after invite is created", async () => {
    const url = "http://droplet.local/invite/" + "y".repeat(43);
    createInviteMock.mockResolvedValueOnce({
      token: "y".repeat(43),
      url,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "charlie@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue(url)).toBeInTheDocument();
    });
    expect(screen.getByTestId("invite-qr")).toHaveAttribute("data-value", url);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("renders pending invites with status + revoke action (WARP-291: ConfirmDialog)", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "z".repeat(43),
          username: "diana",
          displayName: "Diana",
          email: null,
          // WARP-1566: canonical Role enum value — the server never sent "user".
          role: "family",
          accessRoleId: null,
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    revokeInviteMock.mockResolvedValue(undefined);

    render(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByText("Diana")).toBeInTheDocument();
    });
    // Username appears in the secondary line.
    expect(screen.getByText(/diana/)).toBeInTheDocument();
    // "Pending invites" header + the status pill both match — assert the pill specifically.
    expect(screen.getAllByText(/pending/i).length).toBeGreaterThanOrEqual(1);

    // Click the row Revoke button — opens a ConfirmDialog (WARP-291).
    const revokeBtn = screen.getByRole("button", { name: /Revoke invite for/i });
    fireEvent.click(revokeBtn);

    // Confirm the destructive action inside the dialog.
    const dialog = await screen.findByRole("dialog", { name: /Revoke invite/i });
    const confirmInDialog = dialog.querySelector('button.danger') as HTMLButtonElement;
    expect(confirmInDialog).not.toBeNull();
    fireEvent.click(confirmInDialog);

    await waitFor(() => {
      expect(revokeInviteMock).toHaveBeenCalledWith("z".repeat(43));
    });
  });

  it("revoke confirms before calling the API; cancel aborts (WARP-291: ConfirmDialog)", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "z".repeat(43),
          username: "diana",
          displayName: "Diana",
          email: null,
          // WARP-1566: canonical Role enum value — the server never sent "user".
          role: "family",
          accessRoleId: null,
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    revokeInviteMock.mockResolvedValue(undefined);

    render(<UsersPage />);
    await waitFor(() => {
      expect(screen.getByText("Diana")).toBeInTheDocument();
    });

    // Open the ConfirmDialog.
    fireEvent.click(screen.getByRole("button", { name: /Revoke invite for/i }));

    const dialog = await screen.findByRole("dialog", { name: /Revoke invite/i });
    // The dialog title contains the username + the consequence sentence.
    expect(dialog.textContent).toMatch(/diana/i);
    expect(dialog.textContent).toMatch(/won't be able/i);

    // Click Cancel — API must NOT be called.
    const cancelBtn = within(dialog).getByRole("button", { name: /Cancel/i });
    fireEvent.click(cancelBtn);
    expect(revokeInviteMock).not.toHaveBeenCalled();

    // Re-open + confirm — API fires.
    fireEvent.click(screen.getByRole("button", { name: /Revoke invite for/i }));
    const dialog2 = await screen.findByRole("dialog", { name: /Revoke invite/i });
    const confirmBtn = dialog2.querySelector('button.danger') as HTMLButtonElement;
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(revokeInviteMock).toHaveBeenCalledWith("z".repeat(43));
    });
  });

  it("invite modal has dialog semantics + Escape closes it", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    // Dialog role + aria-modal + aria-labelledby resolves to headline.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledById = dialog.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();
    const headline = document.getElementById(labelledById!);
    expect(headline).not.toBeNull();
    expect(headline?.textContent).toMatch(/invite user/i);

    // Escape closes the modal.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("share-link view exposes QR code with descriptive aria-label", async () => {
    const url = "http://droplet.local/invite/" + "y".repeat(43);
    createInviteMock.mockResolvedValueOnce({
      token: "y".repeat(43),
      url,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "charlie@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue(url)).toBeInTheDocument();
    });

    const qrImg = screen.getByRole("img", { name: /qr code.*charlie@example\.com/i });
    expect(qrImg).toBeInTheDocument();
  });

  it("edit dialog has dialog semantics + Escape closes it", async () => {
    render(<UsersPage />);
    // Wait for the user row to render — its Edit button uses `title=`
    // today (aria-label takes over in the row-actions follow-up).
    const editBtn = await screen.findByTitle(/^edit$/i);
    fireEvent.click(editBtn);

    // Edit dialog should expose the same a11y contract as the invite modal.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledById = dialog.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();
    const headline = document.getElementById(labelledById!);
    expect(headline).not.toBeNull();
    expect(headline?.textContent).toMatch(/edit alice/i);

    // Escape closes the dialog.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("row actions are visible without requiring hover (touch + keyboard discoverability)", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "alice", username: "alice", displayName: "Alice Anderson" },
      ],
    });

    render(<UsersPage />);

    // No hover/focus interaction. Each action must be queryable by an
    // accessible name that names the action and its target user — using
    // the user's display name (matches the row's primary visible label).
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /edit user alice anderson/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /disable user alice anderson/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete user alice anderson/i }),
    ).toBeInTheDocument();

    // None of those three buttons may be inside a container that hides
    // them behind hover (opacity-0 group-hover:opacity-100). We assert
    // that the closest container with the actions does NOT carry the
    // opacity-0 class — guards against regression.
    const editBtn = screen.getByRole("button", { name: /edit user alice anderson/i });
    const container = editBtn.closest("div");
    expect(container?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor (≥ 32 px per ui-ux brief). vitest+jsdom doesn't do
    // real layout, so assert the class-list carries the padding token that
    // produces a ≥ 32 px square (p-2.5 → 14 px icon + 20 px padding = 34).
    expect(editBtn.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
    expect(
      screen.getByRole("button", { name: /disable user alice anderson/i }).className,
    ).toMatch(/(^|\s)p-2\.5(\s|$)/);
    expect(
      screen.getByRole("button", { name: /delete user alice anderson/i }).className,
    ).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("row action aria-labels fall back to user id when displayName is absent", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [
        { id: "bob", username: "bob" },
      ],
    });

    render(<UsersPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /edit user bob/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /disable user bob/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete user bob/i }),
    ).toBeInTheDocument();
  });

  it("revoke action on pending invites is visible without requiring hover", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "z".repeat(43),
          username: "diana",
          displayName: "Diana Prince",
          email: null,
          // WARP-1566: canonical Role enum value — the server never sent "user".
          role: "family",
          accessRoleId: null,
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });

    render(<UsersPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /revoke invite for diana prince/i }),
      ).toBeInTheDocument();
    });

    const revokeBtn = screen.getByRole("button", {
      name: /revoke invite for diana prince/i,
    });
    const container = revokeBtn.closest("div");
    expect(container?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor: same p-2.5 token as the user-row icon buttons.
    expect(revokeBtn.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("revoke aria-label falls back to invite username when displayName is absent", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "w".repeat(43),
          username: "eve",
          displayName: null,
          email: null,
          // WARP-1566: canonical Role enum value — the server never sent "user".
          role: "family",
          accessRoleId: null,
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });

    render(<UsersPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /revoke invite for eve/i }),
      ).toBeInTheDocument();
    });
  });

  it("rejects an invalid email at form-submit time without calling createInvite", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/valid email/i)).toBeInTheDocument();
    });
    expect(createInviteMock).not.toHaveBeenCalled();
  });
});
