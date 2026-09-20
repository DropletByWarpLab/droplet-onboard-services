/**
 * WARP-1042 — "Create local account" on the People (/users) page.
 *
 * Surfaces the WARP-824 temp-password machinery beside "Invite user": the
 * dialog collects display name + login email + role, auto-generates a
 * policy-compliant temporary password (typed override allowed), hard-wires
 * mustChangePassword=true (no opt-out in THIS dialog), and on success flips
 * to a handoff phase telling the admin to give the person the email +
 * temporary password.
 *
 * Harness mirrors users.invite.test.tsx; the double-submit guard mirrors
 * settings.create-user-double-submit.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";
import { validatePassword } from "@droplet/auth-policy";

const fetchUsersMock = vi.fn();
const createInviteMock = vi.fn();
const listInvitesMock = vi.fn();
const createUserMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: (...a: any[]) => createUserMock(...a),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  createInvite: (...a: any[]) => createInviteMock(...a),
  listInvites: (...a: any[]) => listInvitesMock(...a),
  revokeInvite: vi.fn(),
  // WARP-1341: the invite modal's department section fetches on mount
  // (admin-gated). Empty here — this file exercises the create-account flow.
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
    user: {
      id: "admin",
      username: "admin",
      displayName: "Admin",
      role: "owner",
    },
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
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="invite-qr" data-value={value} />
  ),
}));

// The create dialog mounts on the canonical <Dialog> primitive (WARP-289),
// which animates via framer-motion. Stub `useReducedMotion` to true so
// mount/unmount is synchronous and assertions aren't gated on animation
// timing (same pattern as Dialog.test.tsx / ConfirmDialog.test.tsx).
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => true,
  };
});

import UsersPage from "@/app/users/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  createInviteMock.mockReset();
  listInvitesMock.mockReset();
  createUserMock.mockReset();
  fetchUsersMock.mockResolvedValue({
    users: [{ id: "alice", username: "alice", displayName: "Alice" }],
  });
  listInvitesMock.mockResolvedValue({ invites: [] });
  createUserMock.mockResolvedValue(undefined);
});

async function openCreateDialog() {
  render(<UsersPage />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /create local account/i }),
    ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /create local account/i }));
  return screen.getByRole("dialog");
}

describe("Users page — create local account (WARP-1042)", () => {
  it("renders a Create local account action beside Invite user", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /create local account/i }),
    ).toBeInTheDocument();
  });

  it("auto-generates a policy-compliant temporary password on open", async () => {
    const dialog = await openCreateDialog();
    const pw = within(dialog).getByLabelText(/temporary password/i) as HTMLInputElement;
    expect(pw.value.length).toBeGreaterThan(0);
    expect(validatePassword(pw.value).ok).toBe(true);
  });

  it("regenerate replaces the password with a fresh, still-compliant one", async () => {
    const dialog = await openCreateDialog();
    const pw = within(dialog).getByLabelText(/temporary password/i) as HTMLInputElement;
    const first = pw.value;
    fireEvent.click(within(dialog).getByRole("button", { name: /regenerate/i }));
    expect(pw.value).not.toBe(first);
    expect(validatePassword(pw.value).ok).toBe(true);
  });

  it("explains the login email doesn't need to receive mail", async () => {
    const dialog = await openCreateDialog();
    expect(dialog.textContent).toMatch(/used to sign in/i);
    expect(dialog.textContent).toMatch(/doesn't need to receive mail/i);
  });

  it("rejects an invalid email without calling createUser", async () => {
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(within(dialog).getByText(/valid email/i)).toBeInTheDocument();
    });
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("rejects a typed-override password that fails the policy", async () => {
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.change(within(dialog).getByLabelText(/temporary password/i), {
      target: { value: "weak" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(within(dialog).getByText(/requirements/i)).toBeInTheDocument();
    });
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("creates the account with the selected role and hard-wired mustChangePassword=true, then shows the handoff", async () => {
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/display name/i), {
      target: { value: "Bob" },
    });
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.change(within(dialog).getByLabelText(/role/i), {
      target: { value: "admin" },
    });
    const pw = within(dialog).getByLabelText(/temporary password/i) as HTMLInputElement;
    const password = pw.value;

    // No mustChangePassword opt-out anywhere in this dialog — the forced
    // first-login change is hard-wired.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock).toHaveBeenCalledWith(
      "bob@example.com",
      password,
      "Bob",
      true,
      "admin",
    );

    // Handoff phase: give them the email + temporary password.
    await waitFor(() => {
      expect(
        screen.getByText(/give them this email and temporary password/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/choose their own the first time they sign in/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("bob@example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue(password)).toBeInTheDocument();
  });

  it("sends the canonical family role by default, not the legacy user value", async () => {
    // Review finding (WARP-1042): the server's "user"→"family" preprocess is
    // a one-deploy-window compat shim for OLD dashboard builds — brand-new
    // code must speak the canonical Role vocabulary so the shim can retire.
    const dialog = await openCreateDialog();
    const roleSelect = within(dialog).getByLabelText(/role/i) as HTMLSelectElement;
    expect(roleSelect.value).toBe("family");

    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "kid@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock.mock.calls[0]![4]).toBe("family");
  });

  it("cannot be dismissed while the create request is in flight — the show-once handoff still appears", async () => {
    // Review finding (WARP-1042): closing mid-flight would let the server
    // mint the account while the 0-tick reset wipes the show-once temp
    // password, so the admin never sees the credentials. Escape, backdrop,
    // and the Cancel/X buttons must all be inert while submitting.
    let resolveCreate!: () => void;
    createUserMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveCreate = resolve)),
    );

    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    const pw = within(dialog).getByLabelText(/temporary password/i) as HTMLInputElement;
    const password = pw.value;
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));

    // Escape — dialog must stay.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Backdrop click — dialog must stay.
    fireEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Explicit Cancel — dialog must stay.
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Request completes → handoff phase with the intact temp password.
    resolveCreate();
    await waitFor(() => {
      expect(
        screen.getByText(/give them this email and temporary password/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(password)).toBeInTheDocument();
  });

  it("calls createUser only once when Create account is clicked twice rapidly", async () => {
    // A request that stays in flight for the whole test window, so the
    // guard is what (and only what) prevents the second submission.
    createUserMock.mockImplementation(() => new Promise<void>(() => {}));

    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    const createBtn = within(dialog).getByRole("button", { name: /create account/i });
    fireEvent.click(createBtn);
    fireEvent.click(createBtn);

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1));
    expect(createUserMock).toHaveBeenCalledTimes(1);
  });

  it("disables Create account while the request is in flight", async () => {
    createUserMock.mockImplementation(() => new Promise<void>(() => {}));

    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    const createBtn = within(dialog).getByRole("button", { name: /create account/i });
    fireEvent.click(createBtn);

    await waitFor(() => expect(createBtn).toBeDisabled());
  });

  it("surfaces a server error (e.g. EMAIL_TAKEN 409) inside the dialog and stays on the form", async () => {
    createUserMock.mockRejectedValueOnce(
      Object.assign(new Error("A user with this email already exists"), {
        code: "EMAIL_TAKEN",
      }),
    );

    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "taken@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(
        within(dialog).getByText(/already exists/i),
      ).toBeInTheDocument();
    });
    // Still on the form (no handoff copy), and recoverable.
    expect(
      screen.queryByText(/give them this email and temporary password/i),
    ).not.toBeInTheDocument();
  });

  // ── UX review round (WARP-1042): keyboard + contrast blockers ──

  it("moves focus to the temporary password when the dialog flips to the handoff phase", async () => {
    // Blocker: the form→handoff flip unmounts the focused "Create account"
    // button; without an explicit focus move a keyboard/screen-reader user
    // is dropped onto document.body outside the aria-modal dialog.
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    const password = (
      within(dialog).getByLabelText(/temporary password/i) as HTMLInputElement
    ).value;
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/give them this email and temporary password/i),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByDisplayValue(password));
    });
  });

  it("keeps Tab cycling inside the dialog (focus trap) and locks body scroll", async () => {
    const dialog = await openCreateDialog();
    expect(document.body.style.overflow).toBe("hidden");

    // Tab from the LAST focusable (Create account) must wrap to the FIRST
    // (the X close button), not escape into the background page.
    const createBtn = within(dialog).getByRole("button", { name: /create account/i });
    createBtn.focus();
    fireEvent.keyDown(createBtn, { key: "Tab" });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: /close dialog/i }),
    );

    // Shift-Tab from the first focusable wraps back to the last.
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(createBtn);
  });

  it("ignores backdrop clicks during the handoff phase so a stray click can't drop the show-once password", async () => {
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/give them this email and temporary password/i),
      ).toBeInTheDocument();
    });

    const handoffDialog = screen.getByRole("dialog");
    fireEvent.click(handoffDialog.parentElement!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Explicit dismissal (Done) still works.
    fireEvent.click(within(handoffDialog).getByRole("button", { name: /done/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("renders the show-once warning and helper copy at secondary label emphasis (WCAG 1.4.3)", async () => {
    // Blocker: text-label-tertiary is ~1.74:1 on white at caption size —
    // load-bearing copy (the show-once warning + the two new helpers) must
    // use text-label-secondary (~5.9:1).
    const dialog = await openCreateDialog();

    const emailHelper = within(dialog).getByText(/doesn't need to receive mail/i);
    expect(emailHelper.className).toContain("text-label-secondary");
    expect(emailHelper.className).not.toContain("text-label-tertiary");

    const pwHelper = within(dialog).getByText(/auto-generated to meet the password rules/i);
    expect(pwHelper.className).toContain("text-label-secondary");
    expect(pwHelper.className).not.toContain("text-label-tertiary");

    fireEvent.change(within(dialog).getByLabelText(/login email/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));
    await waitFor(() => {
      expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
    });
    const warning = screen.getByText(/won't be shown again/i);
    expect(warning.className).toContain("text-label-secondary");
    expect(warning.className).not.toContain("text-label-tertiary");
  });

  it("dialog has aria-modal semantics and Escape closes it", async () => {
    const dialog = await openCreateDialog();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledById = dialog.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();
    expect(document.getElementById(labelledById!)?.textContent).toMatch(
      /create local account/i,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
