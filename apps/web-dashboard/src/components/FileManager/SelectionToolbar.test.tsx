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
    onShare: vi.fn(),
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

/**
 * WARP-1540 — Share is a first-class selection action. It was reachable only
 * from the single-file detail panel and a `disabled: !isSingle` context item,
 * so a selection of several files had no way to share at all.
 */
describe("SelectionToolbar — Share (WARP-1540)", () => {
  it("shows Share alongside Download whenever at least one item is selected", () => {
    const h = renderToolbar({ count: 1, hasClipboard: false });
    const shareBtn = screen.getByRole("button", { name: /^share$/i });
    expect(shareBtn).toBeInTheDocument();
    expect(shareBtn).not.toBeDisabled();
    fireEvent.click(shareBtn);
    expect(h.onShare).toHaveBeenCalledTimes(1);
  });

  it("hides Share when nothing is selected (clipboard-only toolbar)", () => {
    renderToolbar({ count: 0, hasClipboard: true });
    expect(screen.queryByRole("button", { name: /^share/i })).toBeNull();
  });

  // Review B3 — the sharing posture flips at the 1→2 boundary (one item opens
  // ShareDialog, which starts on a named household member; several mint a
  // public link per file with no intervening choice). The LABEL has to change
  // where the meaning changes, otherwise one extra checkbox silently turns a
  // private share into N public links.
  it("labels the single-item action Share — the dialog still lets the user choose", () => {
    renderToolbar({ count: 1 });
    const shareBtn = screen.getByRole("button", { name: /^share$/i });
    expect(shareBtn).toHaveAttribute("title", "Share link");
  });

  it("says PUBLIC in the label and the tooltip as soon as a second item is selected", () => {
    renderToolbar({ count: 3 });
    // Not merely "Share" — the button states the posture it is about to apply.
    expect(screen.queryByRole("button", { name: /^share$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^share publicly$/i })
    ).toHaveAttribute(
      "title",
      "Create 3 public links — one per file. Anyone with a link can open it."
    );
  });

  it("disables Share with the caller's reason and does not fire the handler", () => {
    const reason = "Only a manager can share from this library.";
    const h = renderToolbar({ canShare: false, shareDisabledReason: reason });
    const shareBtn = screen.getByRole("button", { name: /^share publicly$/i });
    // Visible-but-disabled — never silently absent.
    expect(shareBtn).toBeInTheDocument();
    expect(shareBtn).toBeDisabled();
    expect(shareBtn).toHaveAttribute("title", reason);
    fireEvent.click(shareBtn);
    expect(h.onShare).not.toHaveBeenCalled();
  });

  it("disables Share for a reader even when the caller forgot canShare", () => {
    const h = renderToolbar({ readOnly: true });
    const shareBtn = screen.getByRole("button", { name: /^share publicly$/i });
    expect(shareBtn).toBeDisabled();
    expect(shareBtn).toHaveAttribute("title", READER_TOOLTIP);
    fireEvent.click(shareBtn);
    expect(h.onShare).not.toHaveBeenCalled();
  });
});
