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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

    // Modal renders username + role + ttl — but NO password.
    fireEvent.change(screen.getByPlaceholderText(/username/i), {
      target: { value: "bob" },
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
    expect(callArg.username).toBe("bob");
    expect(callArg.role).toBe("user");
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

    fireEvent.change(screen.getByPlaceholderText(/username/i), {
      target: { value: "charlie" },
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

  it("renders pending invites with status + revoke action", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "z".repeat(43),
          username: "diana",
          displayName: "Diana",
          email: null,
          role: "user",
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    revokeInviteMock.mockResolvedValue(undefined);
    // Revoke is destructive — the page now confirms first; auto-accept here.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByText("Diana")).toBeInTheDocument();
    });
    // Username appears in the secondary line.
    expect(screen.getByText(/diana/)).toBeInTheDocument();
    // "Pending invites" header + the status pill both match — assert the pill specifically.
    expect(screen.getAllByText(/pending/i).length).toBeGreaterThanOrEqual(1);

    const revokeBtn = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      expect(revokeInviteMock).toHaveBeenCalledWith("z".repeat(43));
    });
    confirmSpy.mockRestore();
  });

  it("revoke confirms before calling the API; cancel aborts", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          token: "z".repeat(43),
          username: "diana",
          displayName: "Diana",
          email: null,
          role: "user",
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    revokeInviteMock.mockResolvedValue(undefined);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<UsersPage />);
    await waitFor(() => {
      expect(screen.getByText("Diana")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    expect(confirmSpy).toHaveBeenCalled();
    // Confirm copy mentions the username + the consequence.
    expect(confirmSpy.mock.calls[0][0]).toMatch(/diana/i);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/won't be able/i);
    // User declined — API must NOT be called.
    expect(revokeInviteMock).not.toHaveBeenCalled();

    // Now confirm — API should fire.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => {
      expect(revokeInviteMock).toHaveBeenCalledWith("z".repeat(43));
    });
    confirmSpy.mockRestore();
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
    fireEvent.change(screen.getByPlaceholderText(/username/i), {
      target: { value: "charlie" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue(url)).toBeInTheDocument();
    });

    const qrImg = screen.getByRole("img", { name: /qr code.*charlie/i });
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

  it("rejects reserved usernames at form-submit time without calling createInvite", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /invite user/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /invite user/i }));

    fireEvent.change(screen.getByPlaceholderText(/username/i), {
      target: { value: "admin" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /generate (invite )?link|generate$/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/reserved/i)).toBeInTheDocument();
    });
    expect(createInviteMock).not.toHaveBeenCalled();
  });
});
