/**
 * FileRow — the selection circle is a real, clickable checkbox.
 *
 * Bug: the circle that fades in over the file/folder icon (and shows a ✓ when
 * selected) was a plain <div> with no handler of its own. Clicking it bubbled
 * to the row, and since WARP-309 a plain click on a folder NAVIGATES — so the
 * one affordance that looks like "tick me to select" dove into the folder
 * instead. Multi-select was only reachable via Cmd/Ctrl/Shift-click, which is
 * undiscoverable and unavailable on touch.
 *
 * The circle is now a role=checkbox control that toggles selection additively
 * (onToggleSelect), stops the click from reaching the row, and never opens.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FileRow } from "@/components/FileManager/FileRow";
import type { FileEntryInfo } from "@/lib/types";

vi.mock("@/components/FileManager/StarButton", () => ({
  StarButton: () => <button type="button">star</button>,
}));

function makeFile(name: string, isDir: boolean): FileEntryInfo {
  return {
    path: `/${name}`,
    name,
    isDirectory: isDir,
    size: 100,
    modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    mimeType: isDir ? null : "text/plain",
  } as unknown as FileEntryInfo;
}

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>;
  onToggleSelect: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
}

function makeHandlers(): Handlers {
  return { onSelect: vi.fn(), onToggleSelect: vi.fn(), onOpen: vi.fn() };
}

function rowProps(file: FileEntryInfo, h: Handlers, isSelected = false) {
  return {
    file,
    isSelected,
    isRenaming: false,
    onSelect: h.onSelect as never,
    onToggleSelect: h.onToggleSelect as never,
    onOpen: h.onOpen as never,
    onDownload: vi.fn() as never,
    onDelete: vi.fn() as never,
    onRename: vi.fn() as never,
    onCancelRename: vi.fn() as never,
    onContextMenu: vi.fn() as never,
  };
}

describe("FileRow — selection checkbox", () => {
  it("exposes a checkbox naming the entry", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);
    expect(
      screen.getByRole("checkbox", { name: /select docs/i })
    ).toBeInTheDocument();
  });

  it("clicking the checkbox on a FOLDER selects it and does NOT navigate", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /select docs/i }));

    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("clicking the checkbox on a FILE selects it without opening the sidebar path", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("notes.txt", false), h)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /select notes.txt/i }));

    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("reflects selected state via aria-checked", () => {
    const h = makeHandlers();
    const { rerender } = render(
      <FileRow {...rowProps(makeFile("docs", true), h, false)} />
    );
    expect(screen.getByRole("checkbox", { name: /select docs/i })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    rerender(<FileRow {...rowProps(makeFile("docs", true), h, true)} />);
    expect(screen.getByRole("checkbox", { name: /select docs/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("Space on the checkbox toggles selection and never reaches the row's open handler", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);

    const box = screen.getByRole("checkbox", { name: /select docs/i });
    fireEvent.keyDown(box, { key: " " });

    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("the checkbox stays reachable while renaming is off but is inert during rename", () => {
    const h = makeHandlers();
    render(
      <FileRow {...rowProps(makeFile("docs", true), h)} isRenaming />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /select docs/i }));
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });
});
