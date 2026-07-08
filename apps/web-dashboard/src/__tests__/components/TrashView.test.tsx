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
    // confirm is the destructive one (`btn danger`, WARP-1079).
    const buttons = screen.getAllByRole("button", { name: /empty trash/i });
    // Header trigger uses the red text/hover-tint idiom; the ConfirmDialog
    // confirm uses the shell's solid `btn danger` fill. Match the bare
    // `danger` token, which only the dialog confirm carries.
    const confirmBtn = buttons.find((b) =>
      /(^|\s)danger(\s|$)/.test(b.className),
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

describe("<TrashView> per-row Restore + Delete-forever actions (WARP-300)", () => {
  it("Restore + Delete-forever buttons name the file in their aria-label", () => {
    render(
      <TrashView
        items={[makeItem({ originalName: "photo.jpg" })]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /restore photo\.jpg/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete forever photo\.jpg/i }),
    ).toBeInTheDocument();
  });

  it("Restore + Delete-forever buttons are not hidden behind opacity-0 hover", () => {
    render(
      <TrashView
        items={[makeItem({ originalName: "photo.jpg" })]}
        isLoading={false}
        onRestore={vi.fn()}
        onDeleteForever={vi.fn()}
        onEmpty={vi.fn()}
      />,
    );

    const restore = screen.getByRole("button", {
      name: /restore photo\.jpg/i,
    });
    const del = screen.getByRole("button", {
      name: /delete forever photo\.jpg/i,
    });

    expect(restore.className).not.toMatch(/opacity-0/);
    expect(del.className).not.toMatch(/opacity-0/);
    expect(restore.closest("div")?.className ?? "").not.toMatch(/opacity-0/);
    expect(del.closest("div")?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor.
    expect(restore.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
    expect(del.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });
});
