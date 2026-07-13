/**
 * WARP-1267 (T15) — reader posture on the selection toolbar. Inside a
 * `reader`-right space, Rename/Move/Cut/Paste/Trash render
 * visible-but-disabled with the shipped tooltip copy (design brief §2);
 * Copy and Download stay enabled. `readOnly` defaults false so every
 * existing caller (My Files / Household) is unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelectionToolbar } from "./SelectionToolbar";

const READER_TOOLTIP =
  "You can view and download here. Ask a manager for edit access.";

function renderToolbar(overrides: Partial<React.ComponentProps<typeof SelectionToolbar>> = {}) {
  const handlers = {
    onClear: vi.fn(),
    onRename: vi.fn(),
    onCut: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onMove: vi.fn(),
    onCopyTo: vi.fn(),
    onDelete: vi.fn(),
    onDownload: vi.fn(),
  };
  render(
    <SelectionToolbar
      count={2}
      canRename={false}
      hasClipboard={true}
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

describe("SelectionToolbar — reader posture (WARP-1267)", () => {
  it("keeps every write action enabled by default (readOnly defaults false)", () => {
    const h = renderToolbar();
    for (const label of [/^move$/i, /^cut$/i, /^paste$/i, /^trash$/i]) {
      expect(screen.getByRole("button", { name: label })).not.toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: /^trash$/i }));
    expect(h.onDelete).toHaveBeenCalled();
  });

  it("disables Rename/Move/Cut/Paste/Trash with the reader tooltip when readOnly", () => {
    const h = renderToolbar({ readOnly: true, canRename: true });
    for (const label of [/^rename$/i, /^move$/i, /^cut$/i, /^paste$/i, /^trash$/i]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", READER_TOOLTIP);
    }
    fireEvent.click(screen.getByRole("button", { name: /^trash$/i }));
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it("keeps Copy and Download enabled when readOnly", () => {
    const h = renderToolbar({ readOnly: true });
    const copyBtn = screen.getByRole("button", { name: /^copy$/i });
    const downloadBtn = screen.getByRole("button", { name: /^download$/i });
    expect(copyBtn).not.toBeDisabled();
    expect(downloadBtn).not.toBeDisabled();
    fireEvent.click(downloadBtn);
    expect(h.onDownload).toHaveBeenCalled();
  });
});
