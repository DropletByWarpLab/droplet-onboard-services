/**
 * WARP-292 — Settings page user-row delete action.
 *
 * The settings page used to hide the per-user Trash button behind
 * `opacity-0 group-hover:opacity-100`, leaving touch + keyboard users
 * with no way to discover the action. WARP-220 set the pattern on
 * `/users`; this test enforces the same pattern on `/settings`.
 *
 * Invariants:
 *   - The delete button is always rendered (no opacity-0 gate).
 *   - The button carries an `aria-label` that names the action AND
 *     the row's primary identifier (displayName ?? id).
 *   - The button has a `p-2.5`-or-larger hit-target token.
 *   - Clicking it opens the existing `<ConfirmDialog>` whose title
 *     contains the stable user id (preserved from WARP-291).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const fetchUsersMock = vi.fn();
const listProviderKeysMock = vi.fn();
const deleteUserMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: (...a: any[]) => deleteUserMock(...a),
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

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: null,
    devices: [],
    health: null,
    isLoading: false,
    error: null,
  }),
}));

// ProviderKeyForm pulls in fetch wrappers and isn't the subject under test.
vi.mock("@/components/ProviderKeyForm", () => ({
  ProviderKeyForm: () => null,
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

// 2026-05-18: Settings page Appearance section now renders an
// <AccentRow> which calls useAccent(). The hook throws if no
// AccentProvider is mounted, so the test mocks the lib directly
// with a violet default (matches the live default).
vi.mock("@/lib/accent", () => ({
  useAccent: () => ({
    accentId: "violet",
    accent: {
      id: "violet",
      label: "Violet",
      accent: "#6d28d9",
      accentHover: "#5b21b6",
      accentSubtle: "rgba(109,40,217,0.10)",
      shadowHero: "0 30px 80px -40px rgba(109,40,217,0.35)",
    },
    setAccentId: vi.fn(),
    presets: [
      { id: "violet", label: "Violet", accent: "#6d28d9", accentHover: "#5b21b6", accentSubtle: "", shadowHero: "" },
      { id: "blue", label: "Blue", accent: "#2563eb", accentHover: "#1d4ed8", accentSubtle: "", shadowHero: "" },
    ],
  }),
}));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  listProviderKeysMock.mockReset();
  deleteUserMock.mockReset();
  listProviderKeysMock.mockResolvedValue([]);
});

describe("Settings page — user-row delete action (WARP-292)", () => {
  it("delete button is visible without hover and carries displayName in its aria-label", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [{ id: "alice", username: "alice", displayName: "Alice Anderson" }],
    });

    render(<SettingsPage />);

    const deleteBtn = await screen.findByRole("button", {
      name: /delete user alice anderson/i,
    });
    expect(deleteBtn).toBeInTheDocument();

    // No opacity-0 on the button or its closest ancestor — touch + keyboard
    // users must be able to discover the action without a hover transition.
    expect(deleteBtn.className).not.toMatch(/opacity-0/);
    const container = deleteBtn.closest("div");
    expect(container?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor: vitest+jsdom doesn't do layout, so assert the
    // p-2.5 padding token (≥ 32 px square around a 14 px Lucide glyph).
    expect(deleteBtn.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("aria-label falls back to user id when displayName is absent", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [{ id: "bob", username: "bob" }],
    });

    render(<SettingsPage />);

    expect(
      await screen.findByRole("button", { name: /delete user bob/i }),
    ).toBeInTheDocument();
  });

  it("clicking delete opens ConfirmDialog whose title contains the stable user id", async () => {
    fetchUsersMock.mockResolvedValue({
      users: [{ id: "alice", username: "alice", displayName: "Alice Anderson" }],
    });

    render(<SettingsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete user alice anderson/i }),
    );

    // ConfirmDialog renders on top of the shared <Dialog> primitive
    // (role="dialog", aria-modal="true") per WARP-291.
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    // The dialog title must include the user id ("alice"), not just the
    // displayName, so the admin sees the system identifier they're about
    // to destroy (preserved from WARP-291).
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/alice/);
  });
});
