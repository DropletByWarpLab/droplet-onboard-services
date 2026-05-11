/**
 * Tests for <TrashView>, specifically the WARP-291 migration of the
 * "Empty trash" inline-confirm to <ConfirmDialog>.
 *
 * Coverage:
 *   - Clicking "Empty trash" opens a <ConfirmDialog>, not an inline UI.
 *   - Clicking the dialog's confirm button calls `onEmpty`.
 *   - Clicking the dialog's cancel button does NOT call `onEmpty` and
 *     closes the dialog.
 *   - Empty state still hides the header button (no items = no button).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { TrashView } from "@/components/FileManager/TrashView";
import type { TrashItemInfo } from "@/lib/types";

// Stub framer-motion so <Dialog> animations don't gate assertions.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => true,
  };
});

function makeItem(overrides: Partial<TrashItemInfo> = {}): TrashItemInfo {
  return {
    name: "photo.jpg.d1712860391",
    originalName: "photo.jpg",
    originalLocation: "/Photos",
    size: 1024,
    deletedAt: "2026-04-01T12:00:00Z",
    isDirectory: false,
    ...overrides,
  };
}

describe("<TrashView> empty-trash migration to <ConfirmDialog>", () => {
  it("clicking 'Empty trash' opens a ConfirmDialog (not an inline confirm)", () => {
    render(
      <TrashView
        items={[makeItem()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={vi.fn()}
      />,
    );

    // The inline "Permanently delete all?" copy is gone post-migration.
    expect(screen.queryByText(/Permanently delete all\?/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /empty trash/i }));

    // Dialog title appears (count-aware when count is available).
    expect(
      screen.getByText(/permanently delete 1 item in trash\?/i),
    ).toBeInTheDocument();
    // Plain-English consequence copy.
    expect(
      screen.getByText(/every file in trash is gone for good/i),
    ).toBeInTheDocument();
  });

  it("clicking the dialog confirm button calls onEmpty", async () => {
    const onEmpty = vi.fn().mockResolvedValue(undefined);
    render(
      <TrashView
        items={[makeItem()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={onEmpty}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /empty trash/i }));

    // The confirm button inside the dialog also reads "Empty trash".
    // It's distinguished from the header trigger because, while the
    // dialog is open, two buttons with that name exist — the dialog
    // confirm is the destructive one (bg-system-red).
    const buttons = screen.getAllByRole("button", { name: /empty trash/i });
    // Header trigger uses `text-system-red` + `hover:bg-system-red/10`; the
    // ConfirmDialog confirm uses the solid `bg-system-red` background.
    // Match the solid-bg one without picking up the hover variant.
    const confirmBtn = buttons.find((b) =>
      /(^|\s)bg-system-red(\s|$)/.test(b.className),
    );
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      expect(onEmpty).toHaveBeenCalledTimes(1);
    });
  });

  it("clicking the dialog cancel button does NOT call onEmpty and closes the dialog", async () => {
    const onEmpty = vi.fn().mockResolvedValue(undefined);
    render(
      <TrashView
        items={[makeItem()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={onEmpty}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /empty trash/i }));
    expect(
      screen.getByText(/every file in trash is gone for good/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/every file in trash is gone for good/i)).toBeNull();
    });
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("renders empty state with no Empty-trash trigger when trash is empty", () => {
    render(
      <TrashView
        items={[]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={vi.fn()}
      />,
    );
    expect(screen.getByText(/trash is empty/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /empty trash/i })).toBeNull();
  });
});
