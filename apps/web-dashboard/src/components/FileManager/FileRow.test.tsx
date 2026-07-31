/**
 * WARP-1267 (T15) — reader posture on the per-row Delete affordance. Inside
 * a `reader`-right department/team space, the caller can still browse and
 * download but never mutate — the row's Trash2 button renders
 * visible-but-disabled with the shipped reader-posture tooltip (design
 * brief §2), and the row's own "Delete" keyboard shortcut becomes a no-op.
 * Download stays fully enabled — readers can always view and download.
 * `canWrite` defaults to true so every existing caller (My Files /
 * Household, always writable) is unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileRow } from "./FileRow";
import type { FileEntryInfo } from "@/lib/types";

const READER_TOOLTIP =
  "You can view and download here. Ask a manager for edit access.";

const FILE: FileEntryInfo = {
  name: "report.pdf",
  path: "/report.pdf",
  isDirectory: false,
  size: 2048,
  mimeType: "application/pdf",
  modifiedAt: "2026-04-16T00:00:00.000Z",
};

function renderRow(overrides: Partial<React.ComponentProps<typeof FileRow>> = {}) {
  const onDelete = vi.fn();
  const onDownload = vi.fn();
  render(
    <FileRow
      file={FILE}
      isSelected={false}
      isRenaming={false}
      onSelect={() => {}}
      onToggleSelect={() => {}}
      onOpen={() => {}}
      onDownload={onDownload}
      onDelete={onDelete}
      onRename={() => {}}
      onCancelRename={() => {}}
      onContextMenu={() => {}}
      {...overrides}
    />
  );
  return { onDelete, onDownload };
}

describe("FileRow — reader posture (WARP-1267)", () => {
  it("keeps Delete enabled by default (canWrite defaults true)", () => {
    const { onDelete } = renderRow();
    const deleteBtn = screen.getByRole("button", { name: /delete report\.pdf/i });
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalled();
  });

  it("disables Delete with the reader tooltip when canWrite is false", () => {
    const { onDelete } = renderRow({ canWrite: false });
    const deleteBtn = screen.getByRole("button", { name: /delete report\.pdf/i });
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute("title", READER_TOOLTIP);
    fireEvent.click(deleteBtn);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps Download enabled even when canWrite is false", () => {
    const { onDownload } = renderRow({ canWrite: false });
    const downloadBtn = screen.getByRole("button", { name: /download report\.pdf/i });
    expect(downloadBtn).not.toBeDisabled();
    fireEvent.click(downloadBtn);
    expect(onDownload).toHaveBeenCalled();
  });

  it("ignores the Delete key when canWrite is false", () => {
    const { onDelete } = renderRow({ canWrite: false });
    fireEvent.keyDown(screen.getByRole("button", { name: /file report\.pdf/i }), {
      key: "Delete",
    });
    expect(onDelete).not.toHaveBeenCalled();
  });
});
