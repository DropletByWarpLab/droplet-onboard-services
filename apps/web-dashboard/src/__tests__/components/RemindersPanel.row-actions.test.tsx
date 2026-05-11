/**
 * WARP-292 — RemindersPanel per-row delete action.
 *
 * The trash icon used to live behind `opacity-0 group-hover:opacity-100`,
 * making it touch-invisible and keyboard-unreachable. WARP-220 set the
 * always-visible pattern on /users; this test enforces it here.
 *
 * Invariants:
 *   - Trash button is always rendered (no opacity-0 gate).
 *   - aria-label names the action + the reminder title.
 *   - p-2.5 hit-target.
 *   - Clicking it opens <ConfirmDialog>; the dialog body identifies
 *     the reminder by title so the user can verify what they're
 *     destroying (preserved from WARP-291 + sharpened in WARP-292).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const useRemindersMock = vi.fn();
const createReminderMock = vi.fn();
const patchReminderMock = vi.fn();
const deleteReminderMock = vi.fn();

vi.mock("@/lib/hooks/useReminders", () => ({
  useReminders: (...a: any[]) => useRemindersMock(...a),
  createReminder: (...a: any[]) => createReminderMock(...a),
  patchReminder: (...a: any[]) => patchReminderMock(...a),
  deleteReminder: (...a: any[]) => deleteReminderMock(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { RemindersPanel } from "@/components/calendar/RemindersPanel";

beforeEach(() => {
  useRemindersMock.mockReset();
  createReminderMock.mockReset();
  patchReminderMock.mockReset();
  deleteReminderMock.mockReset();
});

function makeReminder(overrides: any = {}) {
  return {
    id: "rem-1",
    userId: "alice",
    title: "Walk the dog",
    body: null,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    completedAt: null,
    calendarEventId: null,
    notifiedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("RemindersPanel — per-row delete (WARP-292)", () => {
  it("delete button is visible without hover and carries title in aria-label", () => {
    useRemindersMock.mockReturnValue({
      reminders: [makeReminder()],
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<RemindersPanel />);

    const btn = screen.getByRole("button", { name: /delete reminder walk the dog/i });
    expect(btn).toBeInTheDocument();
    expect(btn.className).not.toMatch(/opacity-0/);
    expect(btn.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("aria-label falls back to reminder id when title is empty", () => {
    useRemindersMock.mockReturnValue({
      reminders: [makeReminder({ id: "rem-xyz", title: "" })],
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<RemindersPanel />);

    expect(
      screen.getByRole("button", { name: /delete reminder rem-xyz/i }),
    ).toBeInTheDocument();
  });

  it("clicking delete opens ConfirmDialog with generic title and identifier in body", async () => {
    useRemindersMock.mockReturnValue({
      reminders: [makeReminder({ id: "rem-9", title: "Pay rent" })],
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<RemindersPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /delete reminder pay rent/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    // WARP-292 fold-in: the dialog heading is now the generic
    // "Delete reminder?" — the reminder identifier flows through the
    // ConfirmDialog `confirmedIdentifier` prop, which renders it in the
    // monospace-token style consistent with every other migrated
    // confirm in the dashboard. This dodges title-string escaping for
    // reminders whose titles contain quotes.
    const dialog = screen.getByRole("dialog");
    expect(
      screen.getByRole("heading", { name: /^delete reminder\?$/i }),
    ).toBeInTheDocument();
    // The reminder identifier still has to appear somewhere in the
    // dialog body so the user can verify what they're destroying.
    expect(dialog.textContent ?? "").toMatch(/pay rent/i);
    // And the identifier must render in the dedicated mono-token slot
    // rather than being interpolated into the title.
    const idToken = Array.from(dialog.querySelectorAll("p")).find((p) =>
      /pay rent/i.test(p.textContent ?? ""),
    );
    expect(idToken).toBeDefined();
    expect(idToken!.className).toMatch(/font-mono/);
  });

  it("falls back to reminder id in confirmedIdentifier when title is empty", async () => {
    useRemindersMock.mockReturnValue({
      reminders: [makeReminder({ id: "rem-empty", title: "" })],
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<RemindersPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /delete reminder rem-empty/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/rem-empty/i);
  });
});
